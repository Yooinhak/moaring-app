/**
 * URL → 도메인 표시 정보 (파비콘 + 표시명).
 *
 * 파비콘은 Google S2 서비스(https://www.google.com/s2/favicons)로 조회 —
 * 어떤 도메인이든 동작하고 별도 브랜드 에셋 관리가 필요 없다.
 * 주요 서비스는 단축/서브도메인을 대표 도메인으로 정규화하고 한글 표시명을 매핑한다.
 * (예: youtu.be → youtube.com "YouTube", *.tistory.com → tistory.com "티스토리")
 *
 * 라벨은 서버 supabase/functions/link-preview/sites/* 의 siteName 과 의도적으로 같은 값을 유지한다
 * (Deno 와 Metro 가 파일을 공유할 수 없어 두 곳에 적는다 — 한쪽을 바꾸면 다른 쪽도 같이 바꿀 것).
 * 카드는 preview_site_name 이 있으면 그것을 우선 쓰고, 이 라벨은 서버 수집 전·실패 시의 도메인 카드용이다.
 */

export interface DomainInfo {
  /** www 제거된 원본 호스트명 */
  hostname: string;
  /** 표시용 이름 — 알려진 서비스는 브랜드명, 그 외엔 hostname */
  label: string;
  /** 파비콘 이미지 URL (64px PNG) */
  faviconUrl: string;
  /** 전용 앱이 있는 서비스 — 인앱 브라우저 대신 시스템에 넘겨 앱으로 연다 (utils/openLink) */
  opensInApp: boolean;
}

interface ServiceRule {
  test: (hostname: string) => boolean;
  /** 파비콘 조회용 대표 도메인 (미지정 시 hostname 그대로) */
  faviconDomain?: string;
  label: string;
  /**
   * 링크를 해당 서비스 앱으로 열지 여부.
   * 인앱 브라우저(SFSafariViewController·Custom Tabs)는 유니버설/앱 링크를 앱에 넘기지 않아
   * 앱이 설치돼 있어도 웹으로 열리고, 웹에선 로그인을 다시 요구하는 경우가 많다.
   */
  opensInApp?: boolean;
}

