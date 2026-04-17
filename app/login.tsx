import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';

export default function LoginScreen() {
  const { signInWithEmail, signUpWithEmail, signInWithGoogle } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleEmail = async () => {
    if (!email || !password) {
      Alert.alert('입력 오류', '이메일과 비밀번호를 입력해주세요');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password);
        Alert.alert('가입 완료', '이제 로그인해주세요');
        setMode('login');
      }
    } catch (err) {
      Alert.alert('오류', err instanceof Error ? err.message : '로그인 실패');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      Alert.alert('구글 로그인 실패', err instanceof Error ? err.message : '오류');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoText}>📇</Text>
        </View>
        <Text style={styles.title}>Contica</Text>
        <Text style={styles.subtitle}>다중 기기 연락처 동기화</Text>

        {/* 소셜 로그인 */}
        <Pressable style={[styles.socialBtn, styles.googleBtn]} onPress={handleGoogle} disabled={loading}>
          <Text style={styles.googleBtnText}>🇬 Google 계정으로 로그인</Text>
        </Pressable>
        <Pressable
          style={[styles.socialBtn, styles.kakaoBtn]}
          onPress={() => Alert.alert('알림', '카카오 로그인은 준비 중입니다')}
        >
          <Text style={styles.kakaoBtnText}>💬 카카오 로그인</Text>
        </Pressable>
        <Pressable
          style={[styles.socialBtn, styles.naverBtn]}
          onPress={() => Alert.alert('알림', '네이버 로그인은 준비 중입니다')}
        >
          <Text style={styles.naverBtnText}>Ⓝ 네이버 로그인</Text>
        </Pressable>

        {/* 구분선 */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>또는 이메일</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* 탭 */}
        <View style={styles.tabRow}>
          <Pressable style={[styles.tab, mode === 'login' && styles.tabActive]} onPress={() => setMode('login')}>
            <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>로그인</Text>
          </Pressable>
          <Pressable style={[styles.tab, mode === 'signup' && styles.tabActive]} onPress={() => setMode('signup')}>
            <Text style={[styles.tabText, mode === 'signup' && styles.tabTextActive]}>회원가입</Text>
          </Pressable>
        </View>

        {/* 이메일 폼 */}
        <TextInput
          style={styles.input}
          placeholder="이메일"
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="비밀번호 (6자 이상)"
          placeholderTextColor="#9ca3af"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <Pressable style={styles.submitBtn} onPress={handleEmail} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>{mode === 'login' ? '로그인' : '가입하기'}</Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 20, backgroundColor: '#f5f3ff' },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 24, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 20, elevation: 2 },
  logoCircle: { width: 56, height: 56, borderRadius: 16, backgroundColor: '#6366f1', justifyContent: 'center', alignItems: 'center', alignSelf: 'center', marginBottom: 12 },
  logoText: { fontSize: 28 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', textAlign: 'center' },
  subtitle: { fontSize: 13, color: '#6b7280', textAlign: 'center', marginTop: 4, marginBottom: 24 },
  socialBtn: { padding: 12, borderRadius: 10, alignItems: 'center', marginBottom: 8 },
  googleBtn: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d1d5db' },
  googleBtnText: { color: '#111827', fontWeight: '500' },
  kakaoBtn: { backgroundColor: '#FEE500' },
  kakaoBtnText: { color: '#191600', fontWeight: '500' },
  naverBtn: { backgroundColor: '#03C75A' },
  naverBtnText: { color: '#fff', fontWeight: '500' },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerText: { fontSize: 11, color: '#9ca3af', paddingHorizontal: 10 },
  tabRow: { flexDirection: 'row', backgroundColor: '#f3f4f6', borderRadius: 10, padding: 4, marginBottom: 16 },
  tab: { flex: 1, padding: 8, alignItems: 'center', borderRadius: 6 },
  tabActive: { backgroundColor: '#fff' },
  tabText: { fontSize: 13, color: '#6b7280' },
  tabTextActive: { color: '#111827', fontWeight: '600' },
  input: { backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 12, fontSize: 14, marginBottom: 10 },
  submitBtn: { backgroundColor: '#6366f1', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 6 },
  submitBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
