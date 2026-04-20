import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { supabase } from './supabase';
import { applyServerChangeToPhone, ensurePermission, syncPhoneToApp } from './phoneSync';
import type { Contact } from './types';

const APPSTATE_SYNC_THROTTLE_MS = 2 * 60 * 1000; // 2분

export function usePhoneSyncBridge(userId: string | undefined) {
  const lastAppStateSyncRef = useRef<number>(0);
  const syncingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!userId) return;

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

    const channel = supabase
      .channel('bridge-server-to-phone')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'contacts' },
        async payload => {
          const contact = ((payload.new as Contact | null) ?? (payload.old as Contact | null));
          if (!contact) return;
          if (contact.user_id !== userId) return;
          const action =
            payload.eventType === 'INSERT' ? 'insert' :
            payload.eventType === 'UPDATE' ? 'update' :
            'delete';
          await applyServerChangeToPhone(contact, action);
        }
      )
      .subscribe();

    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') runPhoneToAppSilent();
    });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      appStateSub.remove();
    };
  }, [userId]);
}
