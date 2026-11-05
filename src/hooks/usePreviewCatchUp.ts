import { useEffect, useRef } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { parseOnDevice, toDeviceHints } from '../utils/parseMetadata';
import { requestPreviewAssist, requestPreviewBatch } from '../utils/preview/invoke';
import { type DeviceAssistHints, isTransientFailure, PREVIEW_FETCHING_WINDOW_MS } from '../utils/preview/types';
import { queryKeys } from '../utils/react-query/queryKeys';
import type { Tables } from '../utils/supabase/types';

/**
 * 폴더 catch-up — 미리보기(posts.preview_*) 의 유일한 백필·재시도 메커니즘.
 *
 * pg_cron 을 쓰지 않으므로, 저장 시점에 수집이 안 된 글(공유 시트 프로세스 kill·함수 미배포·일시 실패)은
 * 사용자가 그 폴더를 열 때 채운다. 기존 ~100행도 사용자가 폴더를 여는 순서대로 채워진다.
 *
 * 두 경로를 돈다.
 * (1) 서버 재수집: pending · 일시 failed(TRANSIENT_PREVIEW_ERRORS, attempts<3) · stale fetching(선점 2분 초과)
 *     → `mode:'fetch' post_ids` 8개씩 순차, 청크마다 목록 invalidate 해 먼저 끝난 카드부터 채운다.
 *     폴더당 배치 하나만 — 청크 invalidate 로 rows 가 바뀌어 효과가 다시 돌아도 앉은 배치가 끝날 때까지 새로 띄우지 않는다.
 *     끝나면 invalidate 로 rows 가 바뀌고 다음 평가가 남은 대상을 잇는다(그래야 FETCH_LIMIT_PER_RUN 이 동시 호출 수를 실제로 묶는다).
 * (2) 폰 보조(canEdit 만): 서버(데이터센터 IP)가 차단당한 needs_client 행을 폰의 주거용 IP 로 parseOnDevice 해
 *     `mode:'assist'` 로 제출한다. 결과가 전부 null 이어도 보낸다 — 서버가 그 행을 failed 로 종결해야
 *     다음 방문에 같은 글을 또 돌리지 않는다. 단 폰 쪽 타임아웃·화면 이탈로 끊긴 빈 결과는 "폰에서도 못 얻었다" 가 아니라
 *     보내지 않는다. viewer 는 서버가 403(forbidden) 을 주므로 애초에 시도하지 않는다.
 *
 * 무한 루프 방지는 두 겹: 모듈 스코프 Set(세션 중 같은 id 를 두 번 보내지 않음) + 서버 attempts 상한.
 * Set 은 서버에 닿은 요청만 기억한다 — 오프라인·세션 만료·함수 미배포로 전송 자체가 실패한 id 는 빼서 다음 평가에 다시 보내고,
 * 수동 재시도(useRefreshPreview)가 행을 되살리면 forgetPreviewRetryState 로 다시 대상이 되게 한다.
 * 에러 화면·토스트는 없다 — 어떤 상태에서도 카드는 도메인 카드로 멀쩡히 그려진다.
 */

/** 이 훅이 읽는 컬럼만 — usePostsQuery 의 전체 Row 는 물론, 같은 컬럼을 고른 다른 select 결과도 받을 수 있게 */
export type PreviewCatchUpRow = Pick<
  Tables<'posts'>,
  | 'id'
  | 'url'
  | 'created_at'
  | 'preview_status'
  | 'preview_error'
  | 'preview_attempts'
  | 'preview_claimed_at'
  | 'preview_provider'
>;

/** 한 배치에서 서버에 보낼 최대 id 수 (8개 청크 × 3). 나머지는 배치가 끝나 rows 가 바뀌면 다음 실행이 잇는다 */
const FETCH_LIMIT_PER_RUN = 24;
/** catch-up 이 자동 재시도하는 failed 의 attempts 상한 — claim_post_preview 의 `attempts < 3` 과 같다 */
const MAX_AUTO_RETRY_ATTEMPTS = 3;
/** stale fetching 재선점 상한 — claim_post_preview 의 `attempts < 5`(= 서버 BUDGET.maxAttempts). 넘으면 보내도 max_attempts 로 돌아온다 */
const SERVER_MAX_ATTEMPTS = 5;
/** 폰 보조는 한 실행에 8건 — 끝나면 invalidate 로 rows 가 바뀌어 다음 8건이 이어진다(카드가 점진적으로 채워짐) */
const ASSIST_LIMIT_PER_RUN = 8;
/** 폰 보조 동시성. 인스타 임베드 512 KB 를 폰에서 정규식으로 훑으므로 둘 이상 겹치지 않게 */
const ASSIST_CONCURRENCY = 2;
/** 저장 전 미리보기(4 s)보다 길게 — 화면이 떠 있는 동안 배경에서 돌고, 인스타 임베드는 느리다 */
const ASSIST_TIMEOUT_MS = 8000;

