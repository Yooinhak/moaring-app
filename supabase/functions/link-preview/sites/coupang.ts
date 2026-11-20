// 쿠팡 어댑터 — 상품 페이지는 서버·폰 fetch 모두 하지 않는다. link.coupang.com 단축은 Location 헤더 1회만 읽는다.
//
// 관측 근거 (2026-11-04 프로브): www.coupang.com·m.coupang.com 은 모든 경로가 Akamai Bot Manager 403 'Access Denied'
// (server AkamaiGHost, 399 B, 0.09 s — IP·헤더·HTTP 버전 무관: 주거용 Mac 과 데이터센터 WebFetch 둘 다). UA 스푸핑·우회 금지.
// link.coupang.com/a/<code> 는 302 + 본문 0 B, Location 에 /vp/products/<pid>?itemId=&vendorItemId=&lptag=… (파트너스 AF·앱 공유 CFM 둘 다,
// 코드마다 productId·itemId 는 고정이고 추적 파라미터만 바뀐다). 만료·엉터리 코드는 404 가 아니라 https://www.coupang.com 홈으로 302
// → 'coupang_unresolved' (홈을 canonical 로 저장하면 안 된다). Location 1회 읽기도 파트너스 클릭 1회로 집계될 수 있어 저장당 1회만.
// shop.coupang.com(브랜드샵) 만 envoy 뒤 SSR og 정상 → 이 어댑터가 잡지 않아 generic 으로 간다.
// 이미지 CDN(*.coupangcdn.com) 은 Akamai 밖(S3) 이라 폰이 가져온 og:image 를 서버가 복사할 수 있다 — imageHosts 로 그 호스트만 허용.
//
// 두 어댑터로 나눈 이유: SiteAdapter.serverFetch=false 는 "run 이 네트워크 0회" 라는 약속이다. 단축 해석(Location 1회) 만 true 로 두고
// 상품 호스트는 false 로 둬서, 설계가 요구한 "쿠팡 어댑터는 serverFetch false" 와 플래그 의미를 둘 다 지킨다.

import { canonicalize, parseHttpUrl, pathSegments } from '../canonical.ts';
import { BUDGET } from '../types.ts';
import type {
  CanonicalResult,
  HostPattern,
  PreviewFields,
  ProviderCtx,
  ProviderOutcome,
  ResolveRedirectsResult,
  SiteAdapter,
} from '../types.ts';
import {
  emptyFields,
  errorCode,
  failed,
  hostnameOf,
  httpErrorCode,
  needsClient,
  remainingMs,
  unsupported,
} from './generic.ts';

export const COUPANG_IMAGE_HOSTS: RegExp[] = [/(?:^|\.)coupangcdn\.com$/i];

