import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { supabase } from './supabase';
import { applyServerChangeToPhone, ensurePermission, syncPhoneToApp } from './phoneSync';
import { isMainAccountId, MAIN_USER_ID } from './constants';
import type { Contact } from './types';

const APPSTATE_SYNC_THROTTLE_MS = 2 * 60 * 1000; // 2분

export function usePhoneSyncBridge(userId: string | undefined) {
  const lastAppStateSyncRef = useRef<number>(0);
  const syncingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!userId) return;

    const isMain = isMainAccountId(userId);
    let cancelled = false;

    const runPhoneToAppSilent = async () => {
      if (syncingRef.current) return;
      const now = Date.now();
      if (now - lastAppStateSyncRef.current < APPSTATE_SYNC_THROTTLE_MS) return;

      const granted = await ensurePermission();
      if (!granted || cancelled) return;

      syncingRef.current = true;
      lastAppStateSyncRef.current = now;
      try {
        await syncPhoneToApp(userId);
      } catch (e) {
        console.warn('[bridge] phone→app sync error:', (e as Error).message);
      } finally {
        syncingRef.current = false;
      }
    };

    // 서브 계정도 메인 계정의 변경사항을 받아야 하므로 구독 대상은 메인 id.
    const subscribedUserId = isMain ? userId : MAIN_USER_ID;
    const channel = supabase
      .channel('bridge-server-to-phone')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'contacts' },
        async payload => {
          const contact = ((payload.new as Contact | null) ?? (payload.old as Contact | null));
          if (!contact) return;
          if (contact.user_id !== subscribedUserId) return;
          const action =
            payload.eventType === 'INSERT' ? 'insert' :
            payload.eventType === 'UPDATE' ? 'update' :
            'delete';
          await applyServerChangeToPhone(contact, action);
        }
      )
      .subscribe();

    // 서브 계정은 폰→서버 자동 업로드 비활성 (사고 방지). 메인 계정만 포그라운드 복귀 시 auto sync.
    let appStateSub: { remove: () => void } | null = null;
    if (isMain) {
      appStateSub = AppState.addEventListener('change', state => {
        if (state === 'active') runPhoneToAppSilent();
      });
    }

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      appStateSub?.remove();
    };
  }, [userId]);
}
