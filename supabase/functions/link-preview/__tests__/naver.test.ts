// 실행: bun test supabase/functions/link-preview
// Location 값은 2026-11-04 프로브의 naver.me 첫 홉 헤더 그대로(5ECWVdC6·xwoD0fsN·xxY2XG4R·58jH6CyP·GfCSj5Ut·GYywEiT4),
// HTML 은 m.blog / n.news / cafe 프레임셋 본문에서 판정에 필요한 태그만 발췌했다.
import { describe, expect, test } from 'bun:test';

import { canonicalize } from '../canonical.ts';
import {
  NAVER_MAP_OG_IMAGE,
  cafeNameFromTitle,
  extractNaverPlaceId,
  interpretNaverMapUrl,
  naverAdapters,
  naverBlogAdapter,
  naverCafeAdapter,
  naverMapAdapter,
  naverMeAdapter,
  naverNewsAdapter,
  naverShopAdapter,
  parseNaverBlogUrl,
  parseNaverCafeUrl,
  parseNaverNewsUrl,
  parseNaverShopUrl,
} from '../sites/naver.ts';
import type {
  FetchTextOptions,
  FetchTextResult,
  PreviewIO,
  ProviderCtx,
  ProviderOutcome,
  ResolveRedirectsResult,
  SiteAdapter,
} from '../types.ts';

// ---------------------------------------------------------------------------
// 가짜 io / ctx
// ---------------------------------------------------------------------------

interface Routes {
  text?: Record<string, Partial<FetchTextResult>>;
  redirects?: Record<string, Partial<ResolveRedirectsResult>>;
}

function makeIo(routes: Routes = {}) {
  const calls: Array<{ method: string; url: string; opts?: FetchTextOptions }> = [];
  const io: PreviewIO = {
    fetchText(url, opts) {
      calls.push({ method: 'fetchText', url, opts });
      const r = routes.text?.[url];
      if (!r) return Promise.reject(new Error(`fake io: no route (fetchText) ${url}`));
      return Promise.resolve({ status: 200, finalUrl: url, contentType: 'text/html', text: '', headers: {}, ...r });
    },
    fetchJson(url) {
      calls.push({ method: 'fetchJson', url });
      return Promise.reject(new Error(`fake io: no route (fetchJson) ${url}`));
    },
    head(url) {
      calls.push({ method: 'head', url });
      return Promise.reject(new Error(`fake io: no route (head) ${url}`));
    },
    resolveRedirects(url) {
      calls.push({ method: 'resolveRedirects', url });
      const r = routes.redirects?.[url];
      if (!r) return Promise.reject(new Error(`fake io: no route (resolveRedirects) ${url}`));
      return Promise.resolve({ hops: [url], final: url, ...r });
    },
  };
  return { io, calls };
}

function makeCtx(adapter: SiteAdapter, postUrl: string, io: PreviewIO, extra: Partial<ProviderCtx> = {}): ProviderCtx {
  const u = new URL(postUrl);
  const c = adapter.canonicalize ? adapter.canonicalize(u) : canonicalize(u);
  return {
    postUrl,
    fetchUrl: c.fetchUrl,
    canonicalUrl: c.canonicalUrl,
    io,
    deadline: Date.now() + 25_000,
    log: () => {},
    hintTitle: null,
    attempts: 1,
    ...extra,
  };
}

function expectKind<K extends ProviderOutcome['kind']>(
  o: ProviderOutcome,
  kind: K,
): Extract<ProviderOutcome, { kind: K }> {
  if (o.kind !== kind) throw new Error(`expected ${kind}, got ${o.kind}${'error' in o ? ` (${o.error})` : ''}`);
  return o as Extract<ProviderOutcome, { kind: K }>;
}

/** 어떤 어댑터가 잡는지 — 레지스트리(T6) 순서대로 첫 match */
function resolve(href: string): SiteAdapter | undefined {
  return naverAdapters.find((a) => a.match(new URL(href)));
}

// ---------------------------------------------------------------------------
// 고정 HTML
// ---------------------------------------------------------------------------

const M_BLOG_HTML =
  `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">` +
  `<meta property="og:title" content="[스페셜로고] '소상공인의 날' 로고 제작 이야기 - 머그컵가이 작가"/>` +
  `<meta property="og:image" content="https://blogthumb.pstatic.net/MjAyNjExMDRfMjM1/MDAxNzkzNzUzODUwMjky.G9elTXTWOt4a.PNG/26_logo.png?type=w2"/>` +
  `<meta property="og:description" content="작가님 소개를 부탁합니다. 안녕하세요, 일러스트레이터 그리고 크리에이터 머그컵가이입니다. 작가명은 도..."/>` +
  `<meta property="og:url" content="https://blog.naver.com/naverofficial/224464411656"/><meta property="og:type" content="article" />` +
  `<title>[스페셜로고] '소상공인의 날' 로고 제작 이야기 : 네이버 블로그</title></head><body>본문</body></html>`;

