import { useEffect, useState } from 'react';

import { useShareIntentContext } from 'expo-share-intent';

import { extractTitleHint } from '../utils/extractTitleHint';
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
 * `pendingTitleHint` 는 공유 텍스트에서 링크를 뺀 나머지("상품명 https://…" 의 상품명) —
 * SaveLinkSheet 가 posts.preview_title 힌트로 넘겨 서버가 제목을 못 읽는 사이트의 카드 제목이 된다.
 *
 * 사용법:
 *   const { pendingUrl, pendingTitleHint, clearPendingUrl } = useShareIntent();
 *   // pendingUrl이 있으면 → 폴더 선택 BottomSheet 오픈 (titleHint 로 pendingTitleHint 전달)
 *   // 저장 완료 또는 취소 시 → clearPendingUrl() 호출 (힌트도 함께 비워진다)
 */
export function useShareIntent() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [pendingTitleHint, setPendingTitleHint] = useState<string | null>(null);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;

    const url = extractUrl(shareIntent.webUrl || shareIntent.text);

    if (!url) {
      resetShareIntent();
      return;
    }

    // 네이티브 인텐트(외부 시스템)의 값을 React 상태로 옮기는 자리 — 바로 reset 하므로 연쇄 렌더는 1회다
    /* eslint-disable react-hooks/set-state-in-effect */
    setPendingUrl(url);
    setPendingTitleHint(extractTitleHint(shareIntent.text, url));
    /* eslint-enable react-hooks/set-state-in-effect */
    resetShareIntent();
    // resetShareIntent 는 컨텍스트가 매 렌더 새로 만드는 함수라 deps 에 넣으면 매 렌더 다시 돈다 — 새 인텐트 도착만 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent]);

  const clearPendingUrl = () => {
    setPendingUrl(null);
    setPendingTitleHint(null);
  };

  return { pendingUrl, pendingTitleHint, clearPendingUrl };
}