/**
 * 폰 fetch 로는 못 푸는 provider — 서버가 'needs:webview' 로 표시하지만, error 코드가 바뀌어도 걸러지게 provider 로도 막는다.
 * 쿠팡(Akamai 403, IP·헤더 무관)·네이버 플레이스(SPA 셸, 첫 요청부터 429) 는 v2 WebView 러너 몫.
 * 스마트스토어(naver_shop)는 설계대로 폰 fetch 1회를 시도한다 — 데이터센터 IP 의 429 가 주거용 IP 에서도 나오는지 미검증이고,
 * 실패하면 서버가 'needs:webview' 로 종결해 다시 보내지 않는다.
 * 서버 sites/*.ts 의 adapter.id 와 수동 동기.
 */
const WEBVIEW_ONLY_PROVIDERS = new Set(['coupang', 'naver_map']);

/** 세션 동안 서버 재수집을 요청한 id — 같은 글을 폴더를 열 때마다 다시 보내지 않는다 (서버 attempts 를 태우지 않게) */
const attempted = new Set<number>();
/** 세션 동안 폰 보조를 제출한(또는 제출 중인) id */
const assisted = new Set<number>();
/** 지금 (1) 서버 재수집 배치가 돌고 있는 folderId — 폴더당 하나만 띄운다 */
const fetchInFlight = new Set<string>();
/** 지금 (2) 폰 보조 묶음이 돌고 있는 folderId — ASSIST_CONCURRENCY 가 실제 동시 파싱 수가 되게 */
const assistInFlight = new Set<string>();

/**
 * 수동 재시도(useRefreshPreview.onMutate)가 부른다 — force 로 되살린 행은 이 세션에서 이미 보냈던 id 라도
 * 다시 catch-up·폰 보조 대상이 되어야 한다(안 그러면 force 가 needs_client 로 끝난 인스타 글이 세션 내내 도메인 카드로 남는다).
 */
export function forgetPreviewRetryState(postId: number): void {
  attempted.delete(postId);
  assisted.delete(postId);
}

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

/** (1) 서버 재수집 대상인가. unsupported(영구 실패)·ready·needs_client·차단성 failed 는 아니다 */
function isFetchTarget(row: PreviewCatchUpRow, now: number): boolean {
  switch (row.preview_status) {
    case 'pending':
      return true;
    case 'failed':
      return isTransientFailure(row.preview_error) && row.preview_attempts < MAX_AUTO_RETRY_ATTEMPTS;
    case 'fetching': {
      // claimed_at 이 없는 fetching 은 서버 claim 도 재선점하지 않으므로(null 비교) 보내도 in_progress 로 돌아온다
      const age = ageMs(row.preview_claimed_at, now);
      return age !== null && age > PREVIEW_FETCHING_WINDOW_MS && row.preview_attempts < SERVER_MAX_ATTEMPTS;
    }
    default:
      return false;
  }
}

/** (2) 폰 보조 대상인가. WebView 가 필요한 행은 v1 폰 fetch 로 못 푸니 건너뛴다(보내면 빈 결과로 failed 종결만 된다) */
function isAssistTarget(row: PreviewCatchUpRow): boolean {
  if (row.preview_status !== 'needs_client') return false;
  const error = row.preview_error ?? '';
  if (error.startsWith('needs:webview')) return false;
  if (row.preview_provider && WEBVIEW_ONLY_PROVIDERS.has(row.preview_provider)) return false;
  return true;
}

/** 최신 저장 우선 — 사용자가 방금 넣은 글이 먼저 채워져야 한다 (pick_preview_jobs 와 같은 순서) */
function newestFirst(a: PreviewCatchUpRow, b: PreviewCatchUpRow): number {
  return (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0);
}

/** 작은 동시성 리미터 — fn 은 reject 하지 않아야 한다(워커 하나가 죽으면 그 몫의 항목이 남는다) */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function assistOne(row: PreviewCatchUpRow, signal: AbortSignal): Promise<void> {
  try {
    const parsed = await parseOnDevice(row.url, { timeoutMs: ASSIST_TIMEOUT_MS, signal });
    if (signal.aborted || parsed.timedOut) {
      // 화면을 떠나며 끊겼거나 8 s 예산이 모자랐던 빈 결과는 "폰에서도 못 얻었다" 가 아니다 — 그대로 제출하면 서버가
      // failed(device_empty) 로 종결해 자동 재시도가 영영 멈추므로 보내지 않고 Set 에서도 빼서 다음 방문에 다시 시도하게 둔다
      assisted.delete(row.id);
      return;
    }
    // html 은 인스타 임베드 원문(≤256 K 문자) — 서버 instagram_embed 파서가 폰이 받은 그대로 다시 읽는다
    const hints: DeviceAssistHints = parsed.html
      ? { ...toDeviceHints(parsed), html: parsed.html }
      : toDeviceHints(parsed);
    const res = await requestPreviewAssist(row.id, hints);
    // 전송 실패(오프라인·세션 만료·함수 미배포)는 서버에 닿지 않았다 — 다음 평가에 다시 보낼 수 있게 푼다
    if (res.error) assisted.delete(row.id);
  } catch {
    // 알릴 실패가 아니다(카드는 도메인 카드). 서버에 닿은 게 아니니 세션 Set 에서 빼 다음 평가에 맡긴다
    assisted.delete(row.id);
  }
}

