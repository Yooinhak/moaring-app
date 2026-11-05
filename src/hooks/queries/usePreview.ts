import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../../components/Toast';
import { parseOnDevice, toDeviceHints } from '../../utils/parseMetadata';
import { type PreviewInvokeResult, requestPreviewFetch } from '../../utils/preview/invoke';
import type { PreviewResult } from '../../utils/preview/types';
import { queryKeys } from '../../utils/react-query/queryKeys';
import { forgetPreviewRetryState } from '../usePreviewCatchUp';

/**
 * force 재수집이 post 당 60초 쿨다운에 걸렸다(서버 429 또는 results[0].skipped === 'cooldown').
 * 실패가 아니라 "잠시 후" 안내 대상이라 일반 실패와 토스트 문구를 가른다.
 */
export class PreviewCooldownError extends Error {
  constructor() {
    super('PREVIEW_COOLDOWN');
    this.name = 'PreviewCooldownError';
  }
}

/** force·힌트 동반 fetch 는 owner/editor 만 — viewer 는 서버가 403 {step:'forbidden'} 으로 거절한다 */
export class PreviewForbiddenError extends Error {
  constructor() {
    super('PREVIEW_FORBIDDEN');
    this.name = 'PreviewForbiddenError';
  }
}

/** 낙관 갱신에 필요한 컬럼만 (any 회피용 — usePosts 의 RowWithId 와 같은 방식) */
type PreviewRow = { id: number; preview_status: string; preview_claimed_at: string | null };

/** 저장 전 미리보기와 같은 예산 — 버튼을 누른 사용자가 기다리는 시간이므로 길게 잡지 않는다 */
const DEVICE_PARSE_TIMEOUT_MS = 4000;

/** 서버가 2xx 외로 거절하면 supabase-js 는 data 없이 FunctionsHttpError(context = Response) 만 돌려준다 */
function httpStatusOf(res: PreviewInvokeResult): number | undefined {
  return (res.error as { context?: { status?: number } } | null)?.context?.status;
}

function isCooldownRejection(res: PreviewInvokeResult): boolean {
  if (httpStatusOf(res) === 429) return true;
  return res.data?.results?.[0]?.skipped === 'cooldown';
}

function isForbiddenRejection(res: PreviewInvokeResult): boolean {
  if (httpStatusOf(res) === 403) return true;
  return res.data?.results?.[0]?.skipped === 'forbidden';
}

/**
 * '미리보기 다시 불러오기' (롱프레스 → 메모 수정 시트, canEdit && status 'failed' 일 때만 노출).
 *
 * 폰이 먼저 parseOnDevice 로 힌트를 만들고(서버가 차단당한 사이트도 폰 IP 로는 열릴 수 있다) `fetch force` 를 보낸다.
 * 해당 행을 fetching/claimed_at=now 로 낙관 갱신하는 이유: usePostsQuery 의 refetchInterval 이
 * isPreviewLoading 행을 보고 3초 폴링을 시작해, 서버가 끝내는 대로 카드가 채워진다. 그 폴링이 폰 파싱(≤4 s) 중에
 * DB 의 failed 를 읽어 낙관 행을 되돌릴 수 있어, 서버에 요청하기 직전에 한 번 더 세운다.
 * 서버는 요청을 처리했으면 결과가 failed 여도 success:true 를 주므로, 토스트는 results[0] 을 보고 가른다.
 * retry 0: 전역 기본(mutations.retry 1)이면 쿨다운 429 를 한 번 더 때려 또 429 를 받는다.
 * 토스트 문구는 훅 안에 둔다(useUpdatePost 등과 같은 관례).
 */
export function useRefreshPreview(folderId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const queryKey = [queryKeys.POST_LIST, folderId];

  const markFetching = async (postId: number) => {
    // 진행 중인 refetch 가 낙관 갱신을 덮어쓰지 않게 (useDeletePost 와 같은 패턴)
    await queryClient.cancelQueries({ queryKey });
    const claimedAt = new Date().toISOString();
    queryClient.setQueryData<PreviewRow[]>(queryKey, (old) =>
      old?.map((p) => (p.id === postId ? { ...p, preview_status: 'fetching', preview_claimed_at: claimedAt } : p)),
    );
  };

  return useMutation({
    retry: 0,
    mutationFn: async ({ postId, url }: { postId: number; url: string }): Promise<PreviewResult | undefined> => {
      // parseOnDevice 는 reject 하지 않지만, 혹시 던져도 힌트 없이 서버 수집은 진행한다
      const device = await parseOnDevice(url, { timeoutMs: DEVICE_PARSE_TIMEOUT_MS }).catch(() => null);
      await markFetching(postId);
      const res = await requestPreviewFetch(postId, device ? toDeviceHints(device) : null, true);
      if (isCooldownRejection(res)) throw new PreviewCooldownError();
      if (isForbiddenRejection(res)) throw new PreviewForbiddenError();
      if (res.error || !res.data?.success) throw new Error('refresh_failed');
      return res.data.results?.[0];
    },
    onMutate: async ({ postId }) => {
      // force 로 되살린 행은 세션 Set 에 남아 있어도 다시 catch-up·폰 보조 대상이어야 한다
      forgetPreviewRetryState(postId);
      const previous = queryClient.getQueryData<PreviewRow[]>(queryKey)?.find((p) => p.id === postId);
      await markFetching(postId);
      return { previous };
    },
    onError: (err, { postId }, context) => {
      // 되돌리기는 이 행만, 아직 낙관 상태일 때만 — 목록 스냅샷을 통째로 복원하면 폴링이 가져온 더 새로운 데이터를
      // 옛 상태로 덮는다. 서버가 처리했을 수도 있는 전송 실패는 onSettled 의 invalidate 가 진짜 상태로 맞춘다
      const prev = context?.previous;
      if (prev) {
        queryClient.setQueryData<PreviewRow[]>(queryKey, (old) =>
          old?.map((p) =>
            p.id === postId && p.preview_status === 'fetching'
              ? { ...p, preview_status: prev.preview_status, preview_claimed_at: prev.preview_claimed_at }
              : p,
          ),
        );
      }
      const message =
        err instanceof PreviewCooldownError
          ? '잠시 후 다시 시도해주세요'
          : err instanceof PreviewForbiddenError
            ? '미리보기를 다시 불러올 권한이 없어요'
            : '미리보기를 불러오지 못했어요';
      showToast('error', message);
    },
    onSuccess: (result) => {
      // 요청은 처리됐지만 결과는 제각각 — 성공 토스트는 ready 일 때만
      if (result?.status === 'ready') {
        showToast('success', '미리보기를 다시 불러왔어요');
        return;
      }
      if (result?.skipped === 'in_progress' || result?.status === 'fetching' || result?.status === 'pending') {
        // 다른 워커가 선점 중이거나 20 s 예산을 넘겨 백그라운드로 넘어갔다 — 낙관 fetching 그대로 두면 폴링이 채운다
        showToast('success', '이미 불러오는 중이에요');
        return;
      }
      // failed · unsupported · needs_client(폰 힌트로도 못 채움) · not_found
      showToast('error', '미리보기를 불러오지 못했어요');
    },
    onSettled: () => {
      // 성공·실패 모두 — 낙관 행과 전송 실패 뒤의 어긋남을 DB 상태로 맞춘다. 활동 피드도 제목이 바뀌었을 수 있다
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_ACTIVITY] });
    },
  });
}
