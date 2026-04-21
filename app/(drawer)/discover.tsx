import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, FlatList, Linking } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Contacts from 'expo-contacts';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { MAIN_USER_ID } from '@/lib/constants';
import { phoneKey, ensurePermission as ensureContactPermission } from '@/lib/phoneSync';
import {
  getCallLog,
  getSmsLog,
  getPhoneHistoryPermissions,
  isPhoneHistoryAvailable,
  requestPhoneHistoryPermissions,
  type CallLogEntry,
  type SmsEntry,
} from '../../modules/phone-history/src';
import {
  addContactsBatch,
  createPhoneGroup,
  getPhoneGroups,
  isBatchAvailable,
  type BatchContact,
} from '../../modules/contacts-batch/src';

const CLEANUP_GROUP_NAME = '정리필요';
const CLEANUP_GROUP_COLOR = '#f59e0b';
const DISCOVER_STATE_KEY = 'discover:state:v1';

function isMobileNumber(raw: string | undefined | null): boolean {
  if (!raw) return false;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('82')) digits = '0' + digits.slice(2);
  return digits.length === 11 && digits.startsWith('010');
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}일 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

interface DiscoverState {
  lastScanAt: number | null;
  seen: Record<string, number>;
  added: Record<string, number>;
}

interface UnknownNumber {
  number: string;
  normalizedKey: string;
  label: string | null;
  lastSeen: number;
  lastSource: 'call' | 'sms';
  sources: { call: number; sms: number };
  sampleSms?: string;
  firstSeenInScanAt?: number;
  previouslyAddedAt?: number;
}