/**
 * FolderDetailScreen 에서 `usePreviewCatchUp(folderId, postList, canEdit)` 한 줄.
 * rows 가 바뀔 때마다(목록 갱신·3초 폴링) 다시 평가하지만, Set 덕에 새로 생긴 대상만 요청한다.
 * setState 가 없으므로 react-hooks/set-state-in-effect 와 무관하다.
 */
export function usePreviewCatchUp(
  folderId: string,
  rows: readonly PreviewCatchUpRow[] | undefined,
  canEdit: boolean,
): void {
  const queryClient = useQueryClient();
  // 마운트 수명의 중단 신호(폰 보조 fetch 용). rows 효과의 cleanup 에 두면 3초 폴링마다 effect 가 다시 돌아
  // 진행 중인 폰 보조가 끊기므로, 언마운트 때만 abort 하는 별도 효과로 쥔다
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = abortRef.current;
    if (!rows || rows.length === 0 || !controller) return;

    // 서버 요청은 화면을 떠나도 끊지 않는다 — 결과는 DB 에 남는다. invalidate 도 마운트 여부를 따지지 않는다:
    // 관찰자 없는 쿼리는 stale 표시만 되고(refetch 없음), 같은 폴더에 다시 들어와 있으면 그 화면이 바로 새 rows 를 받아
    // 남은 대상을 이어 보낸다. 활동 피드도 함께 — 저장 때 '도메인' 으로 그려진 피드 행이 채워진 뒤에도 그대로 남지 않게
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.POST_LIST, folderId] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_ACTIVITY] });
    };
    const now = Date.now();

    // (1) 서버 재수집 — 폴더당 배치 하나. 최신순 최대 24개, 8개씩 순차. 청크마다 invalidate
    if (!fetchInFlight.has(folderId)) {
      const fetchIds = [...rows]
        .sort(newestFirst)
        .filter((row) => !attempted.has(row.id) && isFetchTarget(row, now))
        .slice(0, FETCH_LIMIT_PER_RUN)
        .map((row) => row.id);
      if (fetchIds.length > 0) {
        fetchIds.forEach((id) => attempted.add(id));
        fetchInFlight.add(folderId);
        requestPreviewBatch(fetchIds, (result, ids) => {
          if (result.error) {
            // 전송 실패(오프라인·세션 만료·함수 미배포)면 배치는 여기서 멈춘다 — 이 청크와 그 뒤 id 는 서버에 닿지 않았으니
            // Set 에서 빼서 다음 평가에 다시 보내게 둔다(청크는 fetchIds 의 연속 구간이다)
            fetchIds.slice(fetchIds.indexOf(ids[0])).forEach((id) => attempted.delete(id));
            return;
          }
          invalidate();
        })
          .catch(() => {
            fetchIds.forEach((id) => attempted.delete(id));
          })
          .finally(() => {
            // 배치가 끝난 뒤 한 번 더 — 이 invalidate 로 rows 가 바뀌어 다음 평가가 남은 대상(25번째부터)을 잇는다
            fetchInFlight.delete(folderId);
            invalidate();
          });
      }
    }

    // (2) 폰 보조 — owner/editor 만, 폴더당 묶음 하나(동시 2). 끝나면 invalidate 1회
    if (canEdit && !assistInFlight.has(folderId)) {
      const assistRows = [...rows]
        .sort(newestFirst)
        .filter((row) => !assisted.has(row.id) && isAssistTarget(row))
        .slice(0, ASSIST_LIMIT_PER_RUN);
      if (assistRows.length > 0) {
        assistRows.forEach((row) => assisted.add(row.id));
        assistInFlight.add(folderId);
        mapWithConcurrency(assistRows, ASSIST_CONCURRENCY, (row) => assistOne(row, controller.signal))
          .catch(() => {})
          .finally(() => {
            assistInFlight.delete(folderId);
            invalidate();
          });
      }
    }
  }, [folderId, rows, canEdit, queryClient]);
}
