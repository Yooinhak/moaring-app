// 네이버 어댑터 묶음 — 블로그 · 뉴스 · naver.me · 지도/플레이스 · 스마트스토어/쇼핑 · 카페
//
// 관측 근거 (2026-11-04 프로브, 주거용 IP·curl 기본 UA, Edge egress 미검증):
//   blog.naver.com/<id>/<logNo>       2.8 KB 프레임셋(og 0) → m.blog.naver.com/<id>/<logNo>(110 KB, og 완비) 로 재작성해 읽는다.
//                                     PostView.naver|.nhn?blogId&logNo 도 og 완비(257 KB) — 폴백. og:image blogthumb …?type=w2 는 쿼리 변경 금지(w800 → 404)
//   n.news.naver.com                  /article/·/mnews/article/ 동일 og. news.naver.com/main/read.naver?oid&aid 는 302 → 직접 재작성.
//                                     twitter:creator 가 언론사명(og 엔 없다)
//   naver.me                          지도 공유는 첫 307 Location 에 title=·pinId= (파라미터 순서 가변) → Location 만 읽고 확정, map.naver.com 은 안 간다.
//                                     신형은 /p/entry/place/<id>?placePath= 로 title 없음, 저장목록은 /v5/favorite/… → 폰 보조.
//                                     비지도 대상(mkt.naver.com 등) 은 3~5홉 → *.naver.com·naver.me·*.pstatic.net 안에서만 따라가 generic.
//                                     http:// 로 저장된 naver.me 는 https 로 가는 301 이 한 홉 더 든다
//   map.naver.com · *.place.naver.com 2.3 KB SPA 셸(og:title 없음), m.place·pcmap.place 는 첫 요청부터 429 → 서버 fetch 안 함
//   smartstore · brand                첫 요청부터 429 '시스템오류' 정적 페이지(etag 동일). m.smartstore 는 302 → 데스크톱. search.shopping 은 418 → 서버 fetch 안 함
//   cafe.naver.com/<cafe>/<id>        876 KB 프레임셋(og 0), charset=MS949(헤더)·KSC5601/euc-kr(meta) — <title> '중고나라 : 네이버 카페' 의 카페명만 얻는다.
//                                     m.cafe·ca-fe·f-e(2024 PC 개편 주소창 폼)·ArticleRead.nhn 전부 SPA 셸, 내부 article API 는 500 → 글 제목은 서버가 못 얻는다
//
// 네트워크는 ctx.io 만. 차단 사이트(지도·쇼핑) 는 serverFetch false 로 네트워크 0회 — 배포 후 추가 차단이 확인되면 플래그 1줄로 전환.
// 공유 텍스트 힌트(ctx.hintTitle) 는 라벨만 만들 수 있는 곳(카페·쇼핑·지도) 에서 라벨보다 우선한다 — 네이버 앱 공유 텍스트는 보통 글 제목을 싣는다.

import { canonicalize, matchesHost, parseHttpUrl, pathSegments } from '../canonical.ts';
import { getMeta, normalizeText, parseTags } from '../html.ts';
import type { PickedFields } from '../html.ts';
import { BUDGET, FIELD_LIMITS } from '../types.ts';
import type {
  CanonicalResult,
  HostPattern,
  PreviewFields,
  PreviewSource,
  ProviderCtx,
  ProviderOutcome,
  ResolveRedirectsResult,
  SiteAdapter,
} from '../types.ts';
import {
  emptyFields,
  errorCode,
  failed,
  fetchPage,
  finalizeGeneric,
  isOk,
  needsClient,
  parseGenericSubmitted,
  ready,
  remainingMs,
  runGeneric,
  unsupported,
} from './generic.ts';

/** 지도 어댑터가 의도적으로 쓰는 "지도 전용 허용 플레이스홀더" — placeholders.ts 에 넣지 않은 이유다. */
export const NAVER_MAP_OG_IMAGE = 'https://ssl.pstatic.net/static/maps/assets/images/og-map-400x200.png';
/** naver.me 와 generic 위임 때 리다이렉트가 갈 수 있는 곳. 지도 공유가 호스트를 3번 바꾼다. */
export const NAVER_HOP_HOSTS: HostPattern[] = ['*.naver.com', 'naver.me', '*.pstatic.net'];
/** 블로그 blogthumb/postfiles·뉴스 imgnews·쇼핑 shop-phinf·지도 ssl — 전부 pstatic.net. 폰이 제출한 image_url 도 여기 맞아야 한다. */
const NAVER_IMAGE_HOSTS: RegExp[] = [/(?:^|\.)pstatic\.net$/i, /(?:^|\.)naver\.net$/i];
const DIGITS_RE = /^\d+$/;

