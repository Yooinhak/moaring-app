import { AppState } from 'react-native';

import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

import { appStorage } from '../storage/appStorage';

import { Database } from './types';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// 세션은 appStorage(iOS: App Group) 에 둔다 — iOS 공유 확장(별도 프로세스)이 같은 로그인을 쓴다.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: appStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// 포그라운드일 때만 자동 갱신 — 백그라운드에서 공유 확장과 갱신이 겹치지 않게 하고,
// 복귀 시 확장이 갱신해 둔 세션을 저장소에서 다시 읽는다 (supabase-js 는 매 조회마다 storage 를 읽음).
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
