import * as Contacts from 'expo-contacts';
import { supabase } from './supabase';
import type { Contact } from './types';

export type PhoneContact = Contacts.ExistingContact;

export interface SyncStats {
  phoneCount: number;
  appCount: number;
  matchedCount: number;
  phoneOnly: number;
  appOnly: number;
}

export interface SyncProgress {
  phase: 'idle' | 'phone-read' | 'app-to-phone' | 'phone-to-app' | 'done';
  done: number;
  total: number;
  message?: string;
}

export type ProgressHandler = (p: SyncProgress) => void;

const recentlyWrittenPhoneIds = new Set<string>();
const REALTIME_SKIP_TTL_MS = 10_000;

export function markPhoneIdSkippable(phoneContactId: string) {
  recentlyWrittenPhoneIds.add(phoneContactId);
  setTimeout(() => recentlyWrittenPhoneIds.delete(phoneContactId), REALTIME_SKIP_TTL_MS);
}

export function shouldSkipPhoneSync(phoneContactId: string): boolean {
  return recentlyWrittenPhoneIds.has(phoneContactId);
}

export function phoneKey(raw: string | undefined | null): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return digits;
  return digits.slice(-8);
}

export async function ensurePermission(): Promise<boolean> {
  const current = await Contacts.getPermissionsAsync();
  if (current.status === 'granted') return true;
  if (!current.canAskAgain) return false;
  const res = await Contacts.requestPermissionsAsync();
  return res.status === 'granted';
}

export async function readAllPhoneContacts(): Promise<PhoneContact[]> {
  const { data } = await Contacts.getContactsAsync({
    fields: [
      Contacts.Fields.FirstName,
      Contacts.Fields.LastName,
      Contacts.Fields.PhoneNumbers,
      Contacts.Fields.Emails,
      Contacts.Fields.Company,
      Contacts.Fields.JobTitle,
      Contacts.Fields.Addresses,
      Contacts.Fields.Note,
    ],
    pageSize: 50_000,
    pageOffset: 0,
  });
  return data ?? [];
}