function refFromCtx<T>(ctx: ProviderCtx, parse: (u: URL) => T | null): T | null {
  for (const s of [ctx.postUrl, ctx.fetchUrl, ctx.canonicalUrl]) {
    const u = parseHttpUrl(s);
    const r = u ? parse(u) : null;
    if (r) return r;
  }
  return null;
}

function digitsParam(u: URL, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = u.searchParams.get(k);
    if (v && DIGITS_RE.test(v)) return v;
  }
  return null;
}

/** 폰 제출 HTML 은 generic 규칙으로 읽고 사이트 라벨만 덧씌운다. */
function submittedWith(overrides: (f: PreviewFields, u: URL | null) => Partial<PreviewFields>) {
  return (html: string, finalUrl: string): PreviewFields | null => {
    const base = parseGenericSubmitted(html, finalUrl);
    return base ? { ...base, ...overrides(base, parseHttpUrl(finalUrl)) } : null;
  };
}

// ---------------------------------------------------------------------------
// (a) 블로그
// ---------------------------------------------------------------------------

const BLOG_ID_RE = /^[A-Za-z0-9_-]{2,}$/;
const LOGNO_RE = /^\d{6,}$/;

export interface NaverBlogRef {
  blogId: string;
  logNo: string;
}

/** blog.naver.com/<id>/<logNo> · PostView.naver|nhn?blogId&logNo · m.blog 동일 · 구형 /<id>?logNo=. 글이 아닌 블로그 홈은 null(generic). */
export function parseNaverBlogUrl(u: URL): NaverBlogRef | null {
  if (u.hostname !== 'blog.naver.com' && u.hostname !== 'm.blog.naver.com') return null;
  const segs = pathSegments(u);
  const first = (segs[0] ?? '').toLowerCase();
  if (first === 'postview.naver' || first === 'postview.nhn') {
    const blogId = u.searchParams.get('blogId');
    const logNo = u.searchParams.get('logNo');
    return blogId && logNo && BLOG_ID_RE.test(blogId) && LOGNO_RE.test(logNo) ? { blogId, logNo } : null;
  }
  if (segs.length >= 2 && BLOG_ID_RE.test(segs[0]) && LOGNO_RE.test(segs[1]))
    return { blogId: segs[0], logNo: segs[1] };
  const logNo = u.searchParams.get('logNo');
  if (segs.length === 1 && BLOG_ID_RE.test(segs[0]) && logNo && LOGNO_RE.test(logNo)) return { blogId: segs[0], logNo };
  return null;
}

export const naverBlogMobileUrl = (r: NaverBlogRef): string => `https://m.blog.naver.com/${r.blogId}/${r.logNo}`;
export const naverBlogPostViewUrl = (r: NaverBlogRef): string =>
  `https://blog.naver.com/PostView.naver?blogId=${r.blogId}&logNo=${r.logNo}`;
export const naverBlogCanonical = (r: NaverBlogRef): string => `https://blog.naver.com/${r.blogId}/${r.logNo}`;

