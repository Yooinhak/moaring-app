// 이미지 플레이스홀더 판정 (순수 모듈)
//
// 사이트가 "이미지 없음" 대신 자기 로고·기본 og 이미지를 내보내는 경우가 많다. 그걸 썸네일로 저장하면
// 같은 사이트의 글이 전부 똑같은 카드가 된다. 프로브(2026-11-04) 에서 실제로 본 것만 넣고, 사이트별 보정
// (Threads 아바타 등) 은 어댑터가 덧붙인다. 여기 없는 URL 은 후보로 두고 복사 단계(2xx + image/* + 매직바이트) 가 거른다.
//
// 주의: ssl.pstatic.net/static/maps/assets/images/og-map-400x200.png 은 네이버 지도 어댑터가 의도적으로 쓰는
// "지도 전용 허용 플레이스홀더" 라서 여기 넣지 않는다.

export const PLACEHOLDER_IMAGE_PATTERNS: RegExp[] = [
  // velog: 썸네일 없는 글은 전부 이 URL
  /^https?:\/\/images\.velog\.io\/velog\.png(?:[?#]|$)/i,
  // tistory: img1.daumcdn.net/thumb/…?fname=https%3A%2F%2Ft1.daumcdn.net%2Ftistory_admin%2Fstatic%2Fimages%2FopenGraph%2Fopengraph.png
  // (fname 안이라 '/' 가 %2F 로 인코딩돼 온다)
  /tistory_admin(?:\/|%2F)static(?:\/|%2F)images(?:\/|%2F)openGraph/i,
  // LinkedIn: 미디어 없는 글의 og:image 는 static.licdn.com 정적 자산
  /^https?:\/\/static\.licdn\.com\//i,
  // Notion 공개 페이지: og 가 전역 기본값 (제목도 'Notion')
  /^https?:\/\/(?:app\.notion\.com|www\.notion\.so|notion\.so)\/images\/meta\/default\.png/i,
  // X 404 페이지 og:image, 기본 프로필
  /^https?:\/\/abs\.twimg\.com\/x-web\/assets\/og\/default-og/i,
  /^https?:\/\/abs\.twimg\.com\/(?:sticky\/)?default_profile/i,
  // YouTube 전역 로고·썸네일 없음
  /^https?:\/\/www\.youtube\.com\/img\/desktop\/yt_1200\.png/i,
  /^https?:\/\/i\.ytimg\.com\/img\/no_thumbnail\.jpg/i,
  // Instagram·Threads 프로필 아바타 경로 (t51.82787-19 / t51.2885-19). 게시물 미디어는 -15 다.
  /\/t51\.(?:82787|2885)-19\//i,
  // Facebook 정적 자산
  /^https?:\/\/static\.xx\.fbcdn\.net\/rsrc\.php\//i,
  /^https?:\/\/www\.facebook\.com\/images\/fb_icon_\d+x\d+\.png/i,
];

/** 알려진 플레이스홀더 이미지면 true. null/빈 값은 false (후보가 아니라 "없음" 이므로). */
export function isPlaceholderImage(url: string | null | undefined): boolean {
  if (!url) return false;
  for (const re of PLACEHOLDER_IMAGE_PATTERNS) {
    if (re.test(url)) return true;
  }
  return false;
}