const SERVICE_RULES: ServiceRule[] = [
  {
    test: (h) => h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com'),
    faviconDomain: 'youtube.com',
    label: 'YouTube',
    opensInApp: true,
  },
  {
    test: (h) => h === 'instagram.com' || h.endsWith('.instagram.com'),
    faviconDomain: 'instagram.com',
    label: 'Instagram',
    opensInApp: true,
  },
  {
    test: (h) => h === 'blog.naver.com' || h === 'm.blog.naver.com',
    faviconDomain: 'blog.naver.com',
    label: '네이버 블로그',
  },
  {
    test: (h) => h === 'cafe.naver.com' || h === 'm.cafe.naver.com',
    faviconDomain: 'cafe.naver.com',
    label: '네이버 카페',
  },
  // 네이버는 서비스별 호스트가 모두 *.naver.com 이라 구체적 규칙을 범용 '네이버' 규칙보다 먼저 둔다 (find 는 첫 매치)
  {
    test: (h) => h === 'news.naver.com' || h.endsWith('.news.naver.com'),
    faviconDomain: 'news.naver.com',
    label: '네이버 뉴스',
  },
  {
    // naver.me 는 네이버 지도 앱의 공유 단축 링크가 대부분이라 지도로 분류한다 — 서버가 실제 목적지를 풀면 preview_site_name 이 우선
    test: (h) => h === 'map.naver.com' || h === 'm.map.naver.com' || h.endsWith('.place.naver.com') || h === 'naver.me',
    faviconDomain: 'map.naver.com',
    label: '네이버 지도',
  },
  {
    test: (h) =>
      h === 'smartstore.naver.com' ||
      h.endsWith('.smartstore.naver.com') ||
      h === 'brand.naver.com' ||
      h.endsWith('.brand.naver.com') ||
      h === 'shopping.naver.com' ||
      h.endsWith('.shopping.naver.com'),
    faviconDomain: 'smartstore.naver.com',
    label: '네이버 스마트스토어',
  },
  {
    test: (h) => h === 'naver.com' || h.endsWith('.naver.com'),
    faviconDomain: 'naver.com',
    label: '네이버',
  },
  {
    test: (h) => h.endsWith('.tistory.com'),
    faviconDomain: 'tistory.com',
    label: '티스토리',
  },
  {
    test: (h) => h === 'velog.io' || h.endsWith('.velog.io'),
    faviconDomain: 'velog.io',
    label: 'velog',
  },
  {
    test: (h) => h === 'brunch.co.kr',
    label: '브런치',
  },
  {
    test: (h) => h === 'x.com' || h === 'twitter.com' || h.endsWith('.twitter.com'),
    faviconDomain: 'x.com',
    label: 'X',
  },
  {
    test: (h) => h === 'threads.net' || h === 'threads.com' || h.endsWith('.threads.net'),
    faviconDomain: 'threads.net',
    label: 'Threads',
    opensInApp: true,
  },
  {
    test: (h) => h === 'facebook.com' || h.endsWith('.facebook.com') || h === 'fb.com',
    faviconDomain: 'facebook.com',
    label: 'Facebook',
  },
  {
    test: (h) => h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.github.io'),
    faviconDomain: 'github.com',
    label: 'GitHub',
  },
  {
    test: (h) => h === 'medium.com' || h.endsWith('.medium.com'),
    faviconDomain: 'medium.com',
    label: 'Medium',
  },
  {
    test: (h) => h === 'notion.so' || h === 'notion.site' || h.endsWith('.notion.site'),
    faviconDomain: 'notion.so',
    label: 'Notion',
  },
  {
    test: (h) => h === 'pinterest.com' || h.endsWith('.pinterest.com') || h === 'pin.it',
    faviconDomain: 'pinterest.com',
    label: 'Pinterest',
  },
  {
    // vm./vt.tiktok.com 은 앱이 공유하는 단축 링크. 영상 링크를 TikTok 앱이 직접 받아 열고, 인앱 브라우저에서는
    // 웹 플레이어 + 로그인 벽이라 YouTube·Instagram 과 같은 기준으로 앱에 넘긴다 (앱이 없으면 openLink 가 브라우저로 폴백)
    test: (h) => h === 'tiktok.com' || h.endsWith('.tiktok.com'),
    faviconDomain: 'tiktok.com',
    label: 'TikTok',
    opensInApp: true,
  },
  {
    // link.coupang.com 은 파트너스 단축 링크(302 → www.coupang.com/vp/products/…), m.coupang.com 은 모바일 웹.
    // 쿠팡 앱이 상품 링크를 받아 상품 화면을 바로 열고, 웹은 로그인·결제를 다시 요구하는 데다 봇 차단(Akamai)이
    // 심해 인앱 브라우저의 이점이 없다 → opensInApp. 앱이 없으면 openLink 가 Linking.openURL 로 기본 브라우저를 연다.
    test: (h) => h === 'coupang.com' || h.endsWith('.coupang.com'),
    faviconDomain: 'coupang.com',
    label: '쿠팡',
    opensInApp: true,
  },
  {
    // kko.to / kko.kakao.com 은 카카오맵 앱의 공유 단축 링크
    test: (h) => h === 'map.kakao.com' || h.endsWith('.map.kakao.com') || h === 'kko.to' || h === 'kko.kakao.com',
    faviconDomain: 'map.kakao.com',
    label: '카카오맵',
  },
  {
    test: (h) => h === 'daangn.com' || h.endsWith('.daangn.com'),
    faviconDomain: 'daangn.com',
    label: '당근',
  },
  {
    test: (h) => h === 'ohou.se' || h.endsWith('.ohou.se'),
    faviconDomain: 'ohou.se',
    label: '오늘의집',
  },
  {
    test: (h) => h === 'kurly.com' || h.endsWith('.kurly.com'),
    faviconDomain: 'kurly.com',
    label: '컬리',
  },
  {
    test: (h) => h === 'musinsa.com' || h.endsWith('.musinsa.com'),
    faviconDomain: 'musinsa.com',
    label: '무신사',
  },
  {
    test: (h) => h === '29cm.co.kr' || h.endsWith('.29cm.co.kr'),
    faviconDomain: '29cm.co.kr',
    label: '29CM',
  },
  {
    test: (h) => h === 'reddit.com' || h.endsWith('.reddit.com') || h === 'redd.it',
    faviconDomain: 'reddit.com',
    label: 'Reddit',
  },
  {
    test: (h) => h === 'linkedin.com' || h.endsWith('.linkedin.com') || h === 'lnkd.in',
    faviconDomain: 'linkedin.com',
    label: 'LinkedIn',
  },
];

function faviconServiceUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function getDomainInfo(url: string): DomainInfo | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }

  const rule = SERVICE_RULES.find((r) => r.test(hostname));
  const faviconDomain = rule?.faviconDomain ?? hostname;

  return {
    hostname,
    label: rule?.label ?? hostname,
    faviconUrl: faviconServiceUrl(faviconDomain),
    opensInApp: rule?.opensInApp ?? false,
  };
}