async function runNaverBlog(ctx: ProviderCtx, ref: NaverBlogRef): Promise<ProviderOutcome> {
  const canonicalUrl = naverBlogCanonical(ref);
  const overrides = (f: PickedFields): Partial<PreviewFields> => ({
    author: f.author ?? ref.blogId, // 블로그 og 엔 작성자가 없다 — blogId 가 곧 블로거 식별자
    siteName: '네이버 블로그',
    canonicalUrl, // og:url 도 같은 값이지만 m.blog 폼이 올 수 있어 고정
  });

  // og 제목으로만 판정한다 — 프레임셋도 블로그 수준 <title>('… : 네이버 블로그') 은 갖고 있어 isUsefulMeta 로는 못 가른다
  const first = await fetchPage(ctx, { url: naverBlogMobileUrl(ref), hopAllow: NAVER_HOP_HOSTS });
  if (!first.done && (first.page.fields.raw.ogTitle ?? first.page.fields.raw.twitterTitle)) {
    return finalizeGeneric(ctx, first.page, overrides(first.page.fields));
  }
  if (first.done && first.outcome.kind === 'unsupported') return first.outcome; // 삭제된 글은 데스크톱도 같다

  // m.blog 가 og 없이 왔거나(비공개·서로이웃 추정) 네트워크 오류 → PostView 데스크톱 1회
  const reason = first.done ? ('error' in first.outcome ? first.outcome.error : first.outcome.kind) : 'no_og';
  ctx.log('naver_blog.postview_fallback', { reason });
  const second = await fetchPage(ctx, { url: naverBlogPostViewUrl(ref), hopAllow: NAVER_HOP_HOSTS });
  if (second.done) return second.outcome;
  return finalizeGeneric(ctx, second.page, overrides(second.page.fields));
}

export const naverBlogAdapter: SiteAdapter = {
  id: 'naver_blog',
  serverFetch: true,
  imageHosts: NAVER_IMAGE_HOSTS,
  match: (u) => parseNaverBlogUrl(u) !== null,
  canonicalize(u: URL): CanonicalResult {
    const r = parseNaverBlogUrl(u);
    return r ? { fetchUrl: naverBlogMobileUrl(r), canonicalUrl: naverBlogCanonical(r) } : canonicalize(u);
  },
  run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const r = refFromCtx(ctx, parseNaverBlogUrl);
    return r ? runNaverBlog(ctx, r) : runGeneric(ctx, { hopAllow: NAVER_HOP_HOSTS });
  },
  parseSubmitted: submittedWith((f, u) => {
    const r = u ? parseNaverBlogUrl(u) : null;
    return {
      author: f.author ?? r?.blogId ?? null,
      siteName: '네이버 블로그',
      canonicalUrl: r ? naverBlogCanonical(r) : f.canonicalUrl,
    };
  }),
};

// ---------------------------------------------------------------------------
// (b) 뉴스
// ---------------------------------------------------------------------------

export interface NaverNewsRef {
  oid: string;
  aid: string;
}

/** n.news.naver.com/(mnews/)article/<oid>/<aid> · news.naver.com/main/read.naver|nhn?oid&aid. 댓글·연예·스포츠 호스트는 null(generic). */
export function parseNaverNewsUrl(u: URL): NaverNewsRef | null {
  if (!/^(?:n\.|m\.)?news\.naver\.com$/.test(u.hostname)) return null;
  const segs = pathSegments(u);
  const i = segs.indexOf('article');
  if (i >= 0 && i <= 1 && DIGITS_RE.test(segs[i + 1] ?? '') && DIGITS_RE.test(segs[i + 2] ?? '')) {
    return { oid: segs[i + 1], aid: segs[i + 2] };
  }
  const last = (segs[segs.length - 1] ?? '').toLowerCase();
  if (last === 'read.naver' || last === 'read.nhn') {
    const oid = digitsParam(u, 'oid');
    const aid = digitsParam(u, 'aid');
    if (oid && aid) return { oid, aid };
  }
  return null;
}

export const naverNewsCanonical = (r: NaverNewsRef): string =>
  `https://n.news.naver.com/mnews/article/${r.oid}/${r.aid}`;

async function runNaverNews(ctx: ProviderCtx, ref: NaverNewsRef): Promise<ProviderOutcome> {
  const canonicalUrl = naverNewsCanonical(ref);
  const page = await fetchPage(ctx, { url: canonicalUrl, hopAllow: NAVER_HOP_HOSTS });
  if (page.done) return page.outcome;
  const { fields, tags } = page.page;
  return finalizeGeneric(ctx, page.page, {
    author: getMeta(tags, 'twitter:creator') ?? fields.author,
    siteName: fields.siteName ?? '네이버 뉴스',
    canonicalUrl,
  });
}

