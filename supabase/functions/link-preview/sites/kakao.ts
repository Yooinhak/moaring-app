// 카카오/다음/한국 커머스·콘텐츠 어댑터 — 전부 generic og 파싱 위에 사이트별 보정 한 겹
//
// 관측 근거 (2026-11-04 프로브, 주거용 IP·curl 기본 UA, Edge egress 미검증):
//   place.map.kakao.com   3.6 KB SSR 셸이지만 og 완비. og:image 는 프로토콜상대(//img1.kakaocdn.net → html.resolveUrl 이 https 로),
//                         twitter:image 는 http staticmap(사진 없는 장소의 폴백 — 서버가 받아 https Storage 로), og:description 은 주소
//   brunch.co.kr          og:article:author 가 표시명, article:author 는 프로필 URL → pickFields 가 이미 표시명을 고른다
//   *.tistory.com         이미지 없는 글은 tistory_admin/…/opengraph.png(placeholders.ts 가 제외), og:site_name 이 블로그명 → author 대용
//   velog.io              플레이스홀더 images.velog.io/velog.png, 작성자는 경로 /@handle 에만 있다
//   m.cafe.daum.net       상대 og:url "/supporters/MbmU/92" + 전부 숫자 엔티티 설명 + http 이미지 — html.ts 가 전부 처리한다
//   ohou.se               og:title 끝에 ' | 라이프스타일 슈퍼앱, 오늘의집' 접미
//   kurly.com             og:description 이 전 상품 공통 문구 — generic 은 중복 설명을 안 거르므로(의도) 어댑터가 문구 패턴으로 버린다
//   daangn.com            JSON-LD Product(name/image/offers.price) 로 보강. 동네생활 글은 이미지가 하나도 없다.
//                         og:type=website + og:description == meta description 이지만 글 본문이다 — generic 이 그대로 살린다
//   kko.to·kko.kakao.com  표본을 못 찾아 미검증 — 리다이렉트(≤5홉, *.kakao.com) 뒤 place 또는 generic 으로 가정
//
// 네트워크는 ctx.io 만(generic.ts 의 fetchPage 경유). 상태코드 게이트·차단 시그니처·SPA 셸 판정은 generic 과 같다.

import { canonicalize, parseHttpUrl, pathSegments } from '../canonical.ts';
import { looksLikeSpaShell, parseTags, pickFields, resolveUrl } from '../html.ts';
import type { ParsedTags, PickedFields } from '../html.ts';
import { BUDGET } from '../types.ts';
import type {
  CanonicalResult,
  HostPattern,
  PreviewFields,
  ProviderCtx,
  ProviderOutcome,
  SiteAdapter,
} from '../types.ts';
import { errorCode, failed, fetchPage, finalizeGeneric, remainingMs, runGeneric } from './generic.ts';

// ---------------------------------------------------------------------------
// og 어댑터 팩토리 — fetch·게이트는 generic, 사이트별 보정만 remap 으로
// ---------------------------------------------------------------------------

/** 파싱 결과 위에 덧씌울 필드. 받은 fields 는 이미 정규화된 상태다. */
export type OgRemap = (fields: PickedFields, tags: ParsedTags, finalUrl: string) => Partial<PreviewFields>;

export interface OgAdapterSpec {
  id: string;
  match: (u: URL) => boolean;
  canonicalize?: (u: URL) => CanonicalResult;
  hopAllow?: HostPattern[];
  imageHosts?: RegExp[];
  remap?: OgRemap;
}

function hasAny(f: PreviewFields): boolean {
  return Boolean(f.title || f.description || f.author || f.imageCandidates.length > 0);
}

/** generic 흐름 + remap. parseSubmitted(폰 제출 HTML) 도 같은 remap 을 거친다. */
export function makeOgAdapter(spec: OgAdapterSpec): SiteAdapter {
  return {
    id: spec.id,
    serverFetch: true,
    imageHosts: spec.imageHosts,
    match: spec.match,
    canonicalize: spec.canonicalize,
    async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
      const r = await fetchPage(ctx, { hopAllow: spec.hopAllow });
      if (r.done) return r.outcome;
      const overrides = spec.remap ? spec.remap(r.page.fields, r.page.tags, r.page.res.finalUrl) : {};
      return finalizeGeneric(ctx, r.page, overrides);
    },
    parseSubmitted(html: string, finalUrl: string): PreviewFields | null {
      if (!html.trim()) return null;
      const tags = parseTags(html);
      const fields = pickFields(tags, finalUrl);
      if (looksLikeSpaShell(html, fields)) return null;
      const overrides = spec.remap ? spec.remap(fields, tags, finalUrl) : {};
      const out: PreviewFields = {
        title: fields.title,
        description: fields.description,
        author: fields.author,
        siteName: fields.siteName,
        canonicalUrl: fields.canonicalUrl,
        imageCandidates: fields.imageCandidates,
        ...overrides,
      };
      return hasAny(out) ? out : null;
    },
  };
}

