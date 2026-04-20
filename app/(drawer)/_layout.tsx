import { Drawer } from 'expo-router/drawer';
import {
  DrawerContentScrollView,
  type DrawerContentComponentProps,
} from '@react-navigation/drawer';
import { FontAwesome } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { usePhoneSyncBridge } from '@/lib/usePhoneSyncBridge';
import type { Group } from '@/lib/types';

type FilterKey = 'all' | 'favorites' | 'unnamed' | 'trash' | 'group';

const FILTERS: { key: Exclude<FilterKey, 'group'>; label: string; icon: React.ComponentProps<typeof FontAwesome>['name']; color: string }[] = [
  { key: 'all', label: '전체 연락처', icon: 'users', color: '#6366f1' },
  { key: 'favorites', label: '즐겨찾기', icon: 'star', color: '#f59e0b' },
  { key: 'unnamed', label: '이름없는 연락처', icon: 'question-circle', color: '#6b7280' },
  { key: 'trash', label: '휴지통', icon: 'trash', color: '#ef4444' },
];

function CustomDrawerContent(props: DrawerContentComponentProps) {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string; groupId?: string }>();
  const activeFilter = (params.filter as FilterKey | undefined) ?? 'all';
  const activeGroupId = params.groupId;
  const { user, signOut } = useAuth();
  const [groups, setGroups] = useState<Group[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from('groups')
        .select('*')
        .is('deleted_at', null)
        .order('name', { ascending: true });
      if (!alive) return;
      if (error) {
        console.warn('[drawer] groups fetch error:', error.message);
        setGroups([]);
        return;
      }
      setGroups((data ?? []) as Group[]);
    })();

    const channel = supabase
      .channel('drawer-groups-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'groups' }, async () => {
        const { data } = await supabase
          .from('groups')
          .select('*')
          .is('deleted_at', null)
          .order('name', { ascending: true });
        if (alive) setGroups((data ?? []) as Group[]);
      })
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const selectFilter = (key: Exclude<FilterKey, 'group'>) => {
    router.replace({ pathname: '/', params: { filter: key } });
    props.navigation.closeDrawer();
  };

  const selectGroup = (id: string) => {
    router.replace({ pathname: '/', params: { filter: 'group', groupId: id } });
    props.navigation.closeDrawer();
  };

  const isActiveFilter = (key: Exclude<FilterKey, 'group'>) => activeFilter === key && !activeGroupId;
  const isActiveGroup = (id: string) => activeFilter === 'group' && activeGroupId === id;

  return (
    <DrawerContentScrollView {...props} contentContainerStyle={styles.container}>
      <View style={styles.brandWrap}>
        <Text style={styles.brand}>contica</Text>
        {user?.email ? <Text style={styles.email} numberOfLines={1}>{user.email}</Text> : null}
      </View>

      <View style={styles.section}>
        {FILTERS.map(f => {
          const active = isActiveFilter(f.key);
          return (
            <Pressable
              key={f.key}
              onPress={() => selectFilter(f.key)}
              style={[styles.item, active && styles.itemActive]}
            >
              <FontAwesome name={f.icon} size={16} color={active ? f.color : '#6b7280'} style={styles.itemIcon} />
              <Text style={[styles.itemLabel, active && { color: f.color, fontWeight: '600' }]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.divider} />

      <View style={styles.sectionHeaderWrap}>
        <Text style={styles.sectionHeader}>그룹</Text>
      </View>
      <View style={styles.section}>
        {groups === null ? (
          <View style={{ padding: 14 }}>
            <ActivityIndicator size="small" color="#6366f1" />
          </View>
        ) : groups.length === 0 ? (
          <Text style={styles.emptyText}>그룹이 없습니다</Text>
        ) : (
          groups.map(g => {
            const active = isActiveGroup(g.id);
            return (
              <Pressable
                key={g.id}
                onPress={() => selectGroup(g.id)}
                style={[styles.item, active && styles.itemActive]}
              >
                <View style={[styles.groupDot, { backgroundColor: g.color || '#9ca3af' }]} />
                <Text style={[styles.itemLabel, active && { fontWeight: '600', color: '#111827' }]} numberOfLines={1}>
                  {g.name}
                </Text>
              </Pressable>
            );
          })
        )}
      </View>

      <View style={styles.divider} />

      <View style={styles.section}>
        <Pressable
          onPress={() => {
            router.push('/sync');
            props.navigation.closeDrawer();
          }}
          style={styles.item}
        >
          <FontAwesome name="refresh" size={16} color="#0ea5e9" style={styles.itemIcon} />
          <Text style={[styles.itemLabel, { color: '#0ea5e9', fontWeight: '600' }]}>폰 동기화</Text>
        </Pressable>
        <Pressable onPress={signOut} style={styles.item}>
          <FontAwesome name="sign-out" size={16} color="#ef4444" style={styles.itemIcon} />
          <Text style={[styles.itemLabel, { color: '#ef4444' }]}>로그아웃</Text>
        </Pressable>
      </View>
    </DrawerContentScrollView>
  );
}

export default function DrawerLayout() {
  const { user } = useAuth();
  usePhoneSyncBridge(user?.id);
  return (
    <Drawer
      drawerContent={props => <CustomDrawerContent {...props} />}
      screenOptions={{
        headerShown: true,
        drawerStyle: { width: 280 },
        headerTintColor: '#111827',
      }}
    >
      <Drawer.Screen name="index" options={{ title: '연락처' }} />
      <Drawer.Screen name="sync" options={{ title: '폰 동기화', drawerItemStyle: { display: 'none' } }} />
    </Drawer>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: 0 },
  brandWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  brand: { fontSize: 22, fontWeight: '700', color: '#111827' },
  email: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  section: { paddingVertical: 4 },
  sectionHeaderWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  sectionHeader: { fontSize: 11, color: '#9ca3af', fontWeight: '600', letterSpacing: 0.5 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
  itemActive: { backgroundColor: '#f3f4f6' },
  itemIcon: { width: 18, textAlign: 'center' },
  itemLabel: { fontSize: 14, color: '#374151', flex: 1 },
  groupDot: { width: 10, height: 10, borderRadius: 5 },
  divider: { height: 1, backgroundColor: '#f3f4f6', marginVertical: 4 },
  emptyText: { fontSize: 12, color: '#9ca3af', padding: 14, textAlign: 'center' },
});