/** blog.naver.com/<id>/<logNo> 데스크톱 — og 0, 블로그 수준 <title> 만 */
const BLOG_FRAMESET =
  `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>네이버 공식블로그 : 네이버 블로그</title></head>` +
  `<body><iframe id="mainFrame" src="/PostView.naver?blogId=naverofficial&amp;logNo=224464411656&amp;redirect=Dlog&amp;widgetTypeCall=true"></iframe></body></html>`;

const NEWS_HTML =
  `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">` +
  `<meta property="og:title" content="박진영, 종교 모임 논란에 입 열어…&quot;이단·사이비라며 핍박&quot;">` +
  `<meta property="og:type" content="article"><meta property="og:url" content="https://n.news.naver.com/mnews/article/001/0016420835">` +
  `<meta property="og:image" content="https://imgnews.pstatic.net/image/001/2026/11/04/AKR20261104071800005_02_i_P4_20261104145118486.jpg?type&#x3D;w800">` +
  `<meta property="og:description" content="유튜브 채널 '첫열매들'에 강연 영상 공개…&quot;해결은 하나님이 하실 것&quot;">` +
  `<meta property="og:site_name" content="네이버 뉴스"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:creator" content="연합뉴스">` +
  `<title>박진영, 종교 모임 논란에 입 열어</title></head><body>기사</body></html>`;

/** cafe.naver.com/joonggonara/1119896688 — 프레임셋, fetch.ts 가 MS949 → euc-kr 로 디코드한 뒤의 텍스트 */
const CAFE_HTML =
  `<!DOCTYPE html><html lang="ko"><head><meta http-equiv="Content-Type" content="text/html;charset=KSC5601">` +
  `<meta http-equiv="Content-Type" content="text/html;charset=euc-kr"><title>중고나라 : 네이버 카페</title></head>` +
  `<body><iframe id="cafe_main" src="about:blank"></iframe></body></html>`;

const MKT_HTML =
  `<!DOCTYPE html><html><head><meta property="og:title" content="BE LOCAL — NAVER Maps" />` +
  `<meta property="og:description" content="로컬의 가치를 발견하다" /><meta property="og:url" content="https://mkt.naver.com/belocal" /></head><body></body></html>`;

// ---------------------------------------------------------------------------
// (a) 블로그
// ---------------------------------------------------------------------------

