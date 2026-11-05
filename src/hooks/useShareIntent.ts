import { useEffect, useState } from 'react';

import { useShareIntentContext } from 'expo-share-intent';

import { isValidUrl } from '../utils/validateUrl';

/** DB CHECK 는 300자(005 posts_preview_lengths_check)지만 카드 제목 한 줄엔 이 정도면 충분하다 */
const MAX_TITLE_HINT_CHARS = 200;
/** "ㄷ", "." 같은 한 글자 찌꺼기는 제목이 아니다 */
const MIN_TITLE_HINT_CHARS = 2;
/** 링크를 지운 자리에 남는 구분 기호("상품명 - ", "제목 | ") */
const EDGE_SEPARATORS = /^[\s\-–—|·:]+|[\s\-–—|·:]+$/g;

/**
 * 공유 텍스트에서 링크를 뺀 나머지를 제목 힌트로 만든다.
 *   "아비에무아 스웨터 https://link.coupang.com/a/xxx" → "아비에무아 스웨터"
 *
 * 쿠팡·스마트스토어처럼 서버(데이터센터 IP)도 폰도 페이지를 못 읽는 사이트는 이 힌트가 카드 제목이 될
 * 유일한 경로다. 서버는 자기가 읽은 제목이 비었을 때만 이 값을 쓴다(preview_source 'hint').
 *  - 뽑아낸 url 과 그 밖의 모든 http(s) 링크를 지운다 — 앱이 단축 링크와 원본 링크를 함께 넣기도 한다
 *  - 공백·줄바꿈을 한 칸으로 접고 양끝의 구분 기호를 떼어낸다
 *  - 2자 미만이면 null, 200자 넘으면 자른다(코드 포인트 단위 — 이모지를 반으로 가르지 않게)
 */
export function extractTitleHint(text: string | null | undefined, url: string | null | undefined): string | null {
  if (!text) return null;
  const withoutUrl = url ? text.split(url).join(' ') : text;
  const rest = withoutUrl
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_SEPARATORS, '');
  const chars = Array.from(rest);
  if (chars.length < MIN_TITLE_HINT_CHARS) return null;
  if (chars.length <= MAX_TITLE_HINT_CHARS) return rest;
  return chars.slice(0, MAX_TITLE_HINT_CHARS).join('').trim();
}

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

    const url = shareIntent.webUrl || shareIntent.text || '';

    if (!url || !isValidUrl(url)) {
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
