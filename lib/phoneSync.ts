import * as Contacts from 'expo-contacts';
import { supabase } from './supabase';
import type { Contact, Group } from './types';
import {
  addContactsBatch,
  createPhoneGroup,
  getPhoneGroups,
  isBatchAvailable,
  type BatchContact,
} from '../modules/contacts-batch/src';

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

async function fetchContactsByUser(uid: string): Promise<Contact[]> {
  const prefix = uid.slice(0, 8);
  console.log(`[fetch ${prefix}] start`);
  const PAGE = 1000;
  const all: Contact[] = [];
  let lastId: string | null = null;
  let safety = 0;

  while (true) {
    const t0 = Date.now();
    let q = supabase
      .from('contacts')
      .select('*')
      .eq('user_id', uid)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (lastId) q = q.gt('id', lastId);

    type QueryResult = { data: Contact[] | null; error: { message: string } | null };
    const timeoutPromise = new Promise<QueryResult>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after 20s page=${safety}`)), 20_000)
    );
    const result = await Promise.race([q as unknown as Promise<QueryResult>, timeoutPromise]);

    const ms = Date.now() - t0;
    if (result.error) {
      console.warn(`[fetch ${prefix}] page ${safety} error (${ms}ms):`, result.error.message);
      throw new Error(result.error.message);
    }
    const rows = (result.data ?? []) as Contact[];
    console.log(`[fetch ${prefix}] page ${safety} ${rows.length} rows (${ms}ms)`);
    if (rows.length === 0) break;
    all.push(...rows);
    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;

    safety++;
    if (safety > 200) break;
  }
  console.log(`[fetch ${prefix}] done → ${all.length} rows`);
  return all;
}

async function readAllServerContacts(userId: string): Promise<Contact[]> {
  console.log(`[readAll] start, auth user=${userId.slice(0, 8)}`);
  const { data: shares, error: shErr } = await supabase
    .from('user_shares')
    .select('main_user_id')
    .eq('member_user_id', userId)
    .eq('scope', 'all')
    .is('revoked_at', null);
  if (shErr) console.warn('[readAll] shares error:', shErr.message);

  const shareIds = (shares ?? []).map(s => s.main_user_id as string);
  console.log(`[readAll] shares lookup → ${shareIds.length} mains`);
  const targetIds = [userId, ...shareIds];
  const results = await Promise.all(targetIds.map(uid => fetchContactsByUser(uid)));
  const total = results.reduce((a, b) => a + b.length, 0);
  console.log(`[readAll] done → ${total} total rows`);
  return results.flat();
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

async function fetchAllContactGroupMemberships(): Promise<{ contact_id: string; group_id: string }[]> {
  const PAGE = 1000;
  const all: { contact_id: string; group_id: string }[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('contact_groups')
      .select('contact_id, group_id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { contact_id: string; group_id: string }[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function ensurePhoneGroupsForServerGroups(
  userId: string,
  serverGroups: Group[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!isBatchAvailable() || serverGroups.length === 0) return map;

  const phoneGroups = await getPhoneGroups();
  const phoneByTitle = new Map<string, string>();
  for (const pg of phoneGroups) {
    if (pg.title) phoneByTitle.set(pg.title.trim(), pg.id);
  }

  for (const sg of serverGroups) {
    let phoneGid = (sg.phone_group_id ?? null) as string | null;
    if (!phoneGid || phoneGid === '-1') {
      const existing = phoneByTitle.get((sg.name ?? '').trim());
      if (existing) {
        phoneGid = existing;
      } else {
        try {
          phoneGid = await createPhoneGroup(sg.name || '그룹');
          if (phoneGid === '-1') phoneGid = null;
        } catch (e) {
          console.warn('[ensurePhoneGroup]', sg.name, (e as Error).message);
          phoneGid = null;
        }
      }
      if (phoneGid && sg.user_id === userId) {
        const { error } = await supabase
          .from('groups')
          .update({ phone_group_id: phoneGid })
          .eq('id', sg.id);
        if (error) console.warn('[link phoneGroup]', error.message);
      }
    }
    if (phoneGid) map.set(sg.id, phoneGid);
  }
  return map;
}

async function fetchAllVisibleGroups(userId: string): Promise<Group[]> {
  const { data: shares } = await supabase
    .from('user_shares')
    .select('main_user_id')
    .eq('member_user_id', userId)
    .eq('scope', 'all')
    .is('revoked_at', null);
  const targetIds = [userId, ...((shares ?? []).map(s => s.main_user_id as string))];
  const all: Group[] = [];
  for (const uid of targetIds) {
    const { data } = await supabase
      .from('groups')
      .select('*')
      .eq('user_id', uid)
      .is('deleted_at', null);
    all.push(...((data ?? []) as Group[]));
  }
  return all;
}

export async function cleanupEmptyGroups(userId: string): Promise<number> {
  const { data: myGroups } = await supabase
    .from('groups')
    .select('id')
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (!myGroups || myGroups.length === 0) return 0;

  const groupIds = myGroups.map(g => g.id as string);

  const { data: activeMemberships, error: memErr } = await supabase
    .from('contact_groups')
    .select('group_id, contacts!inner(id, deleted_at)')
    .in('group_id', groupIds)
    .is('contacts.deleted_at', null);
  if (memErr) {
    console.warn('[cleanupEmptyGroups] membership query error:', memErr.message);
    return 0;
  }

  const activeGroups = new Set<string>();
  for (const row of (activeMemberships ?? []) as { group_id: string }[]) {
    if (row.group_id) activeGroups.add(row.group_id);
  }

  const emptyGroupIds = groupIds.filter(id => !activeGroups.has(id));
  if (emptyGroupIds.length === 0) return 0;

  const { error: delErr } = await supabase
    .from('groups')
    .update({ deleted_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', emptyGroupIds);
  if (delErr) {
    console.warn('[cleanupEmptyGroups] delete error:', delErr.message);
    return 0;
  }
  console.log(`[cleanupEmptyGroups] soft-deleted ${emptyGroupIds.length} empty groups`);
  return emptyGroupIds.length;
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

  onProgress?.({ phase: 'phone-read', done: 0, total: 0, message: '폰 연락처 읽는 중...' });
  const phoneContacts = await readAllPhoneContacts();
  onProgress?.({ phase: 'phone-read', done: phoneContacts.length, total: 0, message: `서버 연락처 읽는 중... (폰 ${phoneContacts.length}건 완료)` });
  const serverContacts = await readAllServerContacts(userId);

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
        // 이미 동일 — 폰 쓰기 스킵. 본인 소유 row에만 phone_contact_id 링크.
        if (!c.phone_contact_id && c.user_id === userId) {
          linkUpdates.push({ id: c.id, phone_contact_id: phone.id });
        }
        skipped++;
        continue;
      }
      // 공유받은 메인 row는 updateContactAsync 타겟이 아니라 새 contact로 추가하는 게 맞음
      // (폰에 같은 번호가 있어도 이름/정보 다르면 별개로 두는 게 안전)
      if (c.user_id !== userId) {
        addTasks.push({ server: c, payload: contactToPhonePayload(c) });
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

  console.log(`[sync] matching done. adds=${addTasks.length} updates=${updateTasks.length} links=${linkUpdates.length} skipped=${skipped}`);
  onProgress?.({ phase: 'app-to-phone', done: 0, total: addTasks.length + updateTasks.length, message: `매칭 완료. 폰 쓰기 준비 (추가 ${addTasks.length}, 수정 ${updateTasks.length}, 스킵 ${skipped})` });

  // 링크만 필요한 건 먼저 bulk upsert (본인 소유만이라 fast)
  if (linkUpdates.length) {
    console.log(`[sync] flushing ${linkUpdates.length} link updates...`);
    await flushLinkUpdates(linkUpdates);
    console.log(`[sync] link updates done`);
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
    // 그룹 매핑 준비 (서버 group → 폰 group)
    let serverToPhoneGroup = new Map<string, string>();
    let contactToPhoneGroupIds = new Map<string, string[]>();
    try {
      const visibleGroups = await fetchAllVisibleGroups(userId);
      serverToPhoneGroup = await ensurePhoneGroupsForServerGroups(userId, visibleGroups);
      console.log(`[groups] server=${visibleGroups.length} mapped=${serverToPhoneGroup.size}`);

      if (serverToPhoneGroup.size > 0) {
        const memberships = await fetchAllContactGroupMemberships();
        for (const m of memberships) {
          const phoneGid = serverToPhoneGroup.get(m.group_id);
          if (!phoneGid) continue;
          const arr = contactToPhoneGroupIds.get(m.contact_id) ?? [];
          arr.push(phoneGid);
          contactToPhoneGroupIds.set(m.contact_id, arr);
        }
        console.log(`[groups] memberships loaded for ${contactToPhoneGroupIds.size} contacts`);
      }
    } catch (e) {
      console.warn('[groups mapping]', (e as Error).message);
    }

    // Android ContentProvider는 applyBatch 당 500 ops 제한.
    // contact 1개 = 최대 ~8 ops (RawContact + Name + Phone×2 + Email×2 + Org + Group)
    // 50 × 10 = 500 ops 마진 확보 (그룹 많을 수도)
    const BATCH = 50;
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
        groupIds: contactToPhoneGroupIds.get(t.server.id) ?? undefined,
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

  // 빈 그룹 정리
  try {
    const removed = await cleanupEmptyGroups(userId);
    if (removed > 0) console.log(`[syncAppToPhone] removed ${removed} empty groups`);
  } catch (e) {
    console.warn('[syncAppToPhone cleanup]', (e as Error).message);
  }

  onProgress?.({ phase: 'done', done: addTasks.length + updateTasks.length, total: addTasks.length + updateTasks.length + skipped, message: `완료: +${added} / 수정 ${updated} / 스킵 ${skipped} / 실패 ${errors}` });
  return { added, updated, skipped, errors };
}

async function flushLinkUpdates(updates: { id: string; phone_contact_id: string }[]) {
  if (!updates.length) return;
  const CONCURRENT = 30;
  for (let i = 0; i < updates.length; i += CONCURRENT) {
    const slice = updates.slice(i, i + CONCURRENT);
    await Promise.all(slice.map(async u => {
      const { error } = await supabase
        .from('contacts')
        .update({ phone_contact_id: u.phone_contact_id })
        .eq('id', u.id);
      if (error) console.warn('[link update]', error.message);
    }));
  }
}

export async function syncPhoneToApp(userId: string, onProgress?: ProgressHandler): Promise<{ inserted: number; updated: number; softDeleted: number; errors: number }> {
  const granted = await ensurePermission();
  if (!granted) throw new Error('연락처 접근 권한이 거부되었습니다.');

  onProgress?.({ phase: 'phone-read', done: 0, total: 0, message: '폰 연락처 읽는 중...' });
  const phoneContacts = await readAllPhoneContacts();
  onProgress?.({ phase: 'phone-read', done: phoneContacts.length, total: 0, message: `서버 연락처 읽는 중... (폰 ${phoneContacts.length}건 완료)` });
  const serverContacts = await readAllServerContacts(userId);

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

  // Bulk soft delete — 본인 소유만. 공유받은 메인 row는 RLS에서 어차피 차단되지만
  // 명시적으로 user_id 필터 걸어서 안전.
  const phoneIds = new Set<string>(phoneContacts.map(p => p.id ?? '').filter(Boolean));
  const toSoftDeleteIds = serverContacts
    .filter(c => c.user_id === userId && c.phone_contact_id && !phoneIds.has(c.phone_contact_id))
    .map(c => c.id);
  let softDeleted = 0;
  if (toSoftDeleteIds.length) {
    for (let i = 0; i < toSoftDeleteIds.length; i += 1000) {
      const slice = toSoftDeleteIds.slice(i, i + 1000);
      const { error } = await supabase
        .from('contacts')
        .update({ deleted_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('id', slice);
      if (!error) softDeleted += slice.length;
      else console.warn('[bulk soft-delete]', error.message);
    }
  }

  // 빈 그룹 정리
  try {
    const removed = await cleanupEmptyGroups(userId);
    if (removed > 0) console.log(`[syncPhoneToApp] removed ${removed} empty groups`);
  } catch (e) {
    console.warn('[syncPhoneToApp cleanup]', (e as Error).message);
  }

  onProgress?.({ phase: 'done', done: total, total, message: `완료: 신규 +${inserted} / 수정 ${updated} / 휴지통 ${softDeleted} / 실패 ${errors}` });
  return { inserted, updated, softDeleted, errors };
}

export async function runTwoWaySync(userId: string, onProgress?: ProgressHandler): Promise<{
  phoneToApp: { inserted: number; updated: number; softDeleted: number; errors: number };
  appToPhone: { added: number; updated: number; skipped: number; errors: number };
  emptyGroupsRemoved: number;
}> {
  const granted = await ensurePermission();
  if (!granted) throw new Error('연락처 접근 권한이 거부되었습니다.');

  const phoneToApp = await syncPhoneToApp(userId, onProgress);
  const appToPhone = await syncAppToPhone(userId, onProgress);
  const emptyGroupsRemoved = await cleanupEmptyGroups(userId);
  return { phoneToApp, appToPhone, emptyGroupsRemoved };
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