export const naverNewsAdapter: SiteAdapter = {
  id: 'naver_news',
  serverFetch: true,
  imageHosts: NAVER_IMAGE_HOSTS,
  match: (u) => parseNaverNewsUrl(u) !== null,
  canonicalize(u: URL): CanonicalResult {
    const r = parseNaverNewsUrl(u);
    if (!r) return canonicalize(u);
    const c = naverNewsCanonical(r);
    return { fetchUrl: c, canonicalUrl: c };
  },
  run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const r = refFromCtx(ctx, parseNaverNewsUrl);
    return r ? runNaverNews(ctx, r) : runGeneric(ctx, { hopAllow: NAVER_HOP_HOSTS });
  },
  parseSubmitted: submittedWith((f) => ({ siteName: f.siteName ?? '네이버 뉴스' })),
};

// ---------------------------------------------------------------------------
// (d) 지도 / 플레이스 — 서버 fetch 없음
// ---------------------------------------------------------------------------

const MAP_HOST_RE = /^(?:m\.)?map\.naver\.com$|(?:^|\.)place\.naver\.com$/;
const PLACE_PATH_RES: RegExp[] = [
  /^\/p\/entry\/place\/(\d+)/,
  /^\/p\/search\/[^/]+\/place\/(\d+)/,
  /^\/v5\/entry\/place\/(\d+)/,
  /^\/v5\/search\/[^/]+\/place\/(\d+)/,
];

export function isNaverMapHost(hostname: string): boolean {
  return MAP_HOST_RE.test(hostname);
}

/** pinId= · /p/entry/place/<id> · /v5/… · place 호스트의 /restaurant|place|…/<id>/home. 저장목록(favorite) 은 null. */
export function extractNaverPlaceId(u: URL): string | null {
  if (!isNaverMapHost(u.hostname)) return null;
  const pin = digitsParam(u, 'pinId');
  if (pin) return pin;
  for (const re of PLACE_PATH_RES) {
    const m = re.exec(u.pathname);
    if (m) return m[1];
  }
  if (/(?:^|\.)place\.naver\.com$/.test(u.hostname)) {
    const segs = pathSegments(u);
    if (segs.length >= 2 && DIGITS_RE.test(segs[1])) return segs[1];
  }
  return null;
}

export const naverPlaceCanonical = (placeId: string): string => `https://map.naver.com/p/entry/place/${placeId}`;

export interface NaverMapTarget {
  placeId: string | null;
  /** Location 의 title= (구형 공유만). 있으면 그 자리에서 ready. */
  title: string | null;
  canonicalUrl: string;
  /** 제목 없는 저장목록 공유의 라벨. */
  label: string | null;
}

/** map.naver.com 계열 URL(주로 naver.me 의 Location) 해석. title= 디코드는 URLSearchParams 가 한다(파라미터 순서 가변). */
export function interpretNaverMapUrl(u: URL): NaverMapTarget | null {
  if (!isNaverMapHost(u.hostname)) return null;
  const placeId = extractNaverPlaceId(u);
  const rawTitle = u.searchParams.get('title');
  const title = rawTitle ? normalizeText(rawTitle, FIELD_LIMITS.title, { singleLine: true }) : null;
  return {
    placeId,
    title,
    canonicalUrl: placeId ? naverPlaceCanonical(placeId) : canonicalize(u).canonicalUrl,
    label: /\/favorite\//.test(u.pathname) ? '네이버 지도 저장 목록' : null,
  };
}

/** 제목이 확정됐으면 ready, 아니면 같은 필드(브랜드 카드) + needs:webview. 지도 og 이미지는 늘 후보로 둔다. */
function naverMapOutcome(ctx: ProviderCtx, t: NaverMapTarget, source: PreviewSource): ProviderOutcome {
  const fields = emptyFields({
    title: t.title ?? ctx.hintTitle ?? t.label,
    siteName: '네이버 지도',
    canonicalUrl: t.canonicalUrl,
    imageCandidates: [NAVER_MAP_OG_IMAGE],
  });
  if (t.title) return ready(fields, source);
  return needsClient('needs:webview', t.canonicalUrl, 'webview', 'generic', fields);
}

