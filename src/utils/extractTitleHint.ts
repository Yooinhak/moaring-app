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
