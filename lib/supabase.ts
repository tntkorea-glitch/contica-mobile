import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// Expo Router의 server pre-render 단계에서는 window가 없어 AsyncStorage가 crash.
// 브라우저/native 환경에서만 AsyncStorage를 storage로 사용하고, 서버 단계는 in-memory + persistSession:false.
const isClient = typeof window !== 'undefined';

export const supabase = createClient(url, anon, {
  auth: isClient
    ? {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      }
    : {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
});