export const naverMapAdapter: SiteAdapter = {
  id: 'naver_map',
  serverFetch: false,
  imageHosts: NAVER_IMAGE_HOSTS,
  match: (u) => isNaverMapHost(u.hostname),
  canonicalize(u: URL): CanonicalResult {
    const t = interpretNaverMapUrl(u);
    const c = t ? t.canonicalUrl : canonicalize(u).canonicalUrl;
    return { fetchUrl: c, canonicalUrl: c };
  },
  run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const t = refFromCtx(ctx, interpretNaverMapUrl) ?? {
      placeId: null,
      title: null,
      canonicalUrl: ctx.canonicalUrl,
      label: null,
    };
    // 직접 저장된 지도 URL 의 title= 은 URL 자체에서 온 제목이라 'slug'
    return Promise.resolve(naverMapOutcome(ctx, t, 'slug'));
  },
  parseSubmitted: submittedWith((f) => ({ siteName: '네이버 지도', imageCandidates: f.imageCandidates })),
};

// ---------------------------------------------------------------------------
// (e) 스마트스토어 / 브랜드스토어 / 쇼핑 — 서버 fetch 없음
// ---------------------------------------------------------------------------

const SHOP_HOST_RE = /^(?:m\.)?(?:smartstore|brand)\.naver\.com$|^(?:m\.|msearch\.|search\.)?shopping\.naver\.com$/;
const STORE_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface NaverShopRef {
  /** 스토어 플랫폼 호스트(m. 제거). shopping·search.shopping 은 null. */
  storeHost: string | null;
  storeId: string | null;
  productId: string | null;
  canonicalUrl: string;
  siteName: string;
}

/** smartstore|brand.naver.com/<storeId>/products/<pid> (m. 은 데스크톱으로) · shopping·search.shopping 은 추적 파라미터만 제거. */
export function parseNaverShopUrl(u: URL): NaverShopRef | null {
  if (!SHOP_HOST_RE.test(u.hostname)) return null;
  const host = u.hostname.replace(/^m\./, '');
  if (host === 'smartstore.naver.com' || host === 'brand.naver.com') {
    const segs = pathSegments(u);
    const storeId = segs[0] && STORE_ID_RE.test(segs[0]) ? segs[0] : null;
    const productId = segs[1] === 'products' && segs[2] && DIGITS_RE.test(segs[2]) ? segs[2] : null;
    let canonicalUrl: string;
    if (storeId && productId) canonicalUrl = `https://${host}/${storeId}/products/${productId}`;
    else {
      const desktop = new URL(u.href);
      desktop.hostname = host;
      canonicalUrl = canonicalize(desktop).canonicalUrl;
    }
    return { storeHost: host, storeId, productId, canonicalUrl, siteName: '네이버 스마트스토어' };
  }
  return {
    storeHost: null,
    storeId: null,
    productId: null,
    canonicalUrl: canonicalize(u).canonicalUrl,
    siteName: '네이버 쇼핑',
  };
}

/** 브랜드 카드 + 폰 fetch 과제. 폰 fetch 가 통과하는지는 미검증 — 실패하면 폰이 'needs:webview' 로 넘긴다. */
function naverShopOutcome(ctx: ProviderCtx, ref: NaverShopRef): ProviderOutcome {
  const fallback = ref.storeId
    ? ref.productId
      ? `${ref.storeId} 스토어 상품`
      : `${ref.storeId} 스토어`
    : '네이버 쇼핑 상품';
  const fields = emptyFields({
    title: ctx.hintTitle ?? fallback,
    siteName: ref.siteName,
    canonicalUrl: ref.canonicalUrl,
  });
  return needsClient('blocked:naver_shop', ref.canonicalUrl, 'fetch', 'generic', fields);
}

export const naverShopAdapter: SiteAdapter = {
  id: 'naver_shop',
  serverFetch: false,
  imageHosts: NAVER_IMAGE_HOSTS,
  match: (u) => parseNaverShopUrl(u) !== null,
  canonicalize(u: URL): CanonicalResult {
    const r = parseNaverShopUrl(u);
    const c = r ? r.canonicalUrl : canonicalize(u).canonicalUrl;
    return { fetchUrl: c, canonicalUrl: c };
  },
  run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const r = refFromCtx(ctx, parseNaverShopUrl);
    if (!r) return Promise.resolve(needsClient('blocked:naver_shop', ctx.canonicalUrl, 'fetch', 'generic'));
    return Promise.resolve(naverShopOutcome(ctx, r));
  },
  parseSubmitted: submittedWith((f, u) => {
    const r = u ? parseNaverShopUrl(u) : null;
    return { siteName: r?.siteName ?? f.siteName ?? '네이버 스마트스토어' };
  }),
};

