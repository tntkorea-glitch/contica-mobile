import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { WEB_API_BASE } from '@/lib/types';

interface MemberRow {
  id: string;
  main_user_id: string;
  member_user_id: string;
  scope: 'all' | 'groups';
  created_at: string;
  revoked_at: string | null;
  member_label: string | null;
  main_label: string | null;
  groups: { id: string; name: string; color: string }[];
}

export default function SharesScreen() {
  const { session } = useAuth();
  const [linkedMains, setLinkedMains] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [mainLabel, setMainLabel] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const token = session?.access_token;

  const authFetch = useCallback(async (path: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string> || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(WEB_API_BASE + path, { ...opts, headers });
  }, [token]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/v1/shares/members?as=member');
      const json = await res.json();
      if (json?.data) setLinkedMains(json.data as MemberRow[]);
      else setLinkedMains([]);
    } catch (e) {
      console.warn('[shares list]', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    if (token) reload();
  }, [token, reload]);

  const redeem = async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) {
      setMsg({ kind: 'err', text: '코드를 입력하세요' });
      return;
    }
    setRedeeming(true);
    setMsg(null);
    try {
      const res = await authFetch('/api/v1/shares/redeem', {
        method: 'POST',
        body: JSON.stringify({
          code: trimmed,
          ...(mainLabel.trim() ? { main_label: mainLabel.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || json?.error) {
        setMsg({ kind: 'err', text: json?.error?.message ?? '연결 실패' });
        return;
      }
      setMsg({ kind: 'ok', text: '연결 성공! 연락처 화면을 새로고침하면 공유된 연락처가 표시됩니다.' });
      setCode('');
      setMainLabel('');
      await reload();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setRedeeming(false);
    }
  };

  const confirmUnlink = (m: MemberRow) => {
    const label = m.main_label || '메인 계정';
    Alert.alert(
      '연결 해제',
      `${label}과의 공유 연결을 해제합니다. 해당 연락처가 더 이상 보이지 않게 됩니다. 진행할까요?`,
      [
        { text: '취소', style: 'cancel' },
        { text: '해제', style: 'destructive', onPress: () => unlink(m) },
      ]
    );
  };

  const unlink = async (m: MemberRow) => {
    try {
      const res = await authFetch(`/api/v1/shares/members?share_id=${m.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json?.error) {
        Alert.alert('실패', json?.error?.message ?? '해제 실패');
        return;
      }
      await reload();
    } catch (e) {
      Alert.alert('실패', (e as Error).message);
    }
  };

  if (!token) {
    return (
      <View style={styles.center}>
        <Text style={{ color: '#6b7280' }}>로그인이 필요합니다</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.title}>계정 공유</Text>
      <Text style={styles.subtitle}>
        메인 계정에서 발급한 초대 코드를 입력하면 해당 계정의 연락처를 이 기기에서 볼 수 있습니다.
      </Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>초대 코드 입력</Text>
        <TextInput
          style={styles.codeInput}
          placeholder="예: ABC234"
          placeholderTextColor="#9ca3af"
          value={code}
          onChangeText={t => setCode(t.toUpperCase())}
          autoCapitalize="characters"
          maxLength={12}
        />
        <TextInput
          style={styles.labelInput}
          placeholder="메인 계정 별명 (선택) — 예: 우리 회사"
          placeholderTextColor="#9ca3af"
          value={mainLabel}
          onChangeText={setMainLabel}
          maxLength={50}
        />
        <Pressable style={[styles.primaryBtn, redeeming && styles.btnDisabled]} onPress={redeem} disabled={redeeming}>
          {redeeming ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <FontAwesome name="link" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>연결하기</Text>
            </>
          )}
        </Pressable>
        {msg ? (
          <Text style={[styles.msg, msg.kind === 'ok' ? styles.msgOk : styles.msgErr]}>{msg.text}</Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <View style={styles.listHeader}>
          <Text style={styles.sectionTitle}>연결된 메인 계정</Text>
          <Pressable onPress={reload} disabled={loading}>
            {loading ? <ActivityIndicator size="small" color="#6366f1" /> : <FontAwesome name="refresh" size={14} color="#6366f1" />}
          </Pressable>
        </View>
        {loading && linkedMains.length === 0 ? (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <ActivityIndicator color="#6366f1" />
          </View>
        ) : linkedMains.length === 0 ? (
          <Text style={styles.emptyText}>연결된 계정이 없습니다</Text>
        ) : (
          linkedMains.map(m => (
            <View key={m.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{m.main_label || '메인 계정'}</Text>
                <Text style={styles.rowSub}>
                  범위: {m.scope === 'all' ? '전체 연락처' : `그룹 ${m.groups.length}개`}
                  {m.scope === 'groups' && m.groups.length > 0 ? ` (${m.groups.map(g => g.name).join(', ')})` : ''}
                </Text>
                <Text style={styles.rowMeta}>연결일: {new Date(m.created_at).toLocaleDateString('ko-KR')}</Text>
              </View>
              <Pressable onPress={() => confirmUnlink(m)} style={styles.unlinkBtn}>
                <FontAwesome name="times" size={14} color="#ef4444" />
              </Pressable>
            </View>
          ))
        )}
      </View>

      <Text style={styles.note}>
        💡 코드 발급은 메인 계정이 웹(contica.vercel.app)의 공유 페이지에서 진행합니다.{'\n'}
        코드는 6자리이며 10분 후 만료됩니다.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 6 },
  subtitle: { fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 18 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#e5e7eb' },
  sectionTitle: { fontSize: 14, color: '#111827', fontWeight: '600', marginBottom: 10 },
  codeInput: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10, padding: 12, fontSize: 18, fontWeight: '600', letterSpacing: 3, textAlign: 'center', marginBottom: 10 },
  labelInput: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 12 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#6366f1', borderRadius: 10, padding: 12 },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  btnDisabled: { opacity: 0.6 },
  msg: { marginTop: 10, fontSize: 12, textAlign: 'center' },
  msgOk: { color: '#065f46' },
  msgErr: { color: '#991b1b' },
  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  emptyText: { fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  rowTitle: { fontSize: 14, color: '#111827', fontWeight: '600' },
  rowSub: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  rowMeta: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  unlinkBtn: { padding: 8, borderRadius: 16, backgroundColor: '#fef2f2' },
  note: { fontSize: 12, color: '#6b7280', lineHeight: 18, padding: 12, backgroundColor: '#fff', borderRadius: 10 },
});
