import { useEffect, useState } from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Session, User } from '@supabase/supabase-js';

import { normalizeAvatarUrl } from '../utils/avatarUrl';
import { queryClient } from '../utils/react-query/queryClient';
import { supabase } from '../utils/supabase/client';

/**
 * profiles 동기화.
 *
 * 가입 트리거(handle_new_user)는 `after insert` 1회뿐이라, 이후 OAuth 프로필
 * (이름/사진)이 바뀌어도 profiles 는 가입 시점 값에 동결된다. 그 결과 그룹 멤버·
 * 활동·링크 카드(=profiles 를 읽는 아바타)가 옛 사진 또는 null 로 남는다.
 * 로그인/앱 시작 시 최신 user_metadata 로 profiles 를 갱신해 동결을 해소한다.
 * avatar_url 은 https 로 정규화해 저장 → 상대방이 보는 아바타도 cleartext 차단을 피한다.
 *
 * 값이 있는 필드만 payload 에 담아, 메타데이터에 없는 값으로 기존 profiles 를
 * null 로 덮어쓰지 않는다. 실패해도 앱 흐름은 막지 않는다(로그인 자체와 무관).
 */
async function syncProfile(user: User) {
  const meta = user.user_metadata ?? {};
  const displayName = meta.full_name ?? meta.name ?? null;
  const avatarUrl = normalizeAvatarUrl(meta.avatar_url ?? meta.picture);

  const payload: {
    id: string;
    updated_at: string;
    display_name?: string;
    avatar_url?: string;
  } = { id: user.id, updated_at: new Date().toISOString() };
  if (displayName) payload.display_name = displayName;
  if (avatarUrl) payload.avatar_url = avatarUrl;

  const { error } = await supabase.from('profiles').upsert(payload, { onConflict: 'id' });
  if (error) console.warn('[useAuth] profiles 동기화 실패:', error.message);
}

/**
 * 로그아웃 시 이전 계정의 흔적을 지운다.
 *
 * 캐시 키에 사용자 식별자가 없고 gcTime 이 10분이라, 이걸 안 하면 다른 계정으로
 * 재로그인했을 때 **이전 사용자의 그룹명·폴더명·프로필이 먼저 그려진 뒤** 교체된다.
 * (계정 삭제 → 재가입 흐름에서 특히 잘 재현된다)
 *
 * 기기 설정(뷰 모드·정렬·최근 이모지)은 계정과 무관하므로 남긴다.
 */
function clearAccountScopedData() {
  queryClient.clear();
  AsyncStorage.multiRemove([
    'moaring.currentGroupId', // GroupContext
    'moaring.groupLastSeen', // useActivityUnread
    'moaring.recentFolderId', // SaveLinkSheet
  ]).catch(() => {
    // 스토리지 정리 실패가 로그아웃을 막을 이유는 없다
  });
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
      if (session?.user) syncProfile(session.user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      // 새 로그인 시에만 동기화(TOKEN_REFRESHED 등 반복 이벤트에는 upsert 안 함).
      if (event === 'SIGNED_IN' && session?.user) syncProfile(session.user);
      if (event === 'SIGNED_OUT') clearAccountScopedData();
    });

    return () => subscription.unsubscribe();
  }, []);

  return { session, loading };
}
