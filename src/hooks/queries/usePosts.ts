import { useCallback, useRef } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../../components/Toast';
import { requestPreviewFetch } from '../../utils/preview/invoke';
import { type DeviceHints, isPreviewLoading } from '../../utils/preview/types';
import { queryKeys } from '../../utils/react-query/queryKeys';
import { supabase } from '../../utils/supabase/client';

// --- Query ---
export function usePostsQuery(folderId: string) {
  return useQuery({
    queryKey: [queryKeys.POST_LIST, folderId],
    queryFn: async () => {
      const { data, error } = await supabase.from('posts').select().eq('folder_id', Number(folderId));
      // 에러를 던져야 retry·isError 가 동작한다 (useFolders 와 같은 계약).
      // 던지지 않으면 실패가 'success + 빈 목록'으로 위장된다.
      if (error) throw error;
      return data ?? [];
    },
    // 서버가 미리보기를 수집 중인 행(pending/fetching)이 있으면 3초마다 목록을 다시 받아 카드를 채운다.
    // Realtime 을 안 쓰는 이유: 앱 어디에도 channel 이 없고 posts 의 publication 여부도 불확실한데,
    // 수집은 저장 직후 수 초면 끝나는 짧은 창이라 폴링이 더 단순하다.
    // isPreviewLoading 은 pending 10분·fetching 2분 창을 두므로 함수 미배포·pg_net 실패로 막힌 행이
    // 영구 폴링을 만들지 않는다 — 창이 지나면 false 로 떨어져 폴링이 멈추고 카드는 도메인 카드로 굳는다.
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.some((p) => isPreviewLoading(p.preview_status, p.created_at, p.preview_claimed_at)) ? 3000 : false;
    },
  });
}

/** 목록 캐시에서 id 로 걸러낼 때만 쓰는 최소 구조 (any 회피용) */
type RowWithId = { id: number };

// --- Mutations ---
export function useCreatePost() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: {
      url: string;
      description: string | null;
      folder_id: number;
      /** 공유 텍스트에서 뽑은 제목 힌트 — 005 ③ 컬럼 GRANT 가 클라이언트 insert 를 허용하는 유일한 preview_* 컬럼 */
      preview_title?: string | null;
      /** 저장 전 parseMetadata 결과. insert 컬럼이 아니다(42501) — invoke 바디로만 보낸다 */
      deviceHints?: DeviceHints | null;
    }) => {
      const { url, description, folder_id, preview_title, deviceHints } = params;
      // preview_title 키는 힌트가 있을 때만 — null 이라도 키가 실리면 005 미적용 DB 에서 PostgREST 가
      // 컬럼 없음(PGRST204) 으로 insert 자체를 거절해 힌트 없는 저장까지 막힌다
      const row = { url, description, folder_id, ...(preview_title ? { preview_title } : {}) };
      // RETURNING 이 RLS 로 막히면 42501 → 라이브 검증 후 .select 제거 가능(트리거·catch-up 만으로도 동작한다)
      const { data, error } = await supabase.from('posts').insert(row).select('id').single();
      if (error) throw error;
      if (data?.id) {
        // DB 트리거가 활성이면 서버가 먼저 수집한다. 여기 호출은 가속용이라 await 하지 않는다 —
        // 공유 시트는 280 ms 뒤 Activity 를 닫고 타이머가 멈춘다. 끝나면 목록과 활동 피드를 다시 받아
        // 카드·피드 제목을 채우고, 함수 미배포·5xx 는 조용히 버린다(카드는 어차피 도메인 카드로 그려진다).
        void requestPreviewFetch(data.id, deviceHints ?? null)
          .then(() => {
            queryClient.invalidateQueries({ queryKey: [queryKeys.POST_LIST, String(folder_id)] });
            queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_ACTIVITY] });
          })
          .catch(() => {});
      }
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.POST_LIST, String(variables.folder_id)] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_ACTIVITY] });
      showToast('success', '링크가 추가되었어요');
    },
    onError: () => {
      showToast('error', '링크 추가에 실패했어요');
    },
  });
}

export function useUpdatePost(folderId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: { id: number; description: string | null }) => {
      const { id, description } = params;
      const { error } = await supabase.from('posts').update({ description }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.POST_LIST, folderId] });
      showToast('success', '메모가 수정되었어요');
    },
    onError: () => {
      showToast('error', '메모 수정에 실패했어요');
    },
  });
}

export function useDeletePost(folderId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase.from('posts').delete().eq('id', id);
      if (error) throw error;
    },
    onMutate: async (id) => {
      const queryKey = [queryKeys.POST_LIST, folderId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData<RowWithId[]>(queryKey, (old) => old?.filter((p) => p.id !== id));
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData([queryKeys.POST_LIST, folderId], context.previous);
      }
      showToast('error', '링크 삭제에 실패했어요');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.POST_LIST, folderId] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST] });
    },
    onSuccess: () => {
      showToast('success', '링크가 삭제되었어요');
    },
  });
}

/**
 * B-6: Undo 삭제 — 링크를 즉시 DB에서 지우지 않고 낙관적 제거 후
 * 6초 Undo 토스트를 보여준다. 타임아웃 시 실제 삭제, Undo 시 복구.
 */
export function useDeferredDeletePost(folderId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  // ⚠️ id 별 타이머 — 단일 ref 를 쓰면 6초 안에 두 개를 지울 때 첫 번째 타이머가 취소되어
  //    그 항목이 DB 에서 영영 삭제되지 않고 invalidate 시점에 되살아난다(2026-07-23 감사).
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const execute = useCallback((id: number) => {
    const queryKey = [queryKeys.POST_LIST, folderId];

    // 1. 낙관적으로 캐시에서 제거
    const previous = queryClient.getQueryData(queryKey);
    queryClient.setQueryData<RowWithId[]>(queryKey, (old) => old?.filter((p) => p.id !== id));

    const running = timersRef.current.get(id);
    if (running) clearTimeout(running);

    let undone = false;

    // 2. Undo 토스트 (6초)
    showToast('success', '링크가 삭제되었어요', {
      duration: 6000,
      action: {
        label: '실행 취소',
        onPress: () => {
          undone = true;
          const t = timersRef.current.get(id);
          if (t) clearTimeout(t);
          timersRef.current.delete(id);
          if (previous) {
            queryClient.setQueryData(queryKey, previous);
          }
          showToast('success', '삭제가 취소되었어요');
        },
      },
    });

    // 3. 6초 후 실제 삭제
    const timer = setTimeout(() => {
      if (!undone) {
        supabase.from('posts').delete().eq('id', id).then(({ error }) => {
          if (error) {
            if (previous) {
              queryClient.setQueryData(queryKey, previous);
            }
            showToast('error', '링크 삭제에 실패했어요');
          }
          queryClient.invalidateQueries({ queryKey });
          queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST] });
        });
      }
      timersRef.current.delete(id);
    }, 6000);
    timersRef.current.set(id, timer);
  }, [queryClient, showToast, folderId]);

  return { execute };
}
