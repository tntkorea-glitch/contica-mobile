import * as Contacts from 'expo-contacts';
import { supabase } from './supabase';
import type { Contact } from './types';
import { addContactsBatch, isBatchAvailable, type BatchContact } from '../modules/contacts-batch/src';

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
  const PAGE = 1000;
  const CONCURRENT = 10;
  const { count, error: countErr } = await supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (countErr) throw countErr;
  if (!count) return [];
  const pageCount = Math.ceil(count / PAGE);
  const all: Contact[] = [];
  for (let i = 0; i < pageCount; i += CONCURRENT) {
    const pages = Array.from(
      { length: Math.min(CONCURRENT, pageCount - i) },
      (_, j) => i + j
    );
    const results = await Promise.all(
      pages.map(p =>
        supabase
          .from('contacts')
          .select('*')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .range(p * PAGE, p * PAGE + PAGE - 1)
      )
    );
    for (const r of results) {
      if (r.error) throw r.error;
      all.push(...((r.data ?? []) as Contact[]));
    }
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

function contactToPhonePayload(c: Contact): Contacts.Contact {
  const displayName =
    [c.last_name, c.first_name].filter(Boolean).join(' ')
    || c.company
    || c.phone
    || '이름 없음';

  const payload: Record<string, unknown> = {
    contactType: Contacts.ContactTypes.Person,
    name: displayName,
  };
  if (c.first_name) payload.firstName = c.first_name;
  if (c.last_name) payload.lastName = c.last_name;
  if (c.company) payload.company = c.company;
  if (c.position) payload.jobTitle = c.position;

  const phoneNumbers: Contacts.PhoneNumber[] = [];
  if (c.phone) phoneNumbers.push({ label: 'mobile', number: c.phone });
  if (c.phone2) phoneNumbers.push({ label: 'work', number: c.phone2 });
  if (phoneNumbers.length) payload.phoneNumbers = phoneNumbers;

  const emails: Contacts.Email[] = [];
  if (c.email) emails.push({ label: 'home', email: c.email });
  if (c.email2) emails.push({ label: 'work', email: c.email2 });
  if (emails.length) payload.emails = emails;

  return payload as Contacts.Contact;
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

function phoneDataMatches(server: Contact, phone: PhoneContact): boolean {
  const normalize = (s: string | undefined | null) => (s ?? '').replace(/\D/g, '');
  const serverFirst = (server.first_name ?? '').trim();
  const serverLast = (server.last_name ?? '').trim();
  const phoneFirst = (phone.firstName ?? '').trim();
  const phoneLast = (phone.lastName ?? '').trim();
  const serverPhone = normalize(server.phone);
  const phoneFirstNumber = normalize(phone.phoneNumbers?.[0]?.number);
  return (
    serverFirst === phoneFirst &&
    serverLast === phoneLast &&
    serverPhone === phoneFirstNumber
  );
}

export async function syncAppToPhone(userId: string, onProgress?: ProgressHandler): Promise<{ added: number; updated: number; skipped: number; errors: number }> {
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

  type AddTask = { server: Contact; payload: Contacts.Contact };
  type UpdateTask = { server: Contact; phoneId: string; payload: { id: string } & Partial<Contacts.ExistingContact> };
  const addTasks: AddTask[] = [];
  const updateTasks: UpdateTask[] = [];
  const linkUpdates: { id: string; phone_contact_id: string }[] = [];
  let skipped = 0;

  for (const c of serverContacts) {
    let phone = c.phone_contact_id ? phoneById.get(c.phone_contact_id) : undefined;
    if (!phone) {
      const keys = [phoneKey(c.phone), phoneKey(c.phone2)].filter(Boolean);
      for (const k of keys) {
        const p = phoneByKey.get(k);
        if (p) { phone = p; break; }
      }
    }

    if (phone?.id) {
      if (phoneDataMatches(c, phone)) {
        // 이미 동일 — 폰 쓰기 스킵. 링크만 필요시 업데이트.
        if (!c.phone_contact_id) linkUpdates.push({ id: c.id, phone_contact_id: phone.id });
        skipped++;
        continue;
      }
      const payload = contactToPhonePayload(c);
      updateTasks.push({
        server: c,
        phoneId: phone.id,
        payload: { id: phone.id, ...payload } as { id: string } & Partial<Contacts.ExistingContact>,
      });
    } else {
      addTasks.push({ server: c, payload: contactToPhonePayload(c) });
    }
  }

  // 링크만 필요한 건 먼저 bulk upsert
  if (linkUpdates.length) {
    await flushLinkUpdates(linkUpdates);
    linkUpdates.length = 0;
  }

  const CONCURRENT = 30;
  let added = 0;
  let updated = 0;
  let errors = 0;
  let errorLogCount = 0;

  // 업데이트 병렬
  for (let i = 0; i < updateTasks.length; i += CONCURRENT) {
    const chunk = updateTasks.slice(i, i + CONCURRENT);
    const results = await Promise.all(chunk.map(async t => {
      try {
        await Contacts.updateContactAsync(t.payload);
        markPhoneIdSkippable(t.phoneId);
        return { ok: true as const, server: t.server };
      } catch (e) {
        return { ok: false as const, server: t.server, error: e as Error };
      }
    }));
    for (const r of results) {
      if (r.ok) {
        if (!r.server.phone_contact_id) {
          const phone = phoneById.get(r.server.phone_contact_id ?? '') ?? undefined;
          if (phone?.id) linkUpdates.push({ id: r.server.id, phone_contact_id: phone.id });
        }
        updated++;
      } else {
        errors++;
        if (errorLogCount++ < 3) console.warn('[app→phone update]', r.server.id, r.error.message);
      }
    }
    onProgress?.({
      phase: 'app-to-phone',
      done: Math.min(updateTasks.length, i + CONCURRENT),
      total: updateTasks.length + addTasks.length,
      message: `폰 수정 중... ${Math.min(updateTasks.length, i + CONCURRENT)}/${updateTasks.length}`,
    });
  }

  // 추가: 네이티브 배치 모듈이 있으면 배치, 없으면 병렬 개별 호출
  if (isBatchAvailable() && addTasks.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < addTasks.length; i += BATCH) {
      const slice = addTasks.slice(i, i + BATCH);
      const batchPayload: BatchContact[] = slice.map(t => ({
        firstName: t.server.first_name ?? '',
        lastName: t.server.last_name ?? '',
        phoneNumbers: [
          t.server.phone ? { label: 'mobile', number: t.server.phone } : null,
          t.server.phone2 ? { label: 'work', number: t.server.phone2 } : null,
        ].filter(Boolean) as BatchContact['phoneNumbers'],
        emails: [
          t.server.email ? { label: 'home', email: t.server.email } : null,
          t.server.email2 ? { label: 'work', email: t.server.email2 } : null,
        ].filter(Boolean) as BatchContact['emails'],
        company: t.server.company ?? undefined,
        jobTitle: t.server.position ?? undefined,
      }));
      try {
        const ids = await addContactsBatch(batchPayload);
        for (let k = 0; k < slice.length; k++) {
          const newId = ids[k];
          const server = slice[k].server;
          if (newId && newId !== '') {
            markPhoneIdSkippable(newId);
            linkUpdates.push({ id: server.id, phone_contact_id: newId });
            added++;
          } else {
            errors++;
            if (errorLogCount++ < 3) console.warn('[app→phone batch]', server.id, 'empty id');
          }
        }
      } catch (e) {
        errors += slice.length;
        if (errorLogCount++ < 3) console.warn('[app→phone batch chunk]', (e as Error).message);
      }
      if (linkUpdates.length >= 500) {
        await flushLinkUpdates(linkUpdates);
        linkUpdates.length = 0;
      }
      onProgress?.({
        phase: 'app-to-phone',
        done: updateTasks.length + Math.min(addTasks.length, i + BATCH),
        total: updateTasks.length + addTasks.length,
        message: `배치 추가 중... ${Math.min(addTasks.length, i + BATCH)}/${addTasks.length}`,
      });
    }
  } else {
    for (let i = 0; i < addTasks.length; i += CONCURRENT) {
      const chunk = addTasks.slice(i, i + CONCURRENT);
      const results = await Promise.all(chunk.map(async t => {
        try {
          const newId = await Contacts.addContactAsync(t.payload);
          markPhoneIdSkippable(newId);
          return { ok: true as const, server: t.server, newId };
        } catch (e) {
          return { ok: false as const, server: t.server, error: e as Error };
        }
      }));
      for (const r of results) {
        if (r.ok) {
          linkUpdates.push({ id: r.server.id, phone_contact_id: r.newId });
          added++;
          if (linkUpdates.length >= 500) {
            await flushLinkUpdates(linkUpdates);
            linkUpdates.length = 0;
          }
        } else {
          errors++;
          if (errorLogCount++ < 3) console.warn('[app→phone add]', r.server.id, r.error.message, JSON.stringify(r.server).slice(0, 200));
        }
      }
      onProgress?.({
        phase: 'app-to-phone',
        done: updateTasks.length + Math.min(addTasks.length, i + CONCURRENT),
        total: updateTasks.length + addTasks.length,
        message: `폰에 추가 중... ${Math.min(addTasks.length, i + CONCURRENT)}/${addTasks.length}`,
      });
    }
  }

  if (linkUpdates.length) await flushLinkUpdates(linkUpdates);

  onProgress?.({ phase: 'done', done: addTasks.length + updateTasks.length, total: addTasks.length + updateTasks.length + skipped, message: `완료: +${added} / 수정 ${updated} / 스킵 ${skipped} / 실패 ${errors}` });
  return { added, updated, skipped, errors };
}

async function flushLinkUpdates(updates: { id: string; phone_contact_id: string }[]) {
  if (!updates.length) return;
  const BULK = 500;
  for (let i = 0; i < updates.length; i += BULK) {
    const slice = updates.slice(i, i + BULK);
    const { error } = await supabase.from('contacts').upsert(slice, { onConflict: 'id' });
    if (error) console.warn('[link bulk-upsert]', error.message);
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
  const toInsert: ReturnType<typeof phoneToServerPayload>[] = [];
  const toUpsert: Array<Record<string, unknown>> = [];
  let errors = 0;
  let diffed = 0;
  const fields: (keyof Contact)[] = ['first_name', 'last_name', 'phone', 'phone2', 'email', 'email2', 'company', 'position', 'address', 'memo'];

  for (const p of phoneContacts) {
    diffed++;
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
        const updates: Record<string, unknown> = { id: existing.id };
        let changed = false;
        if (existing.phone_contact_id !== p.id) { updates.phone_contact_id = p.id; changed = true; }
        const payloadRec = payload as unknown as Record<string, unknown>;
        const existingRec = existing as unknown as Record<string, unknown>;
        for (const f of fields) {
          const newVal = payloadRec[f] ?? null;
          const oldVal = existingRec[f] ?? null;
          if (newVal !== oldVal) {
            updates[f] = newVal;
            changed = true;
          }
        }
        if (changed) toUpsert.push(updates);
      } else {
        toInsert.push(payload);
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.warn('[phone→app diff]', p.id, (e as Error).message);
    }

    if (diffed % 500 === 0 || diffed === total) {
      onProgress?.({ phase: 'phone-to-app', done: diffed, total, message: `비교 중... ${diffed}/${total}` });
    }
  }

  // Bulk insert in chunks of 500 (parallel up to 5)
  let inserted = 0;
  const BULK = 500;
  const INSERT_CONC = 5;
  for (let i = 0; i < toInsert.length; i += BULK * INSERT_CONC) {
    const chunkRuns = [];
    for (let j = 0; j < INSERT_CONC && i + j * BULK < toInsert.length; j++) {
      const slice = toInsert.slice(i + j * BULK, i + j * BULK + BULK);
      if (slice.length) {
        chunkRuns.push(
          supabase.from('contacts').insert(slice).then(r => {
            if (r.error) console.warn('[bulk insert]', r.error.message);
            else inserted += slice.length;
          })
        );
      }
    }
    await Promise.all(chunkRuns);
    onProgress?.({ phase: 'phone-to-app', done: Math.min(toInsert.length, i + BULK * INSERT_CONC), total: toInsert.length, message: `신규 반영... ${Math.min(toInsert.length, i + BULK * INSERT_CONC)}/${toInsert.length}` });
  }

  // Bulk UPSERT (by id) in chunks of 500 — replaces individual updates
  let updated = 0;
  for (let i = 0; i < toUpsert.length; i += BULK * INSERT_CONC) {
    const chunkRuns = [];
    for (let j = 0; j < INSERT_CONC && i + j * BULK < toUpsert.length; j++) {
      const slice = toUpsert.slice(i + j * BULK, i + j * BULK + BULK);
      if (slice.length) {
        chunkRuns.push(
          supabase.from('contacts').upsert(slice, { onConflict: 'id' }).then(r => {
            if (r.error) console.warn('[bulk upsert]', r.error.message);
            else updated += slice.length;
          })
        );
      }
    }
    await Promise.all(chunkRuns);
    onProgress?.({ phase: 'phone-to-app', done: Math.min(toUpsert.length, i + BULK * INSERT_CONC), total: toUpsert.length, message: `수정 반영... ${Math.min(toUpsert.length, i + BULK * INSERT_CONC)}/${toUpsert.length}` });
  }

  // Bulk soft delete — one request with IN clause
  const phoneIds = new Set<string>(phoneContacts.map(p => p.id ?? '').filter(Boolean));
  const toSoftDeleteIds = serverContacts.filter(c => c.phone_contact_id && !phoneIds.has(c.phone_contact_id)).map(c => c.id);
  let softDeleted = 0;
  if (toSoftDeleteIds.length) {
    for (let i = 0; i < toSoftDeleteIds.length; i += 1000) {
      const slice = toSoftDeleteIds.slice(i, i + 1000);
      const { error } = await supabase
        .from('contacts')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', slice);
      if (!error) softDeleted += slice.length;
      else console.warn('[bulk soft-delete]', error.message);
    }
  }

  onProgress?.({ phase: 'done', done: total, total, message: `완료: 신규 +${inserted} / 수정 ${updated} / 휴지통 ${softDeleted} / 실패 ${errors}` });
  return { inserted, updated, softDeleted, errors };
}

export async function runTwoWaySync(userId: string, onProgress?: ProgressHandler): Promise<{
  phoneToApp: { inserted: number; updated: number; softDeleted: number; errors: number };
  appToPhone: { added: number; updated: number; skipped: number; errors: number };
}> {
  const granted = await ensurePermission();
  if (!granted) throw new Error('연락처 접근 권한이 거부되었습니다.');

  const phoneToApp = await syncPhoneToApp(userId, onProgress);
  const appToPhone = await syncAppToPhone(userId, onProgress);
  return { phoneToApp, appToPhone };
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