/** 접미·접두 제거. 지우고 나서 비면 원문을 그대로 둔다 (제목이 접미만으로 이뤄진 경우). */
export function stripAffix(s: string | null, re: RegExp): string | null {
  if (!s) return null;
  const t = s.replace(re, '').trim();
  return t || s;
}

// ---------------------------------------------------------------------------
// 카카오맵 장소 + kko 단축
// ---------------------------------------------------------------------------

const KAKAO_HOP_HOSTS: HostPattern[] = ['*.kakao.com', 'kko.to', '*.daum.net'];
const DIGITS_RE = /^\d+$/;

export function kakaoPlaceId(u: URL): string | null {
  if (u.hostname !== 'place.map.kakao.com') return null;
  const first = pathSegments(u)[0];
  return first && DIGITS_RE.test(first) ? first : null;
}

export function kakaoPlaceCanonical(u: URL): CanonicalResult {
  const id = kakaoPlaceId(u);
  if (!id) return canonicalize(u);
  const c = `https://place.map.kakao.com/${id}`;
  return { fetchUrl: c, canonicalUrl: c };
}

export const kakaoPlaceAdapter: SiteAdapter = makeOgAdapter({
  id: 'kakao_place',
  match: (u) => kakaoPlaceId(u) !== null,
  canonicalize: kakaoPlaceCanonical,
  hopAllow: KAKAO_HOP_HOSTS,
  // og:description 은 주소 — 부제로 그대로 쓴다. 이미지는 프로토콜상대 사진 → http staticmap 순으로 이미 후보에 있다
  remap: () => ({ siteName: '카카오맵' }),
});

/** kko.to / kko.kakao.com — 표본이 없어 미검증. 리다이렉트만 따라가 장소면 place 어댑터로, 아니면 generic. */
export const kakaoShortAdapter: SiteAdapter = {
  id: 'kakao_short',
  serverFetch: true,
  match: (u) => u.hostname === 'kko.to' || u.hostname === 'kko.kakao.com',
  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
    if (timeoutMs <= 0) return failed('timeout');
    let final: string;
    try {
      final = (await ctx.io.resolveRedirects(ctx.fetchUrl, { maxHops: 5, hopAllow: KAKAO_HOP_HOSTS, timeoutMs })).final;
    } catch (e) {
      return failed(errorCode(e));
    }
    const u = parseHttpUrl(final);
    if (!u) return failed('redirect_invalid');
    const c = kakaoPlaceId(u) ? kakaoPlaceCanonical(u) : canonicalize(u);
    const next: ProviderCtx = { ...ctx, fetchUrl: c.fetchUrl, canonicalUrl: c.canonicalUrl };
    return kakaoPlaceId(u) ? kakaoPlaceAdapter.run(next) : runGeneric(next, { hopAllow: KAKAO_HOP_HOSTS, maxHops: 2 });
  },
};

// ---------------------------------------------------------------------------
// 콘텐츠 플랫폼 — brunch · tistory · velog · Daum 카페
// ---------------------------------------------------------------------------

export const brunchAdapter: SiteAdapter = makeOgAdapter({
  id: 'brunch',
  match: (u) => u.hostname === 'brunch.co.kr' || u.hostname === 'www.brunch.co.kr',
  remap: (f) => ({ author: f.raw.ogArticleAuthor ?? f.author, siteName: f.siteName ?? '브런치스토리' }),
});

export const tistoryAdapter: SiteAdapter = makeOgAdapter({
  id: 'tistory',
  match: (u) => /\.tistory\.com$/i.test(u.hostname) && u.hostname !== 'www.tistory.com',
  // og:site_name 은 블로그 이름('프롱트') — 작성자 란에 두고 사이트 라벨은 서비스명으로
  remap: (f) => ({ author: f.author ?? f.raw.ogSiteName, siteName: '티스토리' }),
});

export const velogAdapter: SiteAdapter = makeOgAdapter({
  id: 'velog',
  match: (u) => u.hostname === 'velog.io' || u.hostname === 'www.velog.io',
  remap: (f, _tags, finalUrl) => {
    const u = parseHttpUrl(finalUrl);
    const first = u ? pathSegments(u)[0] : undefined;
    let handle: string | null = null;
    if (first && first.startsWith('@')) {
      try {
        handle = decodeURIComponent(first);
      } catch {
        handle = first;
      }
    }
    return { author: f.author ?? handle, siteName: 'velog' };
  },
});

export const daumCafeAdapter: SiteAdapter = makeOgAdapter({
  id: 'daum_cafe',
  match: (u) => /^(?:m\.)?cafe\.daum\.net$/i.test(u.hostname),
  hopAllow: ['*.daum.net', '*.kakao.com'],
  // canonical 은 pickFields 가 상대 og:url 을 finalUrl 기준으로 풀어 준다. og:site_name 이 없어 라벨만 고정
  remap: (f) => ({ siteName: f.siteName ?? 'Daum 카페' }),
});

// ---------------------------------------------------------------------------
// 커머스 — 오늘의집 · 컬리 · 당근
// ---------------------------------------------------------------------------

