import { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, FlatList, TextInput, StyleSheet, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { supabase } from '@/lib/supabase';
import type { Contact } from '@/lib/types';

const PAGE_SIZE = 50;

export default function ContactsScreen() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);

  const load = useCallback(async (opts?: { reset?: boolean }) => {
    const reset = opts?.reset ?? false;
    const nextPage = reset ? 0 : page;
    if (reset) setLoading(true);
    else setLoadingMore(true);

    let q = supabase
      .from('contacts')
      .select('*')
      .is('deleted_at', null)
      .order('last_name', { ascending: true })
      .order('first_name', { ascending: true })
      .range(nextPage * PAGE_SIZE, nextPage * PAGE_SIZE + PAGE_SIZE - 1);

    if (search.trim()) {
      const s = search.trim();
      q = q.or(`last_name.ilike.%${s}%,first_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
    }

    const { data, error } = await q;
    if (error) {
      console.warn('contacts fetch error:', error.message);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    const rows = (data ?? []) as Contact[];
    setContacts(prev => (reset ? rows : [...prev, ...rows]));
    setHasMore(rows.length === PAGE_SIZE);
    setPage(reset ? 1 : nextPage + 1);
    setLoading(false);
    setLoadingMore(false);
    setRefreshing(false);
  }, [page, search]);

  useEffect(() => {
    load({ reset: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const onRefresh = () => {
    setRefreshing(true);
    load({ reset: true });
  };

  const onEndReached = () => {
    if (!hasMore || loadingMore) return;
    load();
  };

  const listHeader = useMemo(() => (
    <View style={styles.header}>
      <TextInput
        style={styles.search}
        placeholder="이름·전화·이메일 검색"
        placeholderTextColor="#9ca3af"
        value={search}
        onChangeText={setSearch}
      />
    </View>
  ), [search]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#6366f1" size="large" />
        <Text style={{ marginTop: 12, color: '#6b7280' }}>연락처 불러오는 중...</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={contacts}
      keyExtractor={c => c.id}
      ListHeaderComponent={listHeader}
      stickyHeaderIndices={[0]}
      renderItem={({ item }) => <ContactRow contact={item} />}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.3}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={{ color: '#9ca3af' }}>연락처가 없습니다</Text>
        </View>
      }
      ListFooterComponent={loadingMore ? (
        <View style={{ padding: 16 }}><ActivityIndicator color="#6366f1" /></View>
      ) : null}
      style={styles.list}
    />
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const name = [contact.last_name, contact.first_name].filter(Boolean).join(' ') || '이름 없음';
  const initial = (contact.last_name?.[0] || contact.first_name?.[0] || '?').toUpperCase();
  return (
    <Pressable style={styles.row}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initial}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        {contact.phone ? <Text style={styles.phone} numberOfLines={1}>{contact.phone}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  list: { flex: 1, backgroundColor: '#fff' },
  header: { padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  search: { backgroundColor: '#f3f4f6', borderRadius: 10, padding: 10, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#6366f1', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  name: { fontSize: 15, color: '#111827', fontWeight: '500' },
  phone: { fontSize: 12, color: '#6b7280', marginTop: 2 },
});
