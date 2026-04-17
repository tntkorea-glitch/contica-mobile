import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';

export default function MeScreen() {
  const { user, signOut } = useAuth();

  const handleSignOut = () => {
    Alert.alert('로그아웃', '로그아웃 하시겠습니까?', [
      { text: '취소', style: 'cancel' },
      { text: '로그아웃', style: 'destructive', onPress: signOut },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.profile}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{user?.email?.[0]?.toUpperCase() || '?'}</Text>
        </View>
        <Text style={styles.email}>{user?.email || '-'}</Text>
      </View>

      <View style={styles.section}>
        <Pressable style={styles.row} onPress={handleSignOut}>
          <Text style={styles.rowText}>로그아웃</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb', padding: 16 },
  profile: { alignItems: 'center', padding: 24, backgroundColor: '#fff', borderRadius: 16, marginBottom: 16 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#6366f1', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  avatarText: { color: '#fff', fontSize: 24, fontWeight: '600' },
  email: { fontSize: 14, color: '#111827', fontWeight: '500' },
  section: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  row: { padding: 14, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  rowText: { fontSize: 14, color: '#ef4444', fontWeight: '500' },
});