// ---------------------------------------------------------------------------
// (f) 카페 — 카페명만 (글 제목은 어떤 폼에도 없다)
// ---------------------------------------------------------------------------

const CAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;
/**
 * 카페명 자리에 올 수 없는 서비스 경로(소문자). ca-fe·f-e 는 앞 분기가 먹고 .nhn·.naver 는 CAFE_NAME_RE 도 못 통과하지만,
 * 'f-e' 가 카페명으로 읽혀 모든 개편 글이 canonical 'https://cafe.naver.com/f-e' 하나로 묶이던 사고가 있어 명시해 둔다.
 */
const CAFE_RESERVED_FIRST = new Set([
  'ca-fe',
  'f-e',
  'articleread.nhn',
  'articleread.naver',
  'articlelist.nhn',
  'articlelist.naver',
  'mycafeintro.nhn',
  'mycafeintro.naver',
  'cafemain.nhn',
  'cafemain.naver',
]);

export interface NaverCafeRef {
  cafeName: string | null;
  /** 숫자 clubid (ArticleRead.nhn·ca-fe|f-e/cafes/<clubid>) — 카페명을 모르면 fetch 할 주소가 없다 */
  clubId: string | null;
  articleId: string | null;
  canonicalUrl: string;
}

function articleParams(u: URL): { clubId: string | null; articleId: string | null } {
  return { clubId: digitsParam(u, 'clubid', 'clubId'), articleId: digitsParam(u, 'articleid', 'articleId') };
}

/**
 * cafe.naver.com/<cafe>/<id> · m.cafe …/ca-fe/web/cafes/<cafe>/articles/<id> · /ca-fe/cafes/<clubid>/articles/<id> ·
 * /f-e/cafes/<clubid>/articles/<id>(2024 PC 개편 주소창 폼, ?boardtype=L&menuid=…) · ArticleRead.nhn?clubid&articleid ·
 * 데스크톱 공유 폼 /<cafe>?iframe_url=/ArticleRead.nhn%3Fclubid%3D…%26articleid%3D…
 *
 * 글로 식별된 경우만 canonical 을 글 단위로 모은다. 카페 홈·게시판·모르는 폼은 원 URL(데스크톱 호스트, 추적 파라미터만 제거) 을
 * 그대로 canonical 로 둔다 — 글 식별에 실패한 서로 다른 URL 이 '/<cafe>' 하나로 묶이면 canonical 재활용(process.ts findDonor) 이
 * 한 글의 힌트 제목을 다른 글에 물려주기 때문이다.
 */
export function parseNaverCafeUrl(u: URL): NaverCafeRef | null {
  if (u.hostname !== 'cafe.naver.com' && u.hostname !== 'm.cafe.naver.com') return null;
  const segs = pathSegments(u);
  const first = (segs[0] ?? '').toLowerCase();
  let cafeName: string | null = null;
  let clubId: string | null = null;
  let articleId: string | null = null;

  if (first === 'ca-fe' || first === 'f-e') {
    const i = segs.indexOf('cafes');
    const who = i >= 0 ? segs[i + 1] : undefined;
    if (who) {
      if (DIGITS_RE.test(who)) clubId = who;
      else if (CAFE_NAME_RE.test(who)) cafeName = who;
    }
    const art = i >= 0 && segs[i + 2] === 'articles' ? segs[i + 3] : undefined;
    if (art && DIGITS_RE.test(art)) articleId = art;
  } else if (first === 'articleread.nhn' || first === 'articleread.naver') {
    ({ clubId, articleId } = articleParams(u));
  } else if (segs.length >= 1 && CAFE_NAME_RE.test(segs[0]) && !CAFE_RESERVED_FIRST.has(first)) {
    cafeName = segs[0];
    const second = (segs[1] ?? '').toLowerCase();
    if (segs[1] && DIGITS_RE.test(segs[1])) articleId = segs[1];
    else if (second === 'articleread.nhn' || second === 'articleread.naver') {
      ({ clubId, articleId } = articleParams(u));
    } else {
      const iframe = u.searchParams.get('iframe_url') ?? u.searchParams.get('iframe_url_utf8');
      if (iframe) {
        try {
          ({ clubId, articleId } = articleParams(new URL(iframe, 'https://cafe.naver.com/')));
        } catch {
          // iframe_url 이 URL 이 아니면 카페 홈으로 취급
        }
      }
    }
  }
  if (!cafeName && !clubId) return null;

  let canonicalUrl: string;
  if (cafeName && articleId) canonicalUrl = `https://cafe.naver.com/${cafeName}/${articleId}`;
  else if (clubId && articleId) canonicalUrl = `https://cafe.naver.com/ca-fe/cafes/${clubId}/articles/${articleId}`;
  else {
    // 글이 아니다 — 호스트만 데스크톱으로 통일하고 경로·쿼리는 남겨 URL 마다 canonical 이 다르게 한다
    const desktop = new URL(u.href);
    desktop.hostname = 'cafe.naver.com';
    canonicalUrl = canonicalize(desktop).canonicalUrl;
  }
  return { cafeName, clubId, articleId, canonicalUrl };
}

