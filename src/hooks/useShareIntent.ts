import { useEffect, useState } from 'react';

import { useShareIntentContext } from 'expo-share-intent';

import { extractUrl } from '../utils/extractUrl';

/**
 * 외부 앱에서 공유받은 URL을 추출하여 반환합니다.
 *
 * 이전 버전은 자동으로 "가장 최근 폴더"에 저장했지만, 사용자가 폴더를 선택할
 * 기회가 없어 의도와 다른 폴더에 쌓이는 문제가 있었습니다 (A-12).
 *
 * 이제는 URL만 추출하여 `pendingUrl` 로 반환하고, 저장 로직은 호출하는 쪽
 * (HomeScreen)에서 폴더 선택 BottomSheet를 통해 처리합니다.
 *
 * 사용법:
 *   const { pendingUrl, clearPendingUrl } = useShareIntent();
 *   // pendingUrl이 있으면 → 폴더 선택 BottomSheet 오픈
 *   // 저장 완료 또는 취소 시 → clearPendingUrl() 호출
 */
export function useShareIntent() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;

    const url = extractUrl(shareIntent.webUrl || shareIntent.text);

    if (!url) {
      resetShareIntent();
      return;
    }

    setPendingUrl(url);
    resetShareIntent();
  }, [hasShareIntent]);

  const clearPendingUrl = () => setPendingUrl(null);

  return { pendingUrl, clearPendingUrl };
}
