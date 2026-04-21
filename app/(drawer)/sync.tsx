import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import {
  ensurePermission,
  getSyncStats,
  runTwoWaySync,
  syncAppToPhone,
  type SyncStats,
  type SyncProgress,
} from '@/lib/phoneSync';

export default function SyncScreen() {
  const { user, isMainAccount } = useAuth();
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const refreshStats = async () => {
    if (!user) return;
    const granted = await ensurePermission();
    setPermission(granted ? 'granted' : 'denied');
    if (!granted) {
      setStats(null);
      return;
    }
    setStatsLoading(true);
    try {
      const s = await getSyncStats(user.id);
      setStats(s);
    } catch (e) {
      Alert.alert('통계 조회 실패', (e as Error).message);
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const runTwoWay = () => {
    if (!user || !stats) return;
    Alert.alert(
      '양방향 동기화',
      `폰 ${stats.phoneCount.toLocaleString()}건 + 앱 ${stats.appCount.toLocaleString()}건을 양방향 동기화합니다.\n\n① 폰 → 앱 (매칭 링크 + 신규 서버 반영)\n② 앱 → 폰 (미전송 연락처를 폰에 저장)\n\n첫 실행은 되돌리기 어렵습니다. 진행할까요?`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '시작',
          style: 'destructive',
          onPress: async () => {
            setLastResult(null);
            setProgress({ phase: 'phone-read', done: 0, total: 0, message: '준비 중...' });
            try {
              const r = await runTwoWaySync(user.id, setProgress);
              setLastResult(
                `양방향 완료\n`
                + `폰→앱: 신규 +${r.phoneToApp.inserted} / 수정 ${r.phoneToApp.updated} / 휴지통 ${r.phoneToApp.softDeleted} / 실패 ${r.phoneToApp.errors}\n`
                + `앱→폰: 신규 +${r.appToPhone.added} / 수정 ${r.appToPhone.updated} / 스킵 ${r.appToPhone.skipped} / 실패 ${r.appToPhone.errors}`
              );
              await refreshStats();
            } catch (e) {
              Alert.alert('실패', (e as Error).message);
            } finally {
              setProgress(null);
            }
          },
        },
      ]
    );
  };

  const busy = progress !== null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.title}>폰 연락처 동기화</Text>
      <Text style={styles.subtitle}>
        앱과 폰 기본 연락처를 양방향 동기화합니다. 첫 실행은 되돌리기 어려우니 내용을 확인하고 진행하세요.
      </Text>

      {permission === 'denied' ? (
        <View style={styles.cardError}>
          <FontAwesome name="exclamation-triangle" size={18} color="#ef4444" />
          <Text style={styles.errorText}>
            연락처 권한이 거부되었습니다. 설정 앱에서 Contica의 연락처 권한을 허용해 주세요.
          </Text>
          <Pressable style={styles.secondaryBtn} onPress={refreshStats}>
            <Text style={styles.secondaryBtnText}>권한 재확인</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.statsCard}>
            <View style={styles.statsHeader}>
              <Text style={styles.statsTitle}>현재 상태</Text>
              <Pressable onPress={refreshStats} disabled={busy || statsLoading} style={styles.refreshBtn}>
                {statsLoading ? (
                  <ActivityIndicator size="small" color="#6366f1" />
                ) : (
                  <FontAwesome name="refresh" size={14} color="#6366f1" />
                )}
              </Pressable>
            </View>
            {stats ? (
              <View style={styles.statsGrid}>
                <StatItem label="폰" value={stats.phoneCount} color="#6366f1" />
                <StatItem label="앱(서버)" value={stats.appCount} color="#10b981" />
                <StatItem label="매칭됨" value={stats.matchedCount} color="#f59e0b" />
                <StatItem label="폰에만" value={stats.phoneOnly} color="#6b7280" />
                <StatItem label="앱에만" value={stats.appOnly} color="#6b7280" />
              </View>
            ) : (
              <View style={{ alignItems: 'center', padding: 20 }}>
                <ActivityIndicator color="#6366f1" />
              </View>
            )}
          </View>

          {progress ? (
            <View style={styles.progressCard}>
              <ActivityIndicator color="#6366f1" />
              <Text style={styles.progressText}>{progress.message ?? `${progress.done}/${progress.total}`}</Text>
              {progress.total > 0 ? (
                <View style={styles.progressBarBg}>
                  <View style={[styles.progressBarFill, { width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }]} />
                </View>
              ) : null}
            </View>
          ) : lastResult ? (
            <View style={styles.resultCard}>
              <FontAwesome name="check-circle" size={18} color="#10b981" />
              <Text style={styles.resultText}>{lastResult}</Text>
            </View>
          ) : null}

          {isMainAccount ? (
            <Pressable style={[styles.primaryBtn, busy && styles.btnDisabled]} onPress={runTwoWay} disabled={busy || !stats}>
              <FontAwesome name="exchange" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>양방향 동기화 시작</Text>
            </Pressable>
          ) : (
            <View style={styles.subInfoCard}>
              <FontAwesome name="info-circle" size={16} color="#92400e" />
              <Text style={styles.subInfoText}>
                이 계정은 <Text style={{ fontWeight: '700' }}>서브 계정</Text>입니다. 메인 계정(웹)의 연락처를 폰으로 받아오기만 지원하며, 폰에서의 수정/삭제는 서버에 자동 반영되지 않습니다.
              </Text>
            </View>
          )}

          <Pressable
            style={[styles.altActionBtn, busy && styles.btnDisabled]}
            onPress={() => {
              if (!user || !stats) return;
              Alert.alert(
                '앱 → 폰 단방향',
                `앱의 ${stats.appCount.toLocaleString()}건을 폰에 저장합니다. 폰의 변경사항은 서버로 올리지 않습니다.\n\n공유받은 계정 연락처를 폰에 내보낼 때 안전합니다. 진행할까요?`,
                [
                  { text: '취소', style: 'cancel' },
                  {
                    text: '시작',
                    onPress: async () => {
                      setLastResult(null);
                      setProgress({ phase: 'phone-read', done: 0, total: 0, message: '준비 중...' });
                      try {
                        const r = await syncAppToPhone(user.id, setProgress);
                        setLastResult(`앱→폰 완료: 신규 +${r.added} / 수정 ${r.updated} / 스킵 ${r.skipped} / 실패 ${r.errors}`);
                        await refreshStats();
                      } catch (e) {
                        Alert.alert('실패', (e as Error).message);
                      } finally {
                        setProgress(null);
                      }
                    },
                  },
                ]
              );
            }}
            disabled={busy || !stats}
          >
            <FontAwesome name="mobile" size={16} color="#6366f1" />
            <Text style={styles.altActionBtnText}>앱 → 폰 단방향만</Text>
          </Pressable>

          <Text style={styles.note}>
            💡 앱이 열려있는 동안은 서버 변경이 폰에 자동 반영됩니다.{'\n'}
            {isMainAccount
              ? '폰에서 추가/수정한 내용은 앱을 포그라운드로 전환할 때마다 자동 감지되어 서버로 올라갑니다.'
              : '서브 계정이므로 폰에서 변경한 내용은 서버로 올라가지 않습니다. Discover 탭에서 찾은 신규 번호는 메인 계정 서버에 추가됩니다.'}
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function StatItem({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.statItem}>
      <Text style={[styles.statValue, { color }]}>{value.toLocaleString()}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 6 },
  subtitle: { fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 18 },
  statsCard: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#e5e7eb' },
  statsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  statsTitle: { fontSize: 14, color: '#6b7280', fontWeight: '600' },
  refreshBtn: { padding: 6 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  statItem: { flex: 1, minWidth: 80, paddingVertical: 6 },
  statValue: { fontSize: 20, fontWeight: '700' },
  statLabel: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  progressCard: { backgroundColor: '#eef2ff', borderRadius: 12, padding: 16, marginBottom: 16, gap: 10 },
  progressText: { fontSize: 13, color: '#3730a3', fontWeight: '500', textAlign: 'center' },
  progressBarBg: { height: 6, backgroundColor: '#e0e7ff', borderRadius: 3, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#6366f1' },
  resultCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#ecfdf5', borderRadius: 12, padding: 14, marginBottom: 16 },
  resultText: { fontSize: 13, color: '#065f46', flex: 1 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#6366f1', borderRadius: 12, padding: 14, marginBottom: 10 },
  altBtn: { backgroundColor: '#10b981' },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  altActionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#eef2ff', borderRadius: 12, padding: 12, marginBottom: 10 },
  altActionBtnText: { color: '#6366f1', fontSize: 14, fontWeight: '600' },
  note: { fontSize: 12, color: '#6b7280', lineHeight: 18, marginTop: 12, padding: 12, backgroundColor: '#fff', borderRadius: 10 },
  cardError: { backgroundColor: '#fef2f2', borderRadius: 12, padding: 16, alignItems: 'center', gap: 10 },
  errorText: { fontSize: 13, color: '#991b1b', textAlign: 'center' },
  secondaryBtn: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#fca5a5' },
  secondaryBtnText: { color: '#991b1b', fontSize: 13, fontWeight: '600' },
  subInfoCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#fef3c7', borderRadius: 12, padding: 14, marginBottom: 10 },
  subInfoText: { fontSize: 13, color: '#92400e', flex: 1, lineHeight: 19 },
});