/** '중고나라 : 네이버 카페' → '중고나라'. 카페명 없이 서비스명만이면 null. */
export function cafeNameFromTitle(title: string | null): string | null {
  if (!title) return null;
  const m = /^(.*?)\s*:\s*네이버\s*카페\s*$/.exec(title);
  const name = (m ? m[1] : title).trim();
  return name && name !== '네이버 카페' ? name : null;
}

/**
 * 라벨 카드. 데스크톱 프레임셋의 <title> 만 64 KB 캡·조기중단으로 읽는다 (euc-kr 디코드는 fetch.ts). 실패해도 URL 의 카페명으로 ready.
 * 카페명도 글 id 도 없으면(f-e 게시판 등) 제목 null 의 도메인 카드 — '네이버 카페 글' 이라 부를 수 없고, 제목 없는 ready 는 재활용 대상도 아니다.
 */
async function runNaverCafe(ctx: ProviderCtx, ref: NaverCafeRef): Promise<ProviderOutcome> {
  let cafeDisplay: string | null = null;
  if (ref.cafeName) {
    const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
    if (timeoutMs > 0) {
      try {
        const res = await ctx.io.fetchText(ref.canonicalUrl, {
          maxBytes: 64 * 1024,
          timeoutMs,
          stopAtHead: true,
          hopAllow: NAVER_HOP_HOSTS,
          maxHops: 3,
        });
        if (isOk(res.status) && res.text) cafeDisplay = cafeNameFromTitle(parseTags(res.text).title);
        else ctx.log('naver_cafe.title_unavailable', { status: res.status });
      } catch (e) {
        ctx.log('naver_cafe.fetch_failed', { error: errorCode(e) });
      }
    }
  }
  const name = cafeDisplay ?? ref.cafeName;
  const fallback = name ? (ref.articleId ? `${name} 글` : name) : ref.articleId ? '네이버 카페 글' : null;
  const fields = emptyFields({
    title: ctx.hintTitle ?? fallback,
    siteName: '네이버 카페',
    canonicalUrl: ref.canonicalUrl,
  });
  return ready(fields, ctx.hintTitle ? 'hint' : 'og');
}

export const naverCafeAdapter: SiteAdapter = {
  id: 'naver_cafe',
  serverFetch: true,
  imageHosts: NAVER_IMAGE_HOSTS,
  match: (u) => parseNaverCafeUrl(u) !== null,
  canonicalize(u: URL): CanonicalResult {
    const r = parseNaverCafeUrl(u);
    const c = r ? r.canonicalUrl : canonicalize(u).canonicalUrl;
    return { fetchUrl: c, canonicalUrl: c };
  },
  run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const r = refFromCtx(ctx, parseNaverCafeUrl);
    return r ? runNaverCafe(ctx, r) : runGeneric(ctx, { hopAllow: NAVER_HOP_HOSTS });
  },
  parseSubmitted: submittedWith(() => ({ siteName: '네이버 카페' })),
};

// ---------------------------------------------------------------------------
// (c) naver.me — Location 1홉으로 분류, 그 뒤는 위 어댑터들로 위임
// ---------------------------------------------------------------------------