export default function DiscoverScreen() {
  const { user, isMainAccount } = useAuth();
  const [loading, setLoading] = useState(false);
  const [unknown, setUnknown] = useState<UnknownNumber[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<{ callLogs: number; sms: number; phoneContacts: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastAddedResult, setLastAddedResult] = useState<string | null>(null);
  const [history, setHistory] = useState<DiscoverState>({ lastScanAt: null, seen: {}, added: {} });

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DISCOVER_STATE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<DiscoverState>;
          setHistory({
            lastScanAt: parsed.lastScanAt ?? null,
            seen: parsed.seen ?? {},
            added: parsed.added ?? {},
          });
        }
      } catch (e) {
        console.warn('[discover load state]', (e as Error).message);
      }
    })();
  }, []);

  const persistHistory = useCallback(async (next: DiscoverState) => {
    setHistory(next);
    try {
      await AsyncStorage.setItem(DISCOVER_STATE_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('[discover persist]', (e as Error).message);
    }
  }, []);

  const selectedCount = selected.size;
  const allSelected = useMemo(
    () => (unknown?.length ?? 0) > 0 && selectedCount === (unknown?.length ?? 0),
    [unknown, selectedCount],
  );

  const toggleOne = useCallback((key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => {
      if (!unknown) return prev;
      if (prev.size === unknown.length) return new Set();
      return new Set(unknown.map(u => u.normalizedKey));
    });
  }, [unknown]);

  const scan = useCallback(async () => {
    if (!isPhoneHistoryAvailable()) {
      Alert.alert('지원 안됨', 'phone-history 네이티브 모듈이 없습니다. 최신 dev client APK를 설치하세요.');
      return;
    }
    setLoading(true);
    setUnknown(null);
    setSelected(new Set());
    setStats(null);
    setLastAddedResult(null);
    try {
      const perms = await getPhoneHistoryPermissions();
      if (!perms.callLog || !perms.sms) {
        const req = await requestPhoneHistoryPermissions();
        if (!req.callLog && !req.sms) {
          Alert.alert('권한 필요', '통화기록/문자 권한이 필요합니다. 설정에서 허용해 주세요.');
          return;
        }
      }

      const contactsGranted = await ensureContactPermission();
      if (!contactsGranted) {
        Alert.alert('권한 필요', '연락처 권한이 필요합니다.');
        return;
      }

      const [phoneContactsResult, callLogs, sms] = await Promise.all([
        Contacts.getContactsAsync({
          fields: [Contacts.Fields.PhoneNumbers],
          pageSize: 50_000,
        }),
        getCallLog(2000),
        getSmsLog(2000),
      ]);

      const knownKeys = new Set<string>();
      for (const pc of phoneContactsResult.data ?? []) {
        for (const p of pc.phoneNumbers ?? []) {
          const k = phoneKey(p.number ?? '');
          if (k) knownKeys.add(k);
        }
      }

      // Unknown numbers aggregation
      const map = new Map<string, UnknownNumber>();

      for (const c of callLogs) {
        if (!isMobileNumber(c.number)) continue;
        const k = phoneKey(c.number);
        if (!k || knownKeys.has(k)) continue;
        const ex = map.get(k);
        if (ex) {
          ex.sources.call += 1;
          if (c.timestamp > ex.lastSeen) {
            ex.lastSeen = c.timestamp;
            ex.lastSource = 'call';
            if (c.name) ex.label = c.name;
          }
        } else {
          map.set(k, {
            number: c.number,
            normalizedKey: k,
            label: c.name || null,
            lastSeen: c.timestamp,
            lastSource: 'call',
            sources: { call: 1, sms: 0 },
          });
        }
      }

      for (const s of sms) {
        if (!isMobileNumber(s.number)) continue;
        const k = phoneKey(s.number);
        if (!k || knownKeys.has(k)) continue;
        const ex = map.get(k);
        if (ex) {
          ex.sources.sms += 1;
          if (s.timestamp > ex.lastSeen) {
            ex.lastSeen = s.timestamp;
            ex.lastSource = 'sms';
            ex.sampleSms = s.body.slice(0, 60);
          }
          if (!ex.sampleSms && s.body) ex.sampleSms = s.body.slice(0, 60);
        } else {
          map.set(k, {
            number: s.number,
            normalizedKey: k,
            label: null,
            lastSeen: s.timestamp,
            lastSource: 'sms',
            sources: { call: 0, sms: 1 },
            sampleSms: s.body.slice(0, 60),
          });
        }
      }

      const now = Date.now();
      const enriched = [...map.values()].map(u => ({
        ...u,
        firstSeenInScanAt: history.seen[u.normalizedKey],
        previouslyAddedAt: history.added[u.normalizedKey],
      }));
      enriched.sort((a, b) => b.lastSeen - a.lastSeen);
      setStats({
        callLogs: callLogs.length,
        sms: sms.length,
        phoneContacts: phoneContactsResult.data?.length ?? 0,
      });
      setUnknown(enriched);
      const defaultSelected = enriched.filter(u => !u.firstSeenInScanAt && !u.previouslyAddedAt);
      setSelected(new Set(defaultSelected.map(u => u.normalizedKey)));

      const nextSeen = { ...history.seen };
      for (const u of enriched) {
        if (!nextSeen[u.normalizedKey]) nextSeen[u.normalizedKey] = now;
      }
      await persistHistory({
        lastScanAt: now,
        seen: nextSeen,
        added: history.added,
      });
    } catch (e) {
      Alert.alert('스캔 실패', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [history, persistHistory]);

  const addSelected = async () => {
    if (!user || !unknown || unknown.length === 0) return;
    const targets = unknown.filter(u => selected.has(u.normalizedKey));
    if (targets.length === 0) {
      Alert.alert('선택 없음', '추가할 번호를 먼저 선택해 주세요.');
      return;
    }
    Alert.alert(
      '연락처 추가',
      `${targets.length}개 번호를 폰과 서버에 연락처로 추가합니다. 진행할까요?`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '추가',
          onPress: async () => {
            setBusy(true);
            setLastAddedResult(null);
            // 서브 계정이면 메인 계정의 연락처 공간에 insert (서버 통합 관리 정책)
            const targetServerUserId = isMainAccount ? user.id : MAIN_USER_ID;
            try {
              // 0. "정리필요" 그룹 ensure (서버 + 폰)
              let serverGroupId: string | null = null;
              let phoneGroupId: string | null = null;
              try {
                const { data: existing } = await supabase
                  .from('groups')
                  .select('id, phone_group_id')
                  .eq('user_id', targetServerUserId)
                  .eq('name', CLEANUP_GROUP_NAME)
                  .is('deleted_at', null)
                  .maybeSingle();
                if (existing) {
                  serverGroupId = existing.id as string;
                  phoneGroupId = (existing as { phone_group_id?: string | null }).phone_group_id ?? null;
                } else {
                  const { data: newGroup } = await supabase
                    .from('groups')
                    .insert({ user_id: targetServerUserId, name: CLEANUP_GROUP_NAME, color: CLEANUP_GROUP_COLOR })
                    .select('id')
                    .single();
                  if (newGroup) serverGroupId = newGroup.id as string;
                }

                if (serverGroupId && isBatchAvailable() && !phoneGroupId) {
                  const phoneGroups = await getPhoneGroups();
                  const match = phoneGroups.find(g => (g.title ?? '').trim() === CLEANUP_GROUP_NAME);
                  if (match) phoneGroupId = match.id;
                  else {
                    const newId = await createPhoneGroup(CLEANUP_GROUP_NAME);
                    if (newId && newId !== '-1') phoneGroupId = newId;
                  }
                  if (phoneGroupId) {
                    await supabase
                      .from('groups')
                      .update({ phone_group_id: phoneGroupId })
                      .eq('id', serverGroupId);
                  }
                }
              } catch (e) {
                console.warn('[discover group setup]', (e as Error).message);
              }

              // 1. 폰에 배치 추가 (그룹 포함)
              const BATCH = 50;
              let phoneAdded = 0;
              const phoneIds: string[] = [];
              if (isBatchAvailable()) {
                for (let i = 0; i < targets.length; i += BATCH) {
                  const slice = targets.slice(i, i + BATCH);
                  const payload: BatchContact[] = slice.map(u => ({
                    firstName: u.label ?? '',
                    lastName: '',
                    phoneNumbers: [{ label: 'mobile', number: u.number }],
                    groupIds: phoneGroupId ? [phoneGroupId] : undefined,
                  }));
                  try {
                    const ids = await addContactsBatch(payload);
                    for (let k = 0; k < slice.length; k++) {
                      const id = ids[k];
                      if (id && id !== '' && id !== '-1') {
                        phoneIds.push(id);
                        phoneAdded++;
                      } else {
                        phoneIds.push('');
                      }
                    }
                  } catch (e) {
                    console.warn('[discover addBatch]', (e as Error).message);
                    for (let k = 0; k < slice.length; k++) phoneIds.push('');
                  }
                }
              } else {
                for (const u of targets) {
                  try {
                    const id = await Contacts.addContactAsync({
                      contactType: Contacts.ContactTypes.Person,
                      name: u.label || u.number,
                      firstName: u.label ?? '',
                      phoneNumbers: [{ label: 'mobile', number: u.number }],
                    } as Contacts.Contact);
                    phoneIds.push(id);
                    phoneAdded++;
                  } catch (e) {
                    phoneIds.push('');
                  }
                }
              }

              // 2. 서버에 bulk insert (id 반환받음). 서브 계정이면 메인 user_id로 저장.
              const serverRows = targets.map((u, i) => ({
                user_id: targetServerUserId,
                first_name: u.label ?? '',
                last_name: '',
                phone: u.number,
                favorite: false,
                phone_contact_id: phoneIds[i] || null,
              }));
              let serverAdded = 0;
              const newContactIds: string[] = [];
              const BULK = 500;
              for (let i = 0; i < serverRows.length; i += BULK) {
                const slice = serverRows.slice(i, i + BULK);
                const { data, error } = await supabase.from('contacts').insert(slice).select('id');
                if (error) console.warn('[discover server insert]', error.message);
                else {
                  serverAdded += slice.length;
                  newContactIds.push(...((data ?? []).map(r => r.id as string)));
                }
              }

              // 3. contact_groups 링크 (서버)
              if (serverGroupId && newContactIds.length > 0) {
                const cgRows = newContactIds.map(id => ({ contact_id: id, group_id: serverGroupId! }));
                for (let i = 0; i < cgRows.length; i += BULK) {
                  const slice = cgRows.slice(i, i + BULK);
                  const { error } = await supabase.from('contact_groups').insert(slice);
                  if (error) console.warn('[discover cg insert]', error.message);
                }
              }

              setLastAddedResult(
                `완료: 폰 +${phoneAdded} / 서버 +${serverAdded} / 그룹 '${CLEANUP_GROUP_NAME}'에 ${newContactIds.length}개 추가`
              );
              const addedKeys = new Set(targets.map(t => t.normalizedKey));
              setUnknown(prev => (prev ?? []).filter(u => !addedKeys.has(u.normalizedKey)));
              setSelected(new Set());

              const nowTs = Date.now();
              const nextAdded = { ...history.added };
              for (const k of addedKeys) nextAdded[k] = nowTs;
              await persistHistory({ ...history, added: nextAdded });
            } catch (e) {
              Alert.alert('실패', (e as Error).message);
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const openSource = useCallback(async (item: UnknownNumber, kind: 'call' | 'sms') => {
    const tel = item.number.replace(/\s/g, '');
    const url = kind === 'sms' ? `sms:${tel}` : `tel:${tel}`;
    try {
      await Linking.openURL(url);
    } catch (e) {
      Alert.alert('열기 실패', (e as Error).message);
    }
  }, []);

  const renderRow = ({ item }: { item: UnknownNumber }) => {
    const d = new Date(item.lastSeen);
    const checked = selected.has(item.normalizedKey);
    const hasCall = item.sources.call > 0;
    const hasSms = item.sources.sms > 0;
    return (
      <View style={styles.row}>
        <Pressable onPress={() => toggleOne(item.normalizedKey)} hitSlop={8} style={{ paddingRight: 12 }}>
          <FontAwesome
            name={checked ? 'check-square' : 'square-o'}
            size={22}
            color={checked ? '#6366f1' : '#9ca3af'}
          />
        </Pressable>
        <Pressable
          style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.6 }]}
          onPress={() => openSource(item, item.lastSource)}
        >
          <View style={styles.rowHeader}>
            <FontAwesome
              name={item.lastSource === 'sms' ? 'comment' : 'phone'}
              size={13}
              color={item.lastSource === 'sms' ? '#10b981' : '#6366f1'}
              style={{ marginRight: 6 }}
            />
            <Text style={styles.rowNumber} numberOfLines={1}>
              {item.label ? `${item.label} (${item.number})` : item.number}
            </Text>
            {item.previouslyAddedAt ? (
              <View style={[styles.badge, styles.badgeAdded]}>
                <Text style={styles.badgeText}>이미 추가함 · {formatRelative(item.previouslyAddedAt)}</Text>
              </View>
            ) : item.firstSeenInScanAt ? (
              <View style={[styles.badge, styles.badgeSeen]}>
                <Text style={styles.badgeText}>이전 스캔 · {formatRelative(item.firstSeenInScanAt)}</Text>
              </View>
            ) : (
              <View style={[styles.badge, styles.badgeNew]}>
                <Text style={[styles.badgeText, { color: '#fff' }]}>NEW</Text>
              </View>
            )}
          </View>
          <Text style={styles.rowMeta}>
            {hasCall ? `📞 ${item.sources.call}회` : ''}
            {hasCall && hasSms ? ' · ' : ''}
            {hasSms ? `💬 ${item.sources.sms}건` : ''}
            {' · '}
            최근 {d.toLocaleDateString('ko-KR')} {d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </Text>
          {item.sampleSms ? <Text style={styles.rowSms} numberOfLines={1}>{item.sampleSms}</Text> : null}
        </Pressable>
        <View style={styles.rowActions}>
          {hasCall ? (
            <Pressable onPress={() => openSource(item, 'call')} hitSlop={6} style={styles.actionBtn}>
              <FontAwesome name="phone" size={16} color="#6366f1" />
            </Pressable>
          ) : null}
          {hasSms ? (
            <Pressable onPress={() => openSource(item, 'sms')} hitSlop={6} style={styles.actionBtn}>
              <FontAwesome name="comment" size={16} color="#10b981" />
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  };

  if (!isPhoneHistoryAvailable()) {
    return (
      <View style={styles.center}>
        <FontAwesome name="exclamation-circle" size={28} color="#f59e0b" />
        <Text style={styles.errorTitle}>통화/문자 모듈 없음</Text>
        <Text style={styles.errorText}>최신 dev client APK를 설치하고 다시 시도해 주세요.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#f9fafb' }}>
      <View style={{ padding: 16 }}>
        <Text style={styles.title}>통화/문자에서 연락처 찾기</Text>
        <Text style={styles.subtitle}>
          010으로 시작하는 휴대폰 번호 중 연락처에 저장 안 된 것만 찾습니다. 추가할 번호를 선택하세요.
        </Text>
        {history.lastScanAt ? (
          <Text style={styles.lastScan}>
            마지막 스캔: {formatRelative(history.lastScanAt)} · 누적 {Object.keys(history.seen).length}개 발견 · 추가 {Object.keys(history.added).length}개
          </Text>
        ) : null}

        {stats ? (
          <View style={styles.statsCard}>
            <Text style={styles.statsText}>
              통화 {stats.callLogs.toLocaleString()}건 · 문자 {stats.sms.toLocaleString()}건 · 폰 연락처 {stats.phoneContacts.toLocaleString()}개
            </Text>
            <Text style={[styles.statsText, { color: '#6366f1', fontWeight: '600' }]}>
              저장 안 된 번호 {(unknown?.length ?? 0).toLocaleString()}개 발견
            </Text>
          </View>
        ) : null}

        {lastAddedResult ? (
          <View style={styles.resultCard}>
            <FontAwesome name="check-circle" size={18} color="#10b981" />
            <Text style={styles.resultText}>{lastAddedResult}</Text>
          </View>
        ) : null}

        <Pressable style={[styles.primaryBtn, loading && styles.btnDisabled]} onPress={scan} disabled={loading || busy}>
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <FontAwesome name="search" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>스캔 시작</Text>
            </>
          )}
        </Pressable>

        {unknown && unknown.length > 0 ? (
          <>
            <View style={styles.selectBar}>
              <Text style={styles.selectText}>
                {selectedCount} / {unknown.length} 선택됨
              </Text>
              <Pressable onPress={toggleAll} hitSlop={8}>
                <Text style={styles.selectToggle}>{allSelected ? '전체해제' : '전체선택'}</Text>
              </Pressable>
            </View>
            <Pressable
              style={[styles.addBtn, (busy || selectedCount === 0) && styles.btnDisabled]}
              onPress={addSelected}
              disabled={busy || loading || selectedCount === 0}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <FontAwesome name="user-plus" size={16} color="#fff" />
                  <Text style={styles.primaryBtnText}>
                    {selectedCount > 0 ? `${selectedCount}개 연락처로 추가` : '추가할 번호 선택'}
                  </Text>
                </>
              )}
            </Pressable>
          </>
        ) : null}
      </View>

      {unknown ? (
        <FlatList
          data={unknown}
          keyExtractor={it => it.normalizedKey}
          renderItem={renderRow}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={{ color: '#9ca3af' }}>저장 안 된 번호가 없습니다</Text>
            </View>
          }
          contentContainerStyle={unknown.length === 0 ? { flex: 1, justifyContent: 'center' } : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40, gap: 10 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 6 },
  subtitle: { fontSize: 13, color: '#6b7280', marginBottom: 16, lineHeight: 18 },
  statsCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e5e7eb', gap: 6, marginBottom: 12 },
  statsText: { fontSize: 13, color: '#6b7280' },
  resultCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#ecfdf5', borderRadius: 12, padding: 14, marginBottom: 12 },
  resultText: { fontSize: 13, color: '#065f46', flex: 1 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#6366f1', borderRadius: 12, padding: 14 },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#10b981', borderRadius: 12, padding: 14, marginTop: 10 },
  btnDisabled: { opacity: 0.6 },
  lastScan: { fontSize: 11, color: '#9ca3af', marginBottom: 10, marginTop: -4 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', backgroundColor: '#fff' },
  rowHeader: { flexDirection: 'row', alignItems: 'center' },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 6 },
  badgeText: { fontSize: 10, fontWeight: '600', color: '#374151' },
  badgeNew: { backgroundColor: '#6366f1' },
  badgeSeen: { backgroundColor: '#fef3c7' },
  badgeAdded: { backgroundColor: '#d1fae5' },
  rowActions: { flexDirection: 'row', marginLeft: 8, gap: 4 },
  actionBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f3f4f6' },
  selectBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 4, marginTop: 12 },
  selectText: { fontSize: 13, color: '#6b7280' },
  selectToggle: { fontSize: 13, color: '#6366f1', fontWeight: '600' },
  rowNumber: { fontSize: 14, color: '#111827', fontWeight: '500', flexShrink: 1 },
  rowMeta: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  rowSms: { fontSize: 11, color: '#9ca3af', marginTop: 3, fontStyle: 'italic' },
  errorTitle: { fontSize: 15, color: '#111827', fontWeight: '600' },
  errorText: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
});
