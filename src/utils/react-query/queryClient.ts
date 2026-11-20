import { QueryCache, QueryClient } from '@tanstack/react-query';

import { notifyError } from '../toastBridge';

import { queryKeys } from './queryKeys';

/**
 * 조회 실패를 사용자에게 알린다.
 *
 * 훅마다 isError 를 따로 그리는 대신 여기서 한 번만 처리한다 — 안 그러면 쿼리가
 * throw 해도 화면에는 그냥 빈 목록으로 보인다(2026-07-23 감사에서 확인된 문제).
 *
 * 제외 대상:
 *  - METADATA: 저장 전 기기 메타 fetch 라 실패가 흔하고, 실패해도 저장·카드(DB 컬럼)에는 영향이 없다.
 *  - retry 진행 중인 실패는 여기 오지 않는다 — 최종 실패만 알린다.
 */
const NOISY_KEYS: readonly string[] = [queryKeys.METADATA];

let lastNotifiedAt = 0;
const NOTIFY_INTERVAL = 4000; // 여러 쿼리가 동시에 죽어도 토스트는 4초에 하나만

const queryCache = new QueryCache({
  onError: (_error, query) => {
    const head = query.queryKey[0];
    if (typeof head === 'string' && NOISY_KEYS.includes(head)) return;

    const now = Date.now();
    if (now - lastNotifiedAt < NOTIFY_INTERVAL) return;
    lastNotifiedAt = now;

    notifyError('불러오지 못했어요. 연결을 확인해주세요');
  },
});

export const queryClient = new QueryClient({
  queryCache,
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000, // 2분간 fresh 유지
      gcTime: 10 * 60 * 1000, // 10분간 캐시 보관
      retry: 2, // 실패 시 2회 재시도
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15000),
      // ⚠️ refetchOnWindowFocus 는 RN 에서 no-op 이다 (visibilitychange 이벤트가 없음).
      // 포그라운드 복귀·재연결 시 갱신하려면 focusManager/onlineManager 를 AppState·NetInfo 에
      // 배선해야 한다. 지금은 미배선이라 "되는 줄 알았는데 안 되는" 옵션을 두지 않는다.
    },
    mutations: {
      retry: 1,
    },
  },
});