/** 알려진 네이버 서비스 URL 이면 해당 처리로. 모르는 네이버 URL 은 null (generic). */
function runKnownNaver(ctx: ProviderCtx, u: URL): Promise<ProviderOutcome> | null {
  const map = interpretNaverMapUrl(u);
  if (map) return Promise.resolve(naverMapOutcome(ctx, map, 'redirect'));
  const blog = parseNaverBlogUrl(u);
  if (blog) return runNaverBlog(ctx, blog);
  const news = parseNaverNewsUrl(u);
  if (news) return runNaverNews(ctx, news);
  const shop = parseNaverShopUrl(u);
  if (shop) return Promise.resolve(naverShopOutcome(ctx, shop));
  const cafe = parseNaverCafeUrl(u);
  if (cafe) return runNaverCafe(ctx, cafe);
  return null;
}

async function dispatchNaverUrl(ctx: ProviderCtx, url: string, hopsLeft: number): Promise<ProviderOutcome> {
  const u = parseHttpUrl(url);
  if (!u) return failed('redirect_invalid');
  const known = runKnownNaver(ctx, u);
  if (known) return known;
  if (!matchesHost(u.hostname, NAVER_HOP_HOSTS)) return unsupported('offsite_redirect');

  const c = canonicalize(u);
  const next: ProviderCtx = { ...ctx, fetchUrl: c.fetchUrl, canonicalUrl: c.canonicalUrl };
  if (hopsLeft <= 0) return runGeneric(next, { hopAllow: NAVER_HOP_HOSTS, maxHops: 1 });

  // 남은 홉은 본문 없이 따라가 최종 URL 을 다시 분류한다 (mkt.naver.com 3홉, http→https 뒤 지도 등)
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return failed('timeout');
  let r: ResolveRedirectsResult;
  try {
    r = await ctx.io.resolveRedirects(u.href, { maxHops: hopsLeft, hopAllow: NAVER_HOP_HOSTS, timeoutMs });
  } catch (e) {
    return failed(errorCode(e));
  }
  // 중간 홉에 title= 을 실은 지도 URL 이 있었으면 그게 정답 (최종 /p/entry/place/<id> 엔 제목이 없다)
  for (const hop of [...r.hops, r.final]) {
    const hu = parseHttpUrl(hop);
    const m = hu ? interpretNaverMapUrl(hu) : null;
    if (m?.title) return naverMapOutcome(ctx, m, 'redirect');
  }
  const fu = parseHttpUrl(r.final);
  if (!fu) return failed('redirect_invalid');
  if (fu.href !== u.href) {
    const known2 = runKnownNaver(ctx, fu);
    if (known2) return known2;
    if (!matchesHost(fu.hostname, NAVER_HOP_HOSTS)) return unsupported('offsite_redirect');
  }
  const fc = canonicalize(fu);
  return runGeneric(
    { ...ctx, fetchUrl: fc.fetchUrl, canonicalUrl: fc.canonicalUrl },
    { hopAllow: NAVER_HOP_HOSTS, maxHops: 1 },
  );
}

export const naverMeAdapter: SiteAdapter = {
  id: 'naver_me',
  serverFetch: true,
  imageHosts: NAVER_IMAGE_HOSTS,
  match: (u) => u.hostname === 'naver.me' && pathSegments(u).length > 0,
  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
    if (timeoutMs <= 0) return failed('timeout');
    let first: ResolveRedirectsResult;
    try {
      first = await ctx.io.resolveRedirects(ctx.fetchUrl, {
        maxHops: 1,
        firstHopOnly: true,
        hopAllow: NAVER_HOP_HOSTS,
        timeoutMs,
      });
    } catch (e) {
      return failed(errorCode(e));
    }
    // 리다이렉트가 아니었다(미관측) — 상태코드 게이트까지 generic 에 맡긴다
    if (!first.firstLocation) return runGeneric(ctx, { hopAllow: NAVER_HOP_HOSTS });
    return dispatchNaverUrl(ctx, first.firstLocation, 5);
  },
  parseSubmitted: parseGenericSubmitted,
};

/** 레지스트리(T6) 용. naver.me 가 먼저 — 다른 어댑터의 호스트와 겹치지 않아 순서 자체는 중요하지 않다. */
export const naverAdapters: SiteAdapter[] = [
  naverMeAdapter,
  naverBlogAdapter,
  naverNewsAdapter,
  naverMapAdapter,
  naverShopAdapter,
  naverCafeAdapter,
];