async function readAllServerContacts(userId: string): Promise<Contact[]> {
  const all: Contact[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Contact[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export async function getSyncStats(userId: string): Promise<SyncStats> {
  const [phone, app] = await Promise.all([
    readAllPhoneContacts(),
    readAllServerContacts(userId),
  ]);
  const phoneKeys = new Map<string, string>();
  for (const p of phone) {
    const numbers = p.phoneNumbers ?? [];
    for (const pn of numbers) {
      const k = phoneKey(pn.number ?? '');
      if (k) phoneKeys.set(k, p.id ?? '');
    }
  }
  const appKeys = new Set<string>();
  let matched = 0;
  for (const c of app) {
    const keys = [phoneKey(c.phone), phoneKey(c.phone2)].filter(Boolean);
    for (const k of keys) appKeys.add(k);
    if (keys.some(k => phoneKeys.has(k))) matched++;
  }
  const phoneOnly = [...phoneKeys.keys()].filter(k => !appKeys.has(k)).length;
  const appOnly = app.length - matched;
  return {
    phoneCount: phone.length,
    appCount: app.length,
    matchedCount: matched,
    phoneOnly,
    appOnly,
  };
}

function contactToPhonePayload(c: Contact): Partial<Contacts.Contact> {
  const phoneNumbers: Contacts.PhoneNumber[] = [];
  if (c.phone) phoneNumbers.push({ label: 'mobile', number: c.phone, isPrimary: true });
  if (c.phone2) phoneNumbers.push({ label: 'work', number: c.phone2, isPrimary: false });

  const emails: Contacts.Email[] = [];
  if (c.email) emails.push({ label: 'home', email: c.email, isPrimary: true });
  if (c.email2) emails.push({ label: 'work', email: c.email2, isPrimary: false });

  const addresses: Contacts.Address[] = [];
  if (c.address) addresses.push({ label: 'home', street: c.address });

  return {
    contactType: Contacts.ContactTypes.Person,
    name: [c.last_name, c.first_name].filter(Boolean).join(' ') || '이름 없음',
    firstName: c.first_name || '',
    lastName: c.last_name || '',
    company: c.company || undefined,
    jobTitle: c.position || undefined,
    phoneNumbers: phoneNumbers.length ? phoneNumbers : undefined,
    emails: emails.length ? emails : undefined,
    addresses: addresses.length ? addresses : undefined,
    note: c.memo || undefined,
  };
}

function phoneToServerPayload(p: PhoneContact, userId: string): Partial<Contact> & { user_id: string; phone_contact_id: string } {
  const numbers = p.phoneNumbers ?? [];
  const emails = p.emails ?? [];
  const addresses = p.addresses ?? [];
  return {
    user_id: userId,
    phone_contact_id: p.id ?? '',
    first_name: p.firstName ?? '',
    last_name: p.lastName ?? '',
    phone: numbers[0]?.number ?? '',
    phone2: numbers[1]?.number ?? undefined,
    email: emails[0]?.email ?? undefined,
    email2: emails[1]?.email ?? undefined,
    company: p.company ?? undefined,
    position: p.jobTitle ?? undefined,
    address: addresses[0]?.street ?? undefined,
    memo: p.note ?? undefined,
    favorite: false,
  };
}

export async function syncAppToPhone(userId: string, onProgress?: ProgressHandler): Promise<{ added: number; updated: number; errors: number }> {
  const granted = await ensurePermission();
  if (!granted) throw new Error('연락처 접근 권한이 거부되었습니다.');

  onProgress?.({ phase: 'phone-read', done: 0, total: 0, message: '폰·서버 연락처 읽는 중...' });
  const [phoneContacts, serverContacts] = await Promise.all([
    readAllPhoneContacts(),
    readAllServerContacts(userId),
  ]);

  const phoneById = new Map<string, PhoneContact>();
  const phoneByKey = new Map<string, PhoneContact>();
  for (const p of phoneContacts) {
    if (p.id) phoneById.set(p.id, p);
    for (const n of p.phoneNumbers ?? []) {
      const k = phoneKey(n.number ?? '');
      if (k && !phoneByKey.has(k)) phoneByKey.set(k, p);
    }
  }

  const total = serverContacts.length;
  let done = 0;
  let added = 0;
  let updated = 0;
  let errors = 0;
  const linkUpdates: { id: string; phone_contact_id: string }[] = [];

  for (const c of serverContacts) {
    done++;
    try {
      let phone = c.phone_contact_id ? phoneById.get(c.phone_contact_id) : undefined;
      if (!phone) {
        const keys = [phoneKey(c.phone), phoneKey(c.phone2)].filter(Boolean);
        for (const k of keys) {
          const p = phoneByKey.get(k);
          if (p) { phone = p; break; }
        }
      }

      const payload = contactToPhonePayload(c);

      if (phone?.id) {
        await Contacts.updateContactAsync({ id: phone.id, ...payload } as { id: string } & Partial<Contacts.ExistingContact>);
        markPhoneIdSkippable(phone.id);
        if (!c.phone_contact_id) linkUpdates.push({ id: c.id, phone_contact_id: phone.id });
        updated++;
      } else {
        const newId = await Contacts.addContactAsync(payload as Contacts.Contact);
        markPhoneIdSkippable(newId);
        linkUpdates.push({ id: c.id, phone_contact_id: newId });
        added++;
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.warn('[app→phone]', c.id, (e as Error).message);
    }

    if (done % 25 === 0 || done === total) {
      onProgress?.({ phase: 'app-to-phone', done, total, message: `폰에 저장 중... ${done}/${total}` });
    }

    if (linkUpdates.length >= 500) {
      await flushLinkUpdates(linkUpdates);
      linkUpdates.length = 0;
    }
  }

  if (linkUpdates.length) await flushLinkUpdates(linkUpdates);

  onProgress?.({ phase: 'done', done: total, total, message: `완료: +${added} / 수정 ${updated} / 실패 ${errors}` });
  return { added, updated, errors };
}

async function flushLinkUpdates(updates: { id: string; phone_contact_id: string }[]) {
  for (const u of updates) {
    const { error } = await supabase.from('contacts').update({ phone_contact_id: u.phone_contact_id }).eq('id', u.id);
    if (error) console.warn('[link update]', error.message);
  }
}

export async function syncPhoneToApp(userId: string, onProgress?: ProgressHandler): Promise<{ inserted: number; updated: number; softDeleted: number; errors: number }> {
  const granted = await ensurePermission();
  if (!granted) throw new Error('연락처 접근 권한이 거부되었습니다.');

  onProgress?.({ phase: 'phone-read', done: 0, total: 0, message: '폰·서버 연락처 읽는 중...' });
  const [phoneContacts, serverContacts] = await Promise.all([
    readAllPhoneContacts(),
    readAllServerContacts(userId),
  ]);

  const serverByPhoneId = new Map<string, Contact>();
  const serverByKey = new Map<string, Contact>();
  for (const c of serverContacts) {
    if (c.phone_contact_id) serverByPhoneId.set(c.phone_contact_id, c);
    for (const k of [phoneKey(c.phone), phoneKey(c.phone2)]) {
      if (k && !serverByKey.has(k)) serverByKey.set(k, c);
    }
  }

  const total = phoneContacts.length;
  let done = 0;
  let inserted = 0;
  let updated = 0;
  let errors = 0;
  const toInsert: ReturnType<typeof phoneToServerPayload>[] = [];

  for (const p of phoneContacts) {
    done++;
    if (!p.id) continue;
    try {
      let existing = serverByPhoneId.get(p.id);
      if (!existing) {
        for (const n of p.phoneNumbers ?? []) {
          const k = phoneKey(n.number ?? '');
          if (k) {
            const byKey = serverByKey.get(k);
            if (byKey) { existing = byKey; break; }
          }
        }
      }
      const payload = phoneToServerPayload(p, userId);

      if (existing) {
        const updates: Record<string, unknown> = {};
        if (existing.phone_contact_id !== p.id) updates.phone_contact_id = p.id;
        const fields: (keyof Contact)[] = ['first_name', 'last_name', 'phone', 'phone2', 'email', 'email2', 'company', 'position', 'address', 'memo'];
        const payloadRec = payload as unknown as Record<string, unknown>;
        const existingRec = existing as unknown as Record<string, unknown>;
        let changed = !!updates.phone_contact_id;
        for (const f of fields) {
          const newVal = payloadRec[f] ?? null;
          const oldVal = existingRec[f] ?? null;
          if (newVal !== oldVal) {
            updates[f] = newVal;
            changed = true;
          }
        }
        if (changed) {
          const { error } = await supabase.from('contacts').update(updates).eq('id', existing.id);
          if (error) throw error;
          updated++;
        }
      } else {
        toInsert.push(payload);
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.warn('[phone→app]', p.id, (e as Error).message);
    }

    if (toInsert.length >= 500) {
      const { error } = await supabase.from('contacts').insert(toInsert);
      if (error) console.warn('[bulk insert]', error.message);
      else inserted += toInsert.length;
      toInsert.length = 0;
    }

    if (done % 50 === 0 || done === total) {
      onProgress?.({ phase: 'phone-to-app', done, total, message: `서버에 반영 중... ${done}/${total}` });
    }
  }

  if (toInsert.length) {
    const { error } = await supabase.from('contacts').insert(toInsert);
    if (error) console.warn('[bulk insert]', error.message);
    else inserted += toInsert.length;
  }

  const phoneIds = new Set<string>(phoneContacts.map(p => p.id ?? '').filter(Boolean));
  const toSoftDelete = serverContacts.filter(c => c.phone_contact_id && !phoneIds.has(c.phone_contact_id));
  let softDeleted = 0;
  for (const c of toSoftDelete) {
    const { error } = await supabase.from('contacts').update({ deleted_at: new Date().toISOString() }).eq('id', c.id);
    if (!error) softDeleted++;
  }

  onProgress?.({ phase: 'done', done: total, total, message: `완료: 신규 +${inserted} / 수정 ${updated} / 휴지통 ${softDeleted} / 실패 ${errors}` });
  return { inserted, updated, softDeleted, errors };
}

export async function applyServerChangeToPhone(contact: Contact, action: 'insert' | 'update' | 'delete'): Promise<void> {
  if (contact.phone_contact_id && shouldSkipPhoneSync(contact.phone_contact_id)) return;
  const granted = await ensurePermission();
  if (!granted) return;
  try {
    if (action === 'delete') {
      if (contact.phone_contact_id) {
        await Contacts.removeContactAsync(contact.phone_contact_id);
        markPhoneIdSkippable(contact.phone_contact_id);
      }
      return;
    }

    if (contact.phone_contact_id) {
      const payload = { id: contact.phone_contact_id, ...contactToPhonePayload(contact) } as { id: string } & Partial<Contacts.ExistingContact>;
      await Contacts.updateContactAsync(payload);
      markPhoneIdSkippable(contact.phone_contact_id);
      return;
    }

    const newId = await Contacts.addContactAsync(contactToPhonePayload(contact) as Contacts.Contact);
    markPhoneIdSkippable(newId);
    await supabase.from('contacts').update({ phone_contact_id: newId }).eq('id', contact.id);
  } catch (e) {
    console.warn('[realtime→phone]', (e as Error).message);
  }
}
