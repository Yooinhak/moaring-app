// 실행: bun test supabase/functions/link-preview
// Location 값은 2026-11-04 프로브의 link.coupang.com HEAD 응답 그대로(dMfYsWGJc4 파트너스 AF · cv32A6 앱 공유 CFM · 엉터리 코드 → 홈).
import { describe, expect, test } from 'bun:test';

import { canonicalize } from '../canonical.ts';
import {
  COUPANG_IMAGE_HOSTS,
  coupangAdapter,
  coupangAdapters,
  coupangCanonical,
  coupangLinkAdapter,
  parseCoupangProductUrl,
} from '../sites/coupang.ts';
import type { PreviewIO, ProviderCtx, ProviderOutcome, ResolveRedirectsResult, SiteAdapter } from '../types.ts';

// ---------------------------------------------------------------------------
// 가짜 io / ctx — fetchText 는 어떤 URL 이든 던진다 (쿠팡 어댑터는 본문을 읽으면 안 된다)
// ---------------------------------------------------------------------------

function makeIo(redirects: Record<string, Partial<ResolveRedirectsResult>> = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const io: PreviewIO = {
    fetchText(url) {
      calls.push({ method: 'fetchText', url });
      return Promise.reject(new Error(`fake io: no route (fetchText) ${url}`));
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
      const r = redirects[url];
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

// ---------------------------------------------------------------------------
// 프로브 Location
// ---------------------------------------------------------------------------

const LOC_AF =
  'https://www.coupang.com/vp/products/5485178183?itemId=8474978966&src=1139000&spec=10799999&addtag=400&ctag=5485178183&lptag=AF3603745' +
  '&itime=20261104162416&pageType=PRODUCT&pageValue=5485178183&wPcid=17937770566666071182406&wRef=&wTime=20261104162416&redirect=landing' +
  '&traceid=V0-101-018dfc796596872e&mcid=5a28e208f95e4ade9e76f0c6df89b585&pt=&campaignid=&clickBeacon=&subid=&token=&impressionid=&offerId=&sfId=';
const LOC_CFM =
  'https://www.coupang.com/vp/products/7608804797?itemId=20146298818&vendorItemId=87239403818&src=1191000&spec=10999999&addtag=400&ctag=7608804797' +
  '&lptag=CFM24988502&itime=20261104162529&pageType=PRODUCT&pageValue=7608804797&wPcid=17937771298565878591728&wRef=&wTime=20261104162529' +
  '&redirect=landing&abTestInfo=&mcid=b44a624a578a40039ad218f843dfc268&sharesource=sharebutton&style=&isshortened=Y&settlement=N';
const LOC_HOME = 'https://www.coupang.com';

const CANON_AF = 'https://www.coupang.com/vp/products/5485178183?itemId=8474978966';
const CANON_CFM = 'https://www.coupang.com/vp/products/7608804797?itemId=20146298818&vendorItemId=87239403818';

describe('parseCoupangProductUrl', () => {
  test('파트너스(AF) Location: productId·itemId, vendorItemId 없음 → canonical 은 itemId 만', () => {
    expect(parseCoupangProductUrl(LOC_AF)).toEqual({
      productId: '5485178183',
      itemId: '8474978966',
      vendorItemId: null,
      canonicalUrl: CANON_AF,
    });
  });

  test('앱 공유(CFM) Location: itemId + vendorItemId, 추적 파라미터(lptag·wPcid·mcid·traceid·itime·sharesource…) 전부 제거', () => {
    expect(parseCoupangProductUrl(LOC_CFM)).toEqual({
      productId: '7608804797',
      itemId: '20146298818',
      vendorItemId: '87239403818',
      canonicalUrl: CANON_CFM,
    });
  });

  test('홈으로 가는 302(만료·엉터리 코드) 는 null — 홈을 canonical 로 저장하면 안 된다', () => {
    expect(parseCoupangProductUrl(LOC_HOME)).toBe(null);
    expect(parseCoupangProductUrl('https://www.coupang.com/np/search?q=x')).toBe(null);
  });

  test('m.coupang.com /vm/products/ 도 www /vp/ canonical 로. shop.coupang.com·가짜 호스트는 null', () => {
    expect(
      parseCoupangProductUrl('https://m.coupang.com/vm/products/9651433228?itemId=1&vendorItemId=2&src=app')
        ?.canonicalUrl,
    ).toBe('https://www.coupang.com/vp/products/9651433228?itemId=1&vendorItemId=2');
    expect(parseCoupangProductUrl('https://shop.coupang.com/samsungkorea/248463')).toBe(null);
    expect(parseCoupangProductUrl('https://www.coupang.com.evil.com/vp/products/1')).toBe(null);
    expect(parseCoupangProductUrl('https://www.coupang.com/vp/products/1?itemId=abc')).toEqual({
      productId: '1',
      itemId: null,
      vendorItemId: null,
      canonicalUrl: 'https://www.coupang.com/vp/products/1',
    });
  });

  test('coupangCanonical: 상품은 식별자만, 비상품 경로는 추적 파라미터만 제거', () => {
    expect(coupangCanonical(new URL(LOC_CFM)).canonicalUrl).toBe(CANON_CFM);
    expect(coupangCanonical(new URL('https://www.coupang.com/np/categories/1?lptag=X&page=2#top')).canonicalUrl).toBe(
      'https://www.coupang.com/np/categories/1?page=2',
    );
  });
});

describe('coupangLinkAdapter (link.coupang.com)', () => {
  const SHORT = 'https://link.coupang.com/a/cv32A6';

  test('match: link.coupang.com 만. 상품 호스트·shop 은 아니다', () => {
    expect(coupangLinkAdapter.match(new URL(SHORT))).toBe(true);
    expect(coupangLinkAdapter.match(new URL('https://link.coupang.com/'))).toBe(false);
    expect(coupangLinkAdapter.match(new URL(LOC_CFM))).toBe(false);
    expect(coupangLinkAdapter.match(new URL('https://shop.coupang.com/samsungkorea/248463'))).toBe(false);
  });

  test('Location 1회 읽기 → needs_client(needs:webview, runner webview, url = canonical) + "쿠팡 상품 <pid>", fetchText 0회', async () => {
    const { io, calls } = makeIo({ [SHORT]: { firstLocation: LOC_CFM, status: 302 } });
    const out = expectKind(await coupangLinkAdapter.run(makeCtx(coupangLinkAdapter, SHORT, io)), 'needs_client');
    expect(out.error).toBe('needs:webview');
    expect(out.task).toEqual({ runner: 'webview', parser: 'generic', url: CANON_CFM });
    expect(out.fields?.title).toBe('쿠팡 상품 7608804797');
    expect(out.fields?.siteName).toBe('쿠팡');
    expect(out.fields?.canonicalUrl).toBe(CANON_CFM);
    expect(out.fields?.imageCandidates).toEqual([]);
    expect(calls).toEqual([{ method: 'resolveRedirects', url: SHORT }]);
  });

  test('공유 텍스트 힌트가 있으면 제목으로', async () => {
    const { io } = makeIo({ [SHORT]: { firstLocation: LOC_AF, status: 302 } });
    const out = expectKind(
      await coupangLinkAdapter.run(makeCtx(coupangLinkAdapter, SHORT, io, { hintTitle: '삼성 비스포크 냉장고' })),
      'needs_client',
    );
    expect(out.fields?.title).toBe('삼성 비스포크 냉장고');
    expect(out.fields?.canonicalUrl).toBe(CANON_AF);
  });

  test('홈으로 302(엉터리·만료 코드) → unsupported(coupang_unresolved)', async () => {
    const bogus = 'https://link.coupang.com/a/zzzzNOTREAL00';
    const { io, calls } = makeIo({ [bogus]: { firstLocation: LOC_HOME, status: 302 } });
    const out = expectKind(await coupangLinkAdapter.run(makeCtx(coupangLinkAdapter, bogus, io)), 'unsupported');
    expect(out.error).toBe('coupang_unresolved');
    expect(calls).toHaveLength(1);
  });

  test('리다이렉트 없음(404) 은 gone, 네트워크 예외는 failed', async () => {
    const { io } = makeIo({ [SHORT]: { status: 404 } });
    expect(expectKind(await coupangLinkAdapter.run(makeCtx(coupangLinkAdapter, SHORT, io)), 'unsupported').error).toBe(
      'gone',
    );
    // 코드 문자열은 generic.errorCode 가 예외 메시지로 추정한 값이라 종류(failed = 재시도 대상) 만 본다
    const { io: io2 } = makeIo();
    expect(expectKind(await coupangLinkAdapter.run(makeCtx(coupangLinkAdapter, SHORT, io2)), 'failed').kind).toBe(
      'failed',
    );
  });
});

describe('coupangAdapter (www · m)', () => {
  test('serverFetch false, 상품 호스트만 매치 (shop·link 제외)', () => {
    expect(coupangAdapter.serverFetch).toBe(false);
    expect(coupangAdapter.match(new URL(LOC_CFM))).toBe(true);
    expect(coupangAdapter.match(new URL('https://m.coupang.com/vm/products/9651433228'))).toBe(true);
    expect(coupangAdapter.match(new URL('https://shop.coupang.com/samsungkorea/248463'))).toBe(false);
    expect(coupangAdapter.match(new URL('https://link.coupang.com/a/cv32A6'))).toBe(false);
    expect(coupangAdapters.map((a) => a.id)).toEqual(['coupang', 'coupang']);
  });

  test('run: io 0회, canonical 은 식별자만, needs:webview + 브랜드 카드', async () => {
    const { io, calls } = makeIo();
    const ctx = makeCtx(coupangAdapter, LOC_CFM, io);
    expect(ctx.canonicalUrl).toBe(CANON_CFM);
    const out = expectKind(await coupangAdapter.run(ctx), 'needs_client');
    expect(out.error).toBe('needs:webview');
    expect(out.task).toEqual({ runner: 'webview', parser: 'generic', url: CANON_CFM });
    expect(out.fields?.title).toBe('쿠팡 상품 7608804797');
    expect(out.fields?.siteName).toBe('쿠팡');
    expect(calls).toHaveLength(0);
  });

  test('비상품 경로(검색 등) 는 제목 없이 힌트만, canonical 은 추적 파라미터 제거', async () => {
    const { io } = makeIo();
    const href = 'https://www.coupang.com/np/search?q=%EB%83%89%EC%9E%A5%EA%B3%A0&lptag=X';
    const out = expectKind(
      await coupangAdapter.run(makeCtx(coupangAdapter, href, io, { hintTitle: '냉장고 검색' })),
      'needs_client',
    );
    expect(out.fields?.title).toBe('냉장고 검색');
    expect(out.fields?.canonicalUrl).toBe('https://www.coupang.com/np/search?q=%EB%83%89%EC%9E%A5%EA%B3%A0');
    const bare = expectKind(await coupangAdapter.run(makeCtx(coupangAdapter, href, io)), 'needs_client');
    expect(bare.fields?.title).toBe(null);
  });

  test('imageHosts: *.coupangcdn.com 만', () => {
    const ok = (h: string) => COUPANG_IMAGE_HOSTS.some((re) => re.test(h));
    expect(ok('thumbnail6.coupangcdn.com')).toBe(true);
    expect(ok('image11.coupangcdn.com')).toBe(true);
    expect(ok('coupangcdn.com')).toBe(true);
    expect(ok('evilcoupangcdn.com')).toBe(false);
    expect(ok('coupangcdn.com.evil.com')).toBe(false);
  });
});
