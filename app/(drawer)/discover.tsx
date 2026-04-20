import { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, FlatList } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
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
  isBatchAvailable,
  type BatchContact,
} from '../../modules/contacts-batch/src';

interface UnknownNumber {
  number: string;
  normalizedKey: string;
  label: string | null;
  lastSeen: number;
  sources: { call: number; sms: number };
  sampleSms?: string;
}

export default function DiscoverScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [unknown, setUnknown] = useState<UnknownNumber[] | null>(null);
  const [stats, setStats] = useState<{ callLogs: number; sms: number; phoneContacts: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastAddedResult, setLastAddedResult] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (!isPhoneHistoryAvailable()) {
      Alert.alert('지원 안됨', 'phone-history 네이티브 모듈이 없습니다. 최신 dev client APK를 설치하세요.');
      return;
    }
    setLoading(true);
    setUnknown(null);
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
        const k = phoneKey(c.number);
        if (!k || knownKeys.has(k)) continue;
        const ex = map.get(k);
        if (ex) {
          ex.sources.call += 1;
          if (c.timestamp > ex.lastSeen) {
            ex.lastSeen = c.timestamp;
            if (c.name) ex.label = c.name;
          }
        } else {
          map.set(k, {
            number: c.number,
            normalizedKey: k,
            label: c.name || null,
            lastSeen: c.timestamp,
            sources: { call: 1, sms: 0 },
          });
        }
      }

      for (const s of sms) {
        const k = phoneKey(s.number);
        if (!k || knownKeys.has(k)) continue;
        const ex = map.get(k);
        if (ex) {
          ex.sources.sms += 1;
          if (s.timestamp > ex.lastSeen) {
            ex.lastSeen = s.timestamp;
            ex.sampleSms = s.body.slice(0, 60);
          }
          if (!ex.sampleSms && s.body) ex.sampleSms = s.body.slice(0, 60);
        } else {
          map.set(k, {
            number: s.number,
            normalizedKey: k,
            label: null,
            lastSeen: s.timestamp,
            sources: { call: 0, sms: 1 },
            sampleSms: s.body.slice(0, 60),
          });
        }
      }

      const list = [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      setStats({
        callLogs: callLogs.length,
        sms: sms.length,
        phoneContacts: phoneContactsResult.data?.length ?? 0,
      });
      setUnknown(list);
    } catch (e) {
      Alert.alert('스캔 실패', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const addAll = async () => {
    if (!user || !unknown || unknown.length === 0) return;
    Alert.alert(
      '연락처 추가',
      `${unknown.length}개 번호를 폰과 서버에 연락처로 추가합니다. 진행할까요?`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '추가',
          onPress: async () => {
            setBusy(true);
            setLastAddedResult(null);
            try {
              // 1. 폰에 배치 추가
              const BATCH = 50;
              let phoneAdded = 0;
              const phoneIds: string[] = [];
              if (isBatchAvailable()) {
                for (let i = 0; i < unknown.length; i += BATCH) {
                  const slice = unknown.slice(i, i + BATCH);
                  const payload: BatchContact[] = slice.map(u => ({
                    firstName: u.label ?? '',
                    lastName: '',
                    phoneNumbers: [{ label: 'mobile', number: u.number }],
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
                for (const u of unknown) {
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

              // 2. 서버에 bulk insert
              const serverRows = unknown.map((u, i) => ({
                user_id: user.id,
                first_name: u.label ?? '',
                last_name: '',
                phone: u.number,
                favorite: false,
                phone_contact_id: phoneIds[i] || null,
              }));
              let serverAdded = 0;
              const BULK = 500;
              for (let i = 0; i < serverRows.length; i += BULK) {
                const slice = serverRows.slice(i, i + BULK);
                const { error } = await supabase.from('contacts').insert(slice);
                if (error) console.warn('[discover server insert]', error.message);
                else serverAdded += slice.length;
              }

              setLastAddedResult(`완료: 폰 +${phoneAdded} / 서버 +${serverAdded}`);
              setUnknown([]);
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

  const renderRow = ({ item }: { item: UnknownNumber }) => {
    const d = new Date(item.lastSeen);
    return (
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowNumber}>{item.label ? `${item.label} (${item.number})` : item.number}</Text>
          <Text style={styles.rowMeta}>
            📞 {item.sources.call}회 · ✉ {item.sources.sms}건 · 최근 {d.toLocaleDateString('ko-KR')} {d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </Text>
          {item.sampleSms ? <Text style={styles.rowSms} numberOfLines={1}>{item.sampleSms}</Text> : null}
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
          최근 통화기록·문자 발·수신 번호 중 연락처에 저장 안 된 것만 찾아서 일괄 추가합니다.
        </Text>

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
          <Pressable style={[styles.addBtn, busy && styles.btnDisabled]} onPress={addAll} disabled={busy || loading}>
            {busy ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <FontAwesome name="user-plus" size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>{unknown.length}개 전부 연락처로 추가</Text>
              </>
            )}
          </Pressable>
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
  row: { padding: 14, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', backgroundColor: '#fff' },
  rowNumber: { fontSize: 14, color: '#111827', fontWeight: '500' },
  rowMeta: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  rowSms: { fontSize: 11, color: '#9ca3af', marginTop: 3, fontStyle: 'italic' },
  errorTitle: { fontSize: 15, color: '#111827', fontWeight: '600' },
  errorText: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
});