describe('네이버 블로그', () => {
  const BLOG_CANON = 'https://blog.naver.com/naverofficial/224464411656';
  const BLOG_MOBILE = 'https://m.blog.naver.com/naverofficial/224464411656';

  test('URL 4 폼 → 같은 blogId/logNo, fetchUrl 은 m.blog, canonical 은 blog.naver.com/<id>/<logNo> (fromRss 제거)', () => {
    const forms = [
      'https://blog.naver.com/naverofficial/224464411656?fromRss=true&trackingCode=rss',
      'https://blog.naver.com/PostView.naver?blogId=naverofficial&logNo=224464411656&redirect=Dlog&widgetTypeCall=true',
      'https://blog.naver.com/PostView.nhn?blogId=naverofficial&logNo=224464411656',
      'https://m.blog.naver.com/naverofficial/224464411656',
    ];
    for (const href of forms) {
      const u = new URL(href);
      expect(parseNaverBlogUrl(u)).toEqual({ blogId: 'naverofficial', logNo: '224464411656' });
      expect(resolve(href)?.id).toBe('naver_blog');
      expect(naverBlogAdapter.canonicalize!(u)).toEqual({ fetchUrl: BLOG_MOBILE, canonicalUrl: BLOG_CANON });
    }
    // 블로그 홈·비 글 경로는 generic
    expect(parseNaverBlogUrl(new URL('https://blog.naver.com/naverofficial'))).toBe(null);
    expect(resolve('https://blog.naver.com/naverofficial')).toBe(undefined);
  });

  test('m.blog og → ready: author=blogId, siteName 네이버 블로그, canonical 고정, og:image ?type=w2 그대로', async () => {
    const { io, calls } = makeIo({ text: { [BLOG_MOBILE]: { text: M_BLOG_HTML } } });
    const out = expectKind(
      await naverBlogAdapter.run(makeCtx(naverBlogAdapter, 'https://blog.naver.com/naverofficial/224464411656', io)),
      'ready',
    );
    expect(out.source).toBe('og');
    expect(out.fields.title).toBe("[스페셜로고] '소상공인의 날' 로고 제작 이야기 - 머그컵가이 작가");
    expect(out.fields.author).toBe('naverofficial');
    expect(out.fields.siteName).toBe('네이버 블로그');
    expect(out.fields.canonicalUrl).toBe(BLOG_CANON);
    expect(out.fields.imageCandidates[0].endsWith('/26_logo.png?type=w2')).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([BLOG_MOBILE]);
  });

  test('m.blog 가 og 없이 오면 PostView 데스크톱 1회 폴백', async () => {
    const postView = 'https://blog.naver.com/PostView.naver?blogId=naverofficial&logNo=224464411656';
    const { io, calls } = makeIo({
      text: { [BLOG_MOBILE]: { text: BLOG_FRAMESET }, [postView]: { text: M_BLOG_HTML } },
    });
    const out = expectKind(await naverBlogAdapter.run(makeCtx(naverBlogAdapter, BLOG_CANON, io)), 'ready');
    expect(out.fields.author).toBe('naverofficial');
    expect(calls.map((c) => c.url)).toEqual([BLOG_MOBILE, postView]);
  });

  test('404 는 영구(gone) — 데스크톱 재시도 없음', async () => {
    const { io, calls } = makeIo({
      text: { [BLOG_MOBILE]: { status: 404, text: '<html><head><title>없는 글</title></head></html>' } },
    });
    expect(expectKind(await naverBlogAdapter.run(makeCtx(naverBlogAdapter, BLOG_CANON, io)), 'unsupported').error).toBe(
      'gone',
    );
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (b) 뉴스
// ---------------------------------------------------------------------------

describe('네이버 뉴스', () => {
  const NEWS_CANON = 'https://n.news.naver.com/mnews/article/001/0016420835';

  test('read.naver?oid&aid · /article/ · /mnews/article/ → 같은 canonical. 댓글 경로는 generic', () => {
    for (const href of [
      'https://news.naver.com/main/read.naver?oid=001&aid=0016420835',
      'https://news.naver.com/main/read.nhn?mode=LSD&oid=001&aid=0016420835',
      'https://n.news.naver.com/article/001/0016420835',
      'https://n.news.naver.com/mnews/article/001/0016420835?sid=102',
    ]) {
      expect(parseNaverNewsUrl(new URL(href))).toEqual({ oid: '001', aid: '0016420835' });
      expect(naverNewsAdapter.canonicalize!(new URL(href)).canonicalUrl).toBe(NEWS_CANON);
    }
    expect(parseNaverNewsUrl(new URL('https://n.news.naver.com/article/comment/001/0016420835'))).toBe(null);
  });

  test('og 전부 + twitter:creator → author, 엔티티(&quot; &#x3D;) 디코드', async () => {
    const { io, calls } = makeIo({ text: { [NEWS_CANON]: { text: NEWS_HTML } } });
    const out = expectKind(
      await naverNewsAdapter.run(
        makeCtx(naverNewsAdapter, 'https://news.naver.com/main/read.naver?oid=001&aid=0016420835', io),
      ),
      'ready',
    );
    expect(out.fields.title).toBe('박진영, 종교 모임 논란에 입 열어…"이단·사이비라며 핍박"');
    expect(out.fields.author).toBe('연합뉴스');
    expect(out.fields.siteName).toBe('네이버 뉴스');
    expect(out.fields.imageCandidates[0].endsWith('.jpg?type=w800')).toBe(true);
    expect(out.fields.canonicalUrl).toBe(NEWS_CANON);
    expect(calls.map((c) => c.url)).toEqual([NEWS_CANON]); // 302 를 따라가지 않고 직접 재작성
  });
});

// ---------------------------------------------------------------------------
// (c) naver.me
// ---------------------------------------------------------------------------

const LOC_5ECW =
  'https://map.naver.com/?app=Y&menu=location&appMenu=location&lat=37.5514851&version=2&title=%EB%A7%88%ED%8F%AC%EC%8B%9D%EB%8B%B9&pinId=1045474371&lng=126.9373512&pinType=site';
const LOC_XWOD =
  'https://map.naver.com/?version=2&appMenu=location&pinId=37257404&app=Y&title=%EC%97%AC%EC%9A%B0%EA%B3%A8%20%ED%99%8D%EB%8C%80%EC%A0%90&lng=126.922667&pinType=site&lat=37.551153&menu=location';
const LOC_NEW = 'https://map.naver.com/p/entry/place/19764118?placePath=%2Fhome';
const LOC_FAV = 'https://map.naver.com/v5/favorite/myPlace/folder/f46061e812df484f9424206cad2a2996';
const LOC_MKT =
  'https://mkt.naver.com/p1/atrb?channel_id=mapappstore&campaign_id=2412-navermap-002&target=https%3A%2F%2Fmkt.naver.com%2Fnavermapapp';

describe('naver.me Location 해석', () => {
  test('지도 공유 2종(파라미터 순서 다름) → title 디코드 + canonical /p/entry/place/<pinId>', () => {
    const a = interpretNaverMapUrl(new URL(LOC_5ECW))!;
    expect(a.title).toBe('마포식당');
    expect(a.placeId).toBe('1045474371');
    expect(a.canonicalUrl).toBe('https://map.naver.com/p/entry/place/1045474371');

    const b = interpretNaverMapUrl(new URL(LOC_XWOD))!;
    expect(b.title).toBe('여우골 홍대점');
    expect(b.canonicalUrl).toBe('https://map.naver.com/p/entry/place/37257404');
  });

  test('title 없는 신형 → placeId 만, placePath 제거. 저장목록 → 라벨', () => {
    const n = interpretNaverMapUrl(new URL(LOC_NEW))!;
    expect(n.title).toBe(null);
    expect(n.placeId).toBe('19764118');
    expect(n.canonicalUrl).toBe('https://map.naver.com/p/entry/place/19764118');

    const f = interpretNaverMapUrl(new URL(LOC_FAV))!;
    expect(f.placeId).toBe(null);
    expect(f.title).toBe(null);
    expect(f.label).toBe('네이버 지도 저장 목록');
    expect(f.canonicalUrl).toBe(LOC_FAV);
  });

  test('비지도 대상은 null', () => {
    expect(interpretNaverMapUrl(new URL(LOC_MKT))).toBe(null);
  });
});

describe('naverMeAdapter.run', () => {
  const ME = 'https://naver.me/5ECWVdC6';

  test('첫 Location 에 title → ready(redirect) — 네트워크는 resolveRedirects 1회, map.naver.com 은 fetch 하지 않는다', async () => {
    const { io, calls } = makeIo({ redirects: { [ME]: { firstLocation: LOC_5ECW, status: 307 } } });
    const out = expectKind(await naverMeAdapter.run(makeCtx(naverMeAdapter, ME, io)), 'ready');
    expect(out.source).toBe('redirect');
    expect(out.fields.title).toBe('마포식당');
    expect(out.fields.siteName).toBe('네이버 지도');
    expect(out.fields.canonicalUrl).toBe('https://map.naver.com/p/entry/place/1045474371');
    expect(out.fields.imageCandidates).toEqual([NAVER_MAP_OG_IMAGE]);
    expect(calls).toEqual([{ method: 'resolveRedirects', url: ME }]);
  });

  test('title 없는 신형 → 같은 필드 + needs_client(needs:webview, runner webview). 힌트가 있으면 제목으로', async () => {
    const me = 'https://naver.me/xxY2XG4R';
    const { io, calls } = makeIo({ redirects: { [me]: { firstLocation: LOC_NEW, status: 307 } } });
    const out = expectKind(await naverMeAdapter.run(makeCtx(naverMeAdapter, me, io)), 'needs_client');
    expect(out.error).toBe('needs:webview');
    expect(out.task).toEqual({
      runner: 'webview',
      parser: 'generic',
      url: 'https://map.naver.com/p/entry/place/19764118',
    });
    expect(out.fields?.title).toBe(null);
    expect(out.fields?.siteName).toBe('네이버 지도');
    expect(out.fields?.imageCandidates).toEqual([NAVER_MAP_OG_IMAGE]);
    expect(calls).toHaveLength(1);

    const hinted = expectKind(
      await naverMeAdapter.run(makeCtx(naverMeAdapter, me, io, { hintTitle: '여우골 홍대점' })),
      'needs_client',
    );
    expect(hinted.fields?.title).toBe('여우골 홍대점');
  });

  test('저장목록 공유 → 라벨 제목 + needs_client', async () => {
    const me = 'https://naver.me/58jH6CyP';
    const { io } = makeIo({ redirects: { [me]: { firstLocation: LOC_FAV, status: 307 } } });
    const out = expectKind(await naverMeAdapter.run(makeCtx(naverMeAdapter, me, io)), 'needs_client');
    expect(out.fields?.title).toBe('네이버 지도 저장 목록');
  });

  test('비지도 대상(mkt.naver.com) → 나머지 홉 추적 → 최종 페이지 generic', async () => {
    const me = 'https://naver.me/GfCSj5Ut';
    const final = 'https://mkt.naver.com/belocal?dtm_source=mapappstore';
    const { io, calls } = makeIo({
      redirects: {
        [me]: { firstLocation: LOC_MKT, status: 307 },
        [LOC_MKT]: { hops: [LOC_MKT, 'https://mkt.naver.com/navermapapp'], final, status: 200 },
      },
      text: { [final]: { text: MKT_HTML } },
    });
    const out = expectKind(await naverMeAdapter.run(makeCtx(naverMeAdapter, me, io)), 'ready');
    expect(out.fields.title).toBe('BE LOCAL — NAVER Maps');
    expect(out.fields.canonicalUrl).toBe('https://mkt.naver.com/belocal');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `resolveRedirects ${me}`,
      `resolveRedirects ${LOC_MKT}`,
      `fetchText ${final}`,
    ]);
  });

  test('http://naver.me → https 301 뒤 지도 체인: 중간 홉의 title= 을 찾아 ready', async () => {
    const me = 'http://naver.me/5ECWVdC6';
    const https = 'https://naver.me/5ECWVdC6';
    const { io, calls } = makeIo({
      redirects: {
        [me]: { firstLocation: https, status: 301 },
        [https]: { hops: [https, LOC_5ECW], final: 'https://map.naver.com/p/entry/place/1045474371', status: 200 },
      },
    });
    const out = expectKind(await naverMeAdapter.run(makeCtx(naverMeAdapter, me, io)), 'ready');
    expect(out.fields.title).toBe('마포식당');
    expect(calls.every((c) => c.method === 'resolveRedirects')).toBe(true);
  });

  test('첫 홉이 블로그면 블로그 규칙(m.blog 재작성) 으로', async () => {
    const me = 'https://naver.me/blogX';
    const { io, calls } = makeIo({
      redirects: {
        [me]: { firstLocation: 'https://blog.naver.com/naverofficial/224464411656?fromRss=true', status: 302 },
      },
      text: { 'https://m.blog.naver.com/naverofficial/224464411656': { text: M_BLOG_HTML } },
    });
    const out = expectKind(await naverMeAdapter.run(makeCtx(naverMeAdapter, me, io)), 'ready');
    expect(out.fields.author).toBe('naverofficial');
    expect(out.fields.canonicalUrl).toBe('https://blog.naver.com/naverofficial/224464411656');
    expect(calls.map((c) => c.url)).toEqual([me, 'https://m.blog.naver.com/naverofficial/224464411656']);
  });
});

// ---------------------------------------------------------------------------
// (d) 지도 / 플레이스 — 네트워크 0회
// ---------------------------------------------------------------------------

describe('naverMapAdapter', () => {
  test('serverFetch false, 호스트 3종 매치, place id → canonical', () => {
    expect(naverMapAdapter.serverFetch).toBe(false);
    for (const href of [
      'https://map.naver.com/p/entry/place/11590805?c=15.00,0,0,0,dh',
      'https://m.place.naver.com/restaurant/11590805/home',
      'https://pcmap.place.naver.com/restaurant/11590805/home',
      'https://map.naver.com/v5/entry/place/11590805',
      'https://map.naver.com/p/search/%EB%A7%88%ED%8F%AC%EC%8B%9D%EB%8B%B9/place/11590805',
    ]) {
      expect(resolve(href)?.id).toBe('naver_map');
      expect(extractNaverPlaceId(new URL(href))).toBe('11590805');
      expect(naverMapAdapter.canonicalize!(new URL(href)).canonicalUrl).toBe(
        'https://map.naver.com/p/entry/place/11590805',
      );
    }
  });

  test('run: io 를 전혀 부르지 않고 needs_client(needs:webview) + 브랜드 카드 필드', async () => {
    const { io, calls } = makeIo();
    const out = expectKind(
      await naverMapAdapter.run(makeCtx(naverMapAdapter, 'https://m.place.naver.com/restaurant/11590805/home', io)),
      'needs_client',
    );
    expect(out.error).toBe('needs:webview');
    expect(out.task.runner).toBe('webview');
    expect(out.fields?.siteName).toBe('네이버 지도');
    expect(out.fields?.canonicalUrl).toBe('https://map.naver.com/p/entry/place/11590805');
    expect(out.fields?.imageCandidates).toEqual([NAVER_MAP_OG_IMAGE]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (e) 스마트스토어 / 쇼핑 — 네트워크 0회
// ---------------------------------------------------------------------------

describe('naverShopAdapter', () => {
  test('serverFetch false. /<storeId>/products/<pid> → canonical (m. → 데스크톱, brand 호스트 유지)', () => {
    expect(naverShopAdapter.serverFetch).toBe(false);
    const a = parseNaverShopUrl(
      new URL('https://m.smartstore.naver.com/star2market1/products/13483696479?NaPm=ct%3Dabc'),
    )!;
    expect(a).toEqual({
      storeHost: 'smartstore.naver.com',
      storeId: 'star2market1',
      productId: '13483696479',
      canonicalUrl: 'https://smartstore.naver.com/star2market1/products/13483696479',
      siteName: '네이버 스마트스토어',
    });
    expect(parseNaverShopUrl(new URL('https://brand.naver.com/marschoco/products/4592947042'))?.canonicalUrl).toBe(
      'https://brand.naver.com/marschoco/products/4592947042',
    );
    expect(
      parseNaverShopUrl(new URL('https://search.shopping.naver.com/catalog/12345678901?query=x&utm_source=a')),
    ).toEqual({
      storeHost: null,
      storeId: null,
      productId: null,
      canonicalUrl: 'https://search.shopping.naver.com/catalog/12345678901?query=x',
      siteName: '네이버 쇼핑',
    });
    expect(resolve('https://smartstore.naver.com/star2market1/products/13483696479')?.id).toBe('naver_shop');
    expect(resolve('https://shopping.naver.com/ns/home')?.id).toBe('naver_shop');
  });

  test('run: io 0회, 제목은 힌트 ?? "<storeId> 스토어 상품", blocked:naver_shop + runner fetch', async () => {
    const { io, calls } = makeIo();
    const href = 'https://smartstore.naver.com/star2market1/products/13483696479';
    const out = expectKind(await naverShopAdapter.run(makeCtx(naverShopAdapter, href, io)), 'needs_client');
    expect(out.error).toBe('blocked:naver_shop');
    expect(out.task).toEqual({ runner: 'fetch', parser: 'generic', url: href });
    expect(out.fields?.title).toBe('star2market1 스토어 상품');
    expect(out.fields?.siteName).toBe('네이버 스마트스토어');
    expect(calls).toHaveLength(0);

    const hinted = expectKind(
      await naverShopAdapter.run(makeCtx(naverShopAdapter, href, io, { hintTitle: '스타투마켓 유기농 귀리' })),
      'needs_client',
    );
    expect(hinted.fields?.title).toBe('스타투마켓 유기농 귀리');
  });
});

// ---------------------------------------------------------------------------
// (f) 카페
// ---------------------------------------------------------------------------

describe('naverCafeAdapter', () => {
  const CAFE_CANON = 'https://cafe.naver.com/joonggonara/1119896688';

  test('URL 폼: 데스크톱 · m.cafe ca-fe · iframe_url 공유 폼 · ArticleRead.nhn(숫자) · ca-fe 숫자', () => {
    expect(parseNaverCafeUrl(new URL(CAFE_CANON))).toEqual({
      cafeName: 'joonggonara',
      clubId: null,
      articleId: '1119896688',
      canonicalUrl: CAFE_CANON,
    });
    expect(
      parseNaverCafeUrl(
        new URL('https://m.cafe.naver.com/ca-fe/web/cafes/joonggonara/articles/1119896688?useCafeId=false'),
      )?.canonicalUrl,
    ).toBe(CAFE_CANON);
    const iframe = parseNaverCafeUrl(
      new URL(
        'https://cafe.naver.com/joonggonara?iframe_url=/ArticleRead.nhn%3Fclubid%3D10050146%26articleid%3D1119896688%26page%3D1',
      ),
    )!;
    expect(iframe.cafeName).toBe('joonggonara');
    expect(iframe.clubId).toBe('10050146');
    expect(iframe.canonicalUrl).toBe(CAFE_CANON);
    const numeric = parseNaverCafeUrl(
      new URL('https://cafe.naver.com/ArticleRead.nhn?clubid=10050146&articleid=1119896688'),
    )!;
    expect(numeric.cafeName).toBe(null);
    expect(numeric.canonicalUrl).toBe('https://cafe.naver.com/ca-fe/cafes/10050146/articles/1119896688');
    expect(
      parseNaverCafeUrl(new URL('https://cafe.naver.com/ca-fe/cafes/10050146/articles/1119896688'))?.canonicalUrl,
    ).toBe('https://cafe.naver.com/ca-fe/cafes/10050146/articles/1119896688');
    expect(resolve(CAFE_CANON)?.id).toBe('naver_cafe');
  });

  test('f-e(2024 PC 개편) /f-e/cafes/<clubid>/articles/<id> → clubId·articleId, canonical 은 ca-fe 폼 — 글마다 다르다', () => {
    const a = parseNaverCafeUrl(
      new URL(
        'https://cafe.naver.com/f-e/cafes/10050146/articles/1119896688?boardtype=L&menuid=334&referrerAllArticles=false',
      ),
    );
    expect(a).toEqual({
      cafeName: null,
      clubId: '10050146',
      articleId: '1119896688',
      canonicalUrl: 'https://cafe.naver.com/ca-fe/cafes/10050146/articles/1119896688',
    });
    const b = parseNaverCafeUrl(new URL('https://cafe.naver.com/f-e/cafes/29434212/articles/777'))!;
    expect(b.canonicalUrl).toBe('https://cafe.naver.com/ca-fe/cafes/29434212/articles/777');
    expect(b.canonicalUrl).not.toBe(a!.canonicalUrl);
    expect(resolve('https://cafe.naver.com/f-e/cafes/10050146/articles/1119896688')?.id).toBe('naver_cafe');
    // /<cafe>/ArticleRead.nhn?clubid&articleid 도 글
    expect(
      parseNaverCafeUrl(
        new URL('https://cafe.naver.com/joonggonara/ArticleRead.nhn?clubid=10050146&articleid=1119896688'),
      ),
    ).toEqual({ cafeName: 'joonggonara', clubId: '10050146', articleId: '1119896688', canonicalUrl: CAFE_CANON });
    // 'f-e'·'ca-fe' 가 카페명으로 읽히면 안 된다 — cafes 없는 폼과 .nhn 서블릿은 null(generic)
    for (const href of [
      'https://cafe.naver.com/f-e',
      'https://cafe.naver.com/ca-fe',
      'https://cafe.naver.com/MyCafeIntro.nhn?clubid=10050146',
      'https://cafe.naver.com/ArticleList.nhn?search.clubid=10050146&search.menuid=334',
    ]) {
      expect(parseNaverCafeUrl(new URL(href))).toBe(null);
      expect(resolve(href)).toBe(undefined);
    }
  });

  test('f-e 글 run: 네트워크 0회, 힌트 ?? "네이버 카페 글" — canonical 이 글마다 달라 다른 글의 힌트를 물려받지 않는다', async () => {
    const href = 'https://cafe.naver.com/f-e/cafes/10050146/articles/1119896688?boardtype=L';
    const { io, calls } = makeIo();
    const out = expectKind(await naverCafeAdapter.run(makeCtx(naverCafeAdapter, href, io)), 'ready');
    expect(out.fields.title).toBe('네이버 카페 글');
    expect(out.fields.siteName).toBe('네이버 카페');
    expect(out.fields.canonicalUrl).toBe('https://cafe.naver.com/ca-fe/cafes/10050146/articles/1119896688');
    expect(calls).toHaveLength(0);
    const hinted = expectKind(
      await naverCafeAdapter.run(makeCtx(naverCafeAdapter, href, io, { hintTitle: '아이폰 15 팝니다' })),
      'ready',
    );
    expect(hinted.source).toBe('hint');
    expect(hinted.fields.title).toBe('아이폰 15 팝니다');
  });

  test('카페 홈·글 식별 실패 폼은 canonical 을 /<cafe> 로 모으지 않는다 — 원 URL(데스크톱 호스트) 그대로, 제목은 카페명 라벨', async () => {
    const home = parseNaverCafeUrl(new URL('https://cafe.naver.com/joonggonara'))!;
    expect(home.articleId).toBe(null);
    expect(home.canonicalUrl).toBe('https://cafe.naver.com/joonggonara');
    const odd = parseNaverCafeUrl(
      new URL('https://m.cafe.naver.com/joonggonara?iframe_url=/unknown%3Fx%3D1&utm_source=share'),
    )!;
    expect(odd.articleId).toBe(null);
    expect(odd.canonicalUrl.startsWith('https://cafe.naver.com/joonggonara?iframe_url=')).toBe(true);
    expect(odd.canonicalUrl).not.toContain('utm_source');
    expect(odd.canonicalUrl).not.toBe(home.canonicalUrl);
    // clubId 만 있는 게시판(f-e menus) 은 글이 아니다 — 제목 null(도메인 카드), '네이버 카페 글' 이라 부르지 않는다
    const board = parseNaverCafeUrl(new URL('https://cafe.naver.com/f-e/cafes/10050146/menus/334?viewType=L'))!;
    expect(board.clubId).toBe('10050146');
    expect(board.articleId).toBe(null);
    expect(board.canonicalUrl).toBe('https://cafe.naver.com/f-e/cafes/10050146/menus/334?viewType=L');

    const { io, calls } = makeIo({ text: { 'https://cafe.naver.com/joonggonara': { text: CAFE_HTML } } });
    const out = expectKind(
      await naverCafeAdapter.run(makeCtx(naverCafeAdapter, 'https://cafe.naver.com/joonggonara', io)),
      'ready',
    );
    expect(out.fields.title).toBe('중고나라');
    expect(out.fields.canonicalUrl).toBe('https://cafe.naver.com/joonggonara');
    expect(calls).toHaveLength(1);
    const { io: io2, calls: calls2 } = makeIo();
    const boardOut = expectKind(
      await naverCafeAdapter.run(makeCtx(naverCafeAdapter, 'https://cafe.naver.com/f-e/cafes/10050146/menus/334', io2)),
      'ready',
    );
    expect(boardOut.fields.title).toBe(null);
    expect(calls2).toHaveLength(0);
  });

  test('cafeNameFromTitle', () => {
    expect(cafeNameFromTitle('중고나라 : 네이버 카페')).toBe('중고나라');
    expect(cafeNameFromTitle('네이버 카페')).toBe(null);
    expect(cafeNameFromTitle(null)).toBe(null);
  });

  test('데스크톱 프레임셋 <title> 의 카페명 → "<카페명> 글", 64 KB 캡·조기중단, siteName 네이버 카페, ready', async () => {
    const { io, calls } = makeIo({ text: { [CAFE_CANON]: { text: CAFE_HTML, charset: 'euc-kr' } } });
    const out = expectKind(
      await naverCafeAdapter.run(makeCtx(naverCafeAdapter, 'https://m.cafe.naver.com/joonggonara/1119896688', io)),
      'ready',
    );
    expect(out.source).toBe('og');
    expect(out.fields.title).toBe('중고나라 글');
    expect(out.fields.siteName).toBe('네이버 카페');
    expect(out.fields.canonicalUrl).toBe(CAFE_CANON);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CAFE_CANON);
    expect(calls[0].opts?.maxBytes).toBe(64 * 1024);
    expect(calls[0].opts?.stopAtHead).toBe(true);
  });

  test('공유 텍스트 힌트(글 제목) 가 있으면 라벨보다 우선 (source hint)', async () => {
    const { io } = makeIo({ text: { [CAFE_CANON]: { text: CAFE_HTML } } });
    const out = expectKind(
      await naverCafeAdapter.run(makeCtx(naverCafeAdapter, CAFE_CANON, io, { hintTitle: '아이패드 프로 11 팝니다' })),
      'ready',
    );
    expect(out.source).toBe('hint');
    expect(out.fields.title).toBe('아이패드 프로 11 팝니다');
  });

  test('fetch 실패·숫자 clubid 는 URL 로 라벨 — 재시도 없이 ready', async () => {
    const { io } = makeIo();
    const a = expectKind(await naverCafeAdapter.run(makeCtx(naverCafeAdapter, CAFE_CANON, io)), 'ready');
    expect(a.fields.title).toBe('joonggonara 글');
    const { io: io2, calls } = makeIo();
    const b = expectKind(
      await naverCafeAdapter.run(
        makeCtx(naverCafeAdapter, 'https://cafe.naver.com/ArticleRead.nhn?clubid=10050146&articleid=1119896688', io2),
      ),
      'ready',
    );
    expect(b.fields.title).toBe('네이버 카페 글');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 레지스트리 — 서로 겹치지 않는다
// ---------------------------------------------------------------------------

describe('naverAdapters', () => {
  test('각 URL 은 정확히 하나의 네이버 어댑터에만 걸린다', () => {
    const cases: Array<[string, string]> = [
      ['https://naver.me/5ECWVdC6', 'naver_me'],
      ['https://blog.naver.com/naverofficial/224464411656', 'naver_blog'],
      ['https://n.news.naver.com/article/001/0016420835', 'naver_news'],
      ['https://map.naver.com/p/entry/place/11590805', 'naver_map'],
      ['https://smartstore.naver.com/star2market1/products/13483696479', 'naver_shop'],
      ['https://cafe.naver.com/joonggonara/1119896688', 'naver_cafe'],
    ];
    for (const [href, id] of cases) {
      const matched = naverAdapters.filter((a) => a.match(new URL(href))).map((a) => a.id);
      expect(matched).toEqual([id]);
    }
    expect(naverAdapters.filter((a) => a.match(new URL('https://www.naver.com/')))).toHaveLength(0);
  });
});
