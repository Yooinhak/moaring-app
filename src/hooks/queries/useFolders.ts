import { useCallback, useRef } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../../components/Toast';
import { queryKeys } from '../../utils/react-query/queryKeys';
import { supabase } from '../../utils/supabase/client';

// ⚠️ 그룹 모델 전환 (001_groups_sharing.sql): 폴더는 항상 그룹에 소속.
// 조회/생성은 groupId 필수, 캐시 키는 [FOLDER_LIST, groupId].

/** 목록 캐시에서 id 로 걸러낼 때만 쓰는 최소 구조 (any 회피용) */
type RowWithId = { id: number };

// --- Query ---
export function useFoldersQuery(groupId: string | null) {
  return useQuery({
    queryKey: [queryKeys.FOLDER_LIST, groupId],
    enabled: !!groupId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('folders')
        .select('*, posts(count)')
        .eq('group_id', groupId!)
        .order('created_at', { ascending: false });
      // Supabase 는 RLS 거부·네트워크 실패에도 reject 하지 않고 { data:null, error } 로
      // resolve 한다. 던지지 않으면 실패가 'success + 빈 목록'으로 위장되어
      // retry·isError 가 통째로 죽는다 (useGroups 와 같은 계약).
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * 내가 속한 모든 그룹의 폴더 (공유 인텐트 저장 시트 ⑥ — 그룹별 섹션 그룹핑용).
 * RLS가 멤버십 기준으로 필터하므로 조건 없이 전체 조회하면 된다.
 */
export function useAllFoldersQuery(enabled = true) {
  return useQuery({
    queryKey: [queryKeys.FOLDER_LIST, 'all'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('folders')
        .select('*, group:groups(id, name, color, type)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// --- Mutations ---
export function useCreateFolder(groupId: string | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: { name: string; color: string; emoji?: string | null }) => {
      if (!groupId) throw new Error('NO_GROUP');
      const { error } = await supabase.from('folders').insert({ ...params, group_id: groupId });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST] });
      showToast('success', '폴더가 생성되었어요');
    },
    onError: () => {
      showToast('error', '폴더 생성에 실패했어요');
    },
  });
}

/** 폴더는 만들었지만 그 안에 링크 저장이 실패함 — 호출부가 새 폴더를 선택해 재시도를 유도한다. */
export class FolderCreatedPostFailedError extends Error {
  constructor(readonly folderId: number) {
    super('POST_INSERT_FAILED');
    this.name = 'FolderCreatedPostFailedError';
  }
}

/**
 * 새 폴더 생성 + 첫 링크 저장 (저장 시트의 「만들고 바로 저장」).
 *
 * - 그룹은 호출 시점에 고르므로 groupId 를 파라미터로 받는다 (useCreateFolder 는 훅 생성 시 고정).
 * - retry 0: 전역 기본(mutations.retry: 1)이면 링크 저장 실패 시 mutationFn 이 다시 돌아
 *   폴더가 중복 생성된다.
 * - 토스트는 호출부가 결과에 맞춰 한 번만 띄운다 (공유 시트 시스템 토스트 중복 방지).
 */
export function useCreateFolderWithPost() {
  const queryClient = useQueryClient();

  return useMutation({
    retry: 0,
    mutationFn: async (params: { groupId: string; name: string; color: string; emoji: string | null; url: string }) => {
      const { data: folder, error } = await supabase
        .from('folders')
        .insert({ group_id: params.groupId, name: params.name, color: params.color, emoji: params.emoji })
        .select('id')
        .single();
      if (error) throw error;

      // posts.group_id 는 DB 트리거가 폴더 기준으로 채운다 — useCreatePost 와 같은 payload
      const { error: postError } = await supabase
        .from('posts')
        .insert({ url: params.url, description: null, folder_id: folder.id });
      if (postError) throw new FolderCreatedPostFailedError(folder.id);

      return { folderId: folder.id };
    },
    onSuccess: ({ folderId }) => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.POST_LIST, String(folderId)] });
    },
    onSettled: () => {
      // 링크 저장만 실패해도 폴더는 생겼으므로 성공/실패 모두 갱신
      queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_ACTIVITY] });
    },
  });
}

export function useUpdateFolder(groupId: string | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: { id: number; name: string; color: string; emoji?: string | null }) => {
      const { id, name, color, emoji } = params;
      const { error } = await supabase.from('folders').update({ name, color, emoji }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST, groupId] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST, 'all'] });
      showToast('success', '폴더가 수정되었어요');
    },
    onError: () => {
      showToast('error', '수정에 실패했어요');
    },
  });
}

export function useDeleteFolder(groupId: string | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const listKey = [queryKeys.FOLDER_LIST, groupId];

  return useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase.from('folders').delete().eq('id', id);
      if (error) throw error;
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData(listKey);
      queryClient.setQueryData<RowWithId[]>(listKey, (old) => old?.filter((f) => f.id !== id));
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(listKey, context.previous);
      }
      showToast('error', '폴더 삭제에 실패했어요');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST] });
    },
    onSuccess: () => {
      showToast('success', '폴더가 삭제되었어요');
    },
  });
}

/**
 * B-6: Undo 삭제 — 폴더를 즉시 DB에서 지우지 않고 낙관적 제거 후
 * 6초 Undo 토스트를 보여준다. 타임아웃 시 실제 삭제, Undo 시 복구.
 */
export function useDeferredDeleteFolder(groupId: string | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  // ⚠️ id 별 타이머 — 단일 ref 를 쓰면 6초 안에 두 개를 지울 때 첫 번째 타이머가 취소되어
  //    그 항목이 DB 에서 영영 삭제되지 않고 invalidate 시점에 되살아난다(2026-07-23 감사).
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const execute = useCallback(
    (id: number) => {
      const listKey = [queryKeys.FOLDER_LIST, groupId];

      // 1. 낙관적으로 캐시에서 제거
      const previous = queryClient.getQueryData(listKey);
      queryClient.setQueryData<RowWithId[]>(listKey, (old) => old?.filter((f) => f.id !== id));

      // 같은 항목을 다시 지우는 경우에만 이전 타이머를 정리한다(다른 항목 것은 건드리지 않는다)
      const running = timersRef.current.get(id);
      if (running) clearTimeout(running);

      let undone = false;

      // 2. Undo 토스트 (6초)
      showToast('success', '폴더가 삭제되었어요', {
        duration: 6000,
        action: {
          label: '실행 취소',
          onPress: () => {
            undone = true;
            const t = timersRef.current.get(id);
            if (t) clearTimeout(t);
            timersRef.current.delete(id);
            if (previous) {
              queryClient.setQueryData(listKey, previous);
            }
            showToast('success', '삭제가 취소되었어요');
          },
        },
      });

      // 3. 6초 후 실제 삭제
      const timer = setTimeout(() => {
        if (!undone) {
          supabase.from('folders').delete().eq('id', id).then(({ error }) => {
            if (error) {
              if (previous) {
                queryClient.setQueryData(listKey, previous);
              }
              showToast('error', '폴더 삭제에 실패했어요');
            }
            queryClient.invalidateQueries({ queryKey: [queryKeys.FOLDER_LIST] });
          });
        }
        timersRef.current.delete(id);
      }, 6000);
      timersRef.current.set(id, timer);
    },
    [queryClient, showToast, groupId],
  );

  return { execute };
}
