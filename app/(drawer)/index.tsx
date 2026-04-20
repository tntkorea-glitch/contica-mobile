import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, FlatList, TextInput, StyleSheet, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { supabase } from '@/lib/supabase';
import type { Contact, Group } from '@/lib/types';

const PAGE_SIZE = 50;

type FilterKey = 'all' | 'favorites' | 'unnamed' | 'trash' | 'group';

const FILTER_TITLE: Record<FilterKey, string> = {
  all: '전체 연락처',
  favorites: '즐겨찾기',
  unnamed: '이름없는 연락처',
  trash: '휴지통',
  group: '그룹',
};

export default function ContactsScreen() {
  const params = useLocalSearchParams<{ filter?: string; groupId?: string }>();
  const filter = (params.filter as FilterKey | undefined) ?? 'all';
  const groupId = params.groupId;
  const navigation = useNavigation();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [liveTick, setLiveTick] = useState(0);
  const [groupName, setGroupName] = useState<string | null>(null);

  useEffect(() => {
    if (filter === 'group' && groupId) {
      (async () => {
        const { data } = await supabase.from('groups').select('name').eq('id', groupId).maybeSingle();
        setGroupName((data as Pick<Group, 'name'> | null)?.name ?? '그룹');
      })();
    } else {
      setGroupName(null);
    }
  }, [filter, groupId]);

  useEffect(() => {
    const title =
      filter === 'group' ? (groupName ?? '그룹')
      : FILTER_TITLE[filter] ?? '연락처';
    navigation.setOptions({ title });
  }, [filter, groupName, navigation]);

  const load = useCallback(async (opts?: { reset?: boolean }) => {
    const reset = opts?.reset ?? false;
    const nextPage = reset ? 0 : page;
    if (reset) setLoading(true);
    else setLoadingMore(true);

    const useGroupJoin = filter === 'group' && !!groupId;
    let q = useGroupJoin
      ? supabase
          .from('contacts')
          .select('*, contact_groups!inner(group_id)', reset ? { count: 'exact' } : undefined)
          .eq('contact_groups.group_id', groupId as string)
          .is('deleted_at', null)
      : supabase
          .from('contacts')
          .select('*', reset ? { count: 'exact' } : undefined);

    if (!useGroupJoin) {
      if (filter === 'trash') {
        q = q.not('deleted_at', 'is', null);
      } else {
        q = q.is('deleted_at', null);
        if (filter === 'favorites') q = q.eq('favorite', true);
        if (filter === 'unnamed') {
          q = q.or('last_name.is.null,last_name.eq.');
        }
      }
    }

    q = q
      .order('last_name', { ascending: true })
      .order('first_name', { ascending: true })
      .range(nextPage * PAGE_SIZE, nextPage * PAGE_SIZE + PAGE_SIZE - 1);

    if (search.trim()) {
      const s = search.trim();
      q = q.or(`last_name.ilike.%${s}%,first_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
    }

    const { data, error, count } = await q;
    if (reset && typeof count === 'number') setTotal(count);
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
  }, [page, search, filter, groupId]);

  useEffect(() => {
    load({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filter, groupId]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel('contacts-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'contacts' },
        () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            setLiveTick(t => t + 1);
            loadRef.current({ reset: true });
          }, 300);
        }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    load({ reset: true });
  };

  const onEndReached = () => {
    if (!hasMore || loadingMore) return;
    load();
  };

  const subLabel =
    filter === 'group' ? (groupName ? `그룹 · ${groupName}` : '그룹')
    : FILTER_TITLE[filter];

  const listHeader = useMemo(() => (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.totalText}>
            {total !== null ? `${total.toLocaleString()}명` : '…'}
            <Text style={styles.subLabel}>  {subLabel}</Text>
          </Text>
        </View>
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>실시간{liveTick > 0 ? ` · ${liveTick}` : ''}</Text>
        </View>
      </View>
      <TextInput
        style={styles.search}
        placeholder="이름·전화·이메일 검색"
        placeholderTextColor="#9ca3af"
        value={search}
        onChangeText={setSearch}
      />
    </View>
  ), [search, total, liveTick, subLabel]);

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
  header: { padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', gap: 8 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalText: { fontSize: 14, color: '#111827', fontWeight: '600' },
  subLabel: { fontSize: 12, color: '#6b7280', fontWeight: '500' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#f0fdf4', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#22c55e' },
  liveText: { fontSize: 11, color: '#16a34a', fontWeight: '600' },
  search: { backgroundColor: '#f3f4f6', borderRadius: 10, padding: 10, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#6366f1', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  name: { fontSize: 15, color: '#111827', fontWeight: '500' },
  phone: { fontSize: 12, color: '#6b7280', marginTop: 2 },
});