/** 단축 해석 때 Location 이 가리킬 수 있는 곳. 그 밖이면 fetch.ts 가 거부한다. */
const LINK_HOP_HOSTS: HostPattern[] = ['link.coupang.com', 'www.coupang.com', 'm.coupang.com'];
/** /vp/products/<pid> (데스크톱) · /vm/products/<pid> (모바일) */
const PRODUCT_PATH_RE = /^\/v[pm]\/products\/(\d+)(?:[/?#]|$)/;
const DIGITS_RE = /^\d+$/;

export interface CoupangProduct {
  productId: string;
  itemId: string | null;
  vendorItemId: string | null;
  /** https://www.coupang.com/vp/products/<pid>?itemId=…&vendorItemId=… — 그 외 파라미터 전부 제거 */
  canonicalUrl: string;
}

export function isCoupangProductHost(hostname: string): boolean {
  return hostname === 'www.coupang.com' || hostname === 'm.coupang.com' || hostname === 'coupang.com';
}

/** 상품 URL(직접 입력 또는 단축의 Location) → 식별자 + canonical. 상품 경로가 아니면 null (홈·검색·엉터리 코드의 302). */
export function parseCoupangProductUrl(input: string | URL): CoupangProduct | null {
  const u = typeof input === 'string' ? parseHttpUrl(input) : input;
  if (!u || !isCoupangProductHost(u.hostname)) return null;
  const m = PRODUCT_PATH_RE.exec(u.pathname);
  if (!m) return null;
  const digits = (key: string): string | null => {
    const v = u.searchParams.get(key);
    return v && DIGITS_RE.test(v) ? v : null;
  };
  const itemId = digits('itemId');
  const vendorItemId = digits('vendorItemId');
  const c = new URL(`https://www.coupang.com/vp/products/${m[1]}`);
  if (itemId) c.searchParams.set('itemId', itemId);
  if (vendorItemId) c.searchParams.set('vendorItemId', vendorItemId);
  return { productId: m[1], itemId, vendorItemId, canonicalUrl: c.href };
}

/** 상품이면 식별자만 남긴 canonical, 아니면 추적 파라미터만 제거 (m. 은 유지 — 서버가 fetch 하지 않으니 재작성 의미가 없다). */
export function coupangCanonical(u: URL): CanonicalResult {
  const p = parseCoupangProductUrl(u);
  if (p) return { fetchUrl: p.canonicalUrl, canonicalUrl: p.canonicalUrl };
  return canonicalize(u);
}

/** 브랜드 카드 + 폰 WebView 과제. 제목은 공유 텍스트 힌트가 최우선 — 쿠팡 앱 공유가 상품명을 싣는지는 미확인이라 '쿠팡 상품 <pid>' 폴백. */
function coupangOutcome(ctx: ProviderCtx, product: CoupangProduct | null, canonicalUrl: string): ProviderOutcome {
  const fields: PreviewFields = emptyFields({
    title: ctx.hintTitle ?? (product ? `쿠팡 상품 ${product.productId}` : null),
    siteName: '쿠팡',
    canonicalUrl,
  });
  return needsClient('needs:webview', canonicalUrl, 'webview', 'generic', fields);
}

/** link.coupang.com/a/<code> — redirect:'manual' 로 첫 Location 만 읽는다 (본문 0 B, www 로 따라가지 않음). */
export const coupangLinkAdapter: SiteAdapter = {
  id: 'coupang',
  serverFetch: true,
  imageHosts: COUPANG_IMAGE_HOSTS,
  match: (u) => u.hostname === 'link.coupang.com' && pathSegments(u).length > 0,
  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
    if (timeoutMs <= 0) return failed('timeout');
    let r: ResolveRedirectsResult;
    try {
      r = await ctx.io.resolveRedirects(ctx.fetchUrl, {
        maxHops: 1,
        firstHopOnly: true,
        hopAllow: LINK_HOP_HOSTS,
        timeoutMs,
      });
    } catch (e) {
      return failed(errorCode(e));
    }
    if (!r.firstLocation) {
      // 리다이렉트가 아니었다 — 관측된 적 없음. 404/410 이면 영구, 아니면 재시도 대상
      if (r.status === 404 || r.status === 410) return unsupported('gone');
      return failed(r.status ? httpErrorCode(r.status) : 'coupang_no_redirect');
    }
    const product = parseCoupangProductUrl(r.firstLocation);
    if (!product) {
      ctx.log('coupang.unresolved', { host: hostnameOf(r.firstLocation) });
      return unsupported('coupang_unresolved', emptyFields({ siteName: '쿠팡', canonicalUrl: ctx.canonicalUrl }));
    }
    return coupangOutcome(ctx, product, product.canonicalUrl);
  },
};

/** www.coupang.com · m.coupang.com — 네트워크 0회. shop.coupang.com 과 link.coupang.com 은 여기 해당하지 않는다. */
export const coupangAdapter: SiteAdapter = {
  id: 'coupang',
  serverFetch: false,
  imageHosts: COUPANG_IMAGE_HOSTS,
  match: (u) => isCoupangProductHost(u.hostname),
  canonicalize: coupangCanonical,
  run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const u = parseHttpUrl(ctx.canonicalUrl) ?? parseHttpUrl(ctx.postUrl);
    const product = u ? parseCoupangProductUrl(u) : null;
    return Promise.resolve(coupangOutcome(ctx, product, product?.canonicalUrl ?? ctx.canonicalUrl));
  },
};

/** 레지스트리용 — 단축 해석이 먼저, 상품 호스트가 다음 (호스트가 달라 순서 자체는 중요하지 않다). */
export const coupangAdapters: SiteAdapter[] = [coupangLinkAdapter, coupangAdapter];