const OHOU_SUFFIX_RE = /\s*\|\s*라이프스타일 슈퍼앱,\s*오늘의집\s*$/;

export const ohouAdapter: SiteAdapter = makeOgAdapter({
  id: 'ohou',
  match: (u) => /(?:^|\.)ohou\.se$/i.test(u.hostname),
  remap: (f) => ({ title: stripAffix(f.title, OHOU_SUFFIX_RE), siteName: '오늘의집' }),
});

const KURLY_PREFIX_RE = /^\[Kurly\]\s*/i;
const KURLY_SUFFIX_RE = /\s*-\s*마켓컬리\s*$/;
/** 전 상품 공통 소개 문구 (og:description == meta description). pickFields 는 이런 중복을 보일러플레이트로 안 보므로 여기서 버린다. */
const KURLY_BOILERPLATE_RE = /^사람과 환경을 위한 포장재/;

export const kurlyAdapter: SiteAdapter = makeOgAdapter({
  id: 'kurly',
  match: (u) => /^(?:www\.)?kurly\.com$/i.test(u.hostname),
  remap: (f) => ({
    title: stripAffix(stripAffix(f.title, KURLY_PREFIX_RE), KURLY_SUFFIX_RE),
    description: f.description && KURLY_BOILERPLATE_RE.test(f.description) ? null : f.description,
    siteName: '컬리', // src/utils/domainInfo.ts 의 label 과 같은 표기
  }),
});

export interface JsonLdProduct {
  name: string | null;
  description: string | null;
  images: string[];
  /** offers.price (KRW). 없거나 0 이하면 null. */
  price: number | null;
}

function asText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function typesOf(obj: Record<string, unknown>): string[] {
  const t = obj['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function urlOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const u = (v as Record<string, unknown>).url ?? (v as Record<string, unknown>).contentUrl;
    return typeof u === 'string' ? u : null;
  }
  return null;
}

function productFrom(obj: Record<string, unknown>): JsonLdProduct {
  const images: string[] = [];
  const img = obj.image;
  for (const item of Array.isArray(img) ? img : [img]) {
    const u = urlOf(item);
    if (u && !images.includes(u)) images.push(u);
  }
  const offers = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
  let price: number | null = null;
  if (offers && typeof offers === 'object') {
    const p = (offers as Record<string, unknown>).price;
    const n = typeof p === 'number' ? p : typeof p === 'string' ? Number(p) : NaN;
    if (Number.isFinite(n) && n > 0) price = n;
  }
  return { name: asText(obj.name), description: asText(obj.description), images, price };
}

/** 첫 JSON-LD Product (최상위·배열·@graph 안). 당근은 Product + BreadcrumbList 두 블록을 준다. */
export function extractJsonLdProduct(jsonLd: unknown[]): JsonLdProduct | null {
  const queue: unknown[] = [...jsonLd];
  let guard = 0;
  while (queue.length > 0 && guard++ < 64) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    const obj = node as Record<string, unknown>;
    if (typesOf(obj).includes('Product')) return productFrom(obj);
    if (Array.isArray(obj['@graph'])) queue.push(...(obj['@graph'] as unknown[]));
  }
  return null;
}

/** 41000 → '41,000원'. 로케일 의존(Intl) 없이 — Edge 와 bun 에서 같은 결과를 내기 위해. */
export function formatKrw(n: number): string {
  return `${Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

const DAANGN_SUFFIX_RE = /\s*\|\s*당근(?:\s*(?:중고거래|동네생활|알바|부동산|중고차|마켓))?\s*$/;

export const daangnAdapter: SiteAdapter = makeOgAdapter({
  id: 'daangn',
  match: (u) => /^(?:www\.)?daangn\.com$/i.test(u.hostname),
  remap: (f, tags, finalUrl) => {
    const product = extractJsonLdProduct(tags.jsonLd);
    const title = stripAffix(f.title, DAANGN_SUFFIX_RE) ?? product?.name ?? null;
    let description = f.description ?? product?.description ?? null;
    if (product?.price) {
      const price = formatKrw(product.price);
      // og:title 이 이미 '… | 41,000원 | 당근 중고거래' 꼴이면 중복하지 않는다
      if (!(title ?? '').includes(price)) description = description ? `${price}\n${description}` : price;
    }
    const imageCandidates = [...f.imageCandidates];
    for (const raw of product?.images ?? []) {
      const r = resolveUrl(raw, finalUrl);
      if (r && !imageCandidates.includes(r)) imageCandidates.push(r);
    }
    return { title, description, imageCandidates, siteName: '당근' };
  },
});

/** 레지스트리(T6 sites/index.ts) 용. 순서는 호스트가 겹치지 않아 의미 없다. */
export const kakaoAdapters: SiteAdapter[] = [
  kakaoPlaceAdapter,
  kakaoShortAdapter,
  brunchAdapter,
  tistoryAdapter,
  velogAdapter,
  daumCafeAdapter,
  ohouAdapter,
  kurlyAdapter,
  daangnAdapter,
];
