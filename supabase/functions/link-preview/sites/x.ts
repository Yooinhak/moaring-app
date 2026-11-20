// X(트위터) 어댑터 — 상태 페이지 SSR og(32 KB) 가 1차, publish.x.com oEmbed 가 2차, 둘 다 안 되면 폰
//
// 관측 (2026-11-04 프로브, 주거용 IP·curl/bun 기본 UA): x.com/<u>/status/<id> 는 JS 셸이 아니라 50개 <meta> 가 든
// SSR <head> 였다(og 끝 ~4 KB, </head> ~9 KB → 32 KB 캡). /i/status/<id>·/i/web/status/<id> 는 307 상대 Location
// '/jack/status/20' 으로 실제 경로로 가고, 사용자명은 무시된다(틀린 이름도 307 로 교정). twitter.com·mobile. 은 x.com 으로 301/302.
// ★ 404 본문도 og:title 'Post Not Found - X | 404 Error' + 기본 og:image 를 담는다 → 상태코드로 먼저 거른다.
// twitter:card 가 summary 면 og:image 는 작성자 아바타(pbs.twimg.com/profile_images/…_400x400) 라 이미지 없음으로,
// summary_large_image 면 첨부 사진(pbs.twimg.com/media/<id>?format=webp&name=large) 을 ?format=jpg&name=small 로 복사한다.
// oEmbed(publish.x.com) 는 author_name·author_url·html(<p> 안 본문) 만 주고 이미지는 없다. 없는 id·/i/web/status/ 폼은
// HTML 404 라 content-type 확인 필수. t.co 는 301 Location 헤더(본문 0 B) → 첫 Location 만 읽고(firstHopOnly) 호스트로 분기한다:
// X 호스트면 상태 흐름, 아니면(대다수 — 글에 붙은 외부 기사) generic. hopAllow 로 좁히면 fetch.ts 가 외부 홉에서 ssrf:hop_host 를
// 던져(영구 unsupported) 어댑터가 Location 을 볼 수조차 없다.
// 데이터센터 IP 에서 셸이 올 가능성은 미검증 — 그래서 oEmbed 를 2차로 두고 그마저 실패하면 needs_client 로 폰에 넘긴다.

import { canonicalize, matchesHost, parseHttpUrl, pathSegments } from '../canonical.ts';
import { detectBlockPage, normalizeText, parseTags, pickFields, stripTags } from '../html.ts';
import { BUDGET, FIELD_LIMITS } from '../types.ts';
import type {
  CanonicalResult,
  FetchJsonResult,
  FetchTextResult,
  HostPattern,
  PreviewFields,
  ProviderCtx,
  ProviderOutcome,
  ResolveRedirectsResult,
  SiteAdapter,
} from '../types.ts';
import {
  blockErrorCode,
  emptyFields,
  errorCode,
  failed,
  httpErrorCode,
  isOk,
  needsClient,
  ready,
  remainingMs,
  runGeneric,
  unsupported,
} from './generic.ts';

export const X_HOSTS: HostPattern[] = [
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  't.co',
];
/** 상태 페이지 307·twitter.com 301 이 갈 수 있는 곳. t.co 해석에는 쓰지 않는다 — 첫 Location 을 읽어 호스트로 분기한다(resolveTco). */
export const X_HOP_HOSTS: HostPattern[] = [
  't.co',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
];
/** og 블록은 ~4 KB, </head> 는 ~9 KB 에서 끝났다. 여유를 두고 32 KB. */
export const X_STATUS_PAGE_MAX_BYTES = 32 * 1024;

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const STATUS_ID_RE = /^\d{1,25}$/;
const NOT_FOUND_TITLE_RE = /^Post Not Found\b|^Page not found\b|\b404 Error\b/i;
/** 단일 세그먼트 경로 중 프로필이 아닌 것들. */
const RESERVED_PATHS = new Set([
  'i',
  'home',
  'explore',
  'search',
  'settings',
  'login',
  'signup',
  'messages',
  'notifications',
  'intent',
  'hashtag',
  'share',
  'compose',
  'tos',
  'privacy',
  'about',
  'download',
  'jobs',
  'help',
  'account',
]);

export type XTarget =
  | { kind: 'status'; id: string; handle: string | null }
  | { kind: 'profile'; handle: string }
  | { kind: 'tco' }
  | { kind: 'other' };

/**
 * 호스트 허용목록 밖이면 null. 숫자 id 는 /<handle>/status(es)/<id>(/photo/N·/video/N 무시), /i/status/<id>, /i/web/status/<id>
 * 세 폼에서 뽑는다. 쿼리(?s=·?t=) 는 보지 않는다. /<handle> 하나만 있으면 프로필.
 */
export function parseXUrl(u: URL): XTarget | null {
  if (!matchesHost(u.hostname, X_HOSTS)) return null;
  if (u.hostname === 't.co') return { kind: 'tco' };
  const segs = pathSegments(u);
  if (segs.length === 0) return { kind: 'other' };

  if (segs[0] === 'i') {
    const idx = segs[1] === 'status' ? 2 : segs[1] === 'web' && segs[2] === 'status' ? 3 : -1;
    const id = idx > 0 ? segs[idx] : undefined;
    if (id && STATUS_ID_RE.test(id)) return { kind: 'status', id, handle: null };
    return { kind: 'other' };
  }
  if (segs.length >= 3 && (segs[1] === 'status' || segs[1] === 'statuses') && STATUS_ID_RE.test(segs[2])) {
    return { kind: 'status', id: segs[2], handle: HANDLE_RE.test(segs[0]) ? segs[0] : null };
  }
  if (segs.length === 1 && HANDLE_RE.test(segs[0]) && !RESERVED_PATHS.has(segs[0].toLowerCase())) {
    return { kind: 'profile', handle: segs[0] };
  }
  return { kind: 'other' };
}

/** 서버가 실제로 읽는 주소. 사용자명 없이도 307 로 실제 경로에 간다. */
export function xStatusPageUrl(id: string): string {
  return `https://x.com/i/status/${id}`;
}

export function xCanonicalStatusUrl(target: { id: string; handle: string | null }): string {
  return target.handle ? `https://x.com/${target.handle}/status/${target.id}` : xStatusPageUrl(target.id);
}

/** /i/web/status/ 는 oEmbed 가 404 라 항상 /i/status/<id> 로 묻는다. dnt·hide_thread 는 프라이버시·크기용 (관측상 본문 동일). */
export function xOembedUrl(id: string): string {
  return `https://publish.x.com/oembed?url=${encodeURIComponent(xStatusPageUrl(id))}&omit_script=true&dnt=true&hide_thread=true`;
}

/**
 * 첨부 미디어 og:image → 범용 디코드 가능한 ~680px JPEG. 같은 media id 에 ?format=jpg&name=small 만 바꾼다
 * ('/media/<id>?format=webp&name=large' 와 '/media/<id>.jpg' 두 폼 모두 관측). 그 외 호스트·경로는 그대로.
 */
export function xSmallJpegUrl(url: string): string {
  const u = parseHttpUrl(url);
  if (!u || u.hostname !== 'pbs.twimg.com' || !u.pathname.startsWith('/media/')) return url;
  u.pathname = u.pathname.replace(/\.(?:jpe?g|png|webp)$/i, '');
  u.search = '?format=jpg&name=small';
  u.hash = '';
  return u.href;
}

function isAvatarUrl(url: string): boolean {
  return /^https?:\/\/pbs\.twimg\.com\/profile_images\//i.test(url);
}

/** 첨부 미디어·영상 썸네일은 전부 pbs.twimg.com 이다. apple-touch-icon(x.com) 같은 범용 폴백은 X 카드에 쓰지 않는다. */
function isMediaHost(url: string): boolean {
  return parseHttpUrl(url)?.hostname === 'pbs.twimg.com';
}

function dedupe(list: string[]): string[] {
  return list.filter((v, i) => list.indexOf(v) === i);
}

function splitTweetText(text: string | null): { title: string | null; description: string | null } {
  const title = normalizeText(text, FIELD_LIMITS.title, { singleLine: true });
  const full = normalizeText(text, FIELD_LIMITS.description);
  // 한 줄짜리 짧은 글은 제목과 설명이 같아져 카드에 두 번 보인다 → 여러 줄이거나 잘렸을 때만 설명을 채운다
  return { title, description: full && full !== title ? full : null };
}

/**
 * 상태 페이지 HTML → 필드. 상태코드 게이트는 호출자 책임이지만, 폰이 제출한 HTML 일 수도 있어 404 제목 패턴도 한 번 더 거른다.
 *   title ← og:description(본문) (없으면 <title> 'Name on X: "text" / X' 의 따옴표 안, 그래도 없으면 og:title)
 *   author ← og:title 'Name (@handle) on X' 에서 ' on X' 제거
 *   image ← twitter:card 가 summary 면 없음(아바타), 그 외엔 og:image 를 small JPEG 로. 아바타 경로는 어떤 카드든 제외.
 */
export function parseXStatusHtml(html: string, finalUrl: string): PreviewFields | null {
  const tags = parseTags(html);
  const picked = pickFields(tags, finalUrl);
  const { ogTitle, ogDescription, twitterDescription, twitterCard, htmlTitle } = picked.raw;
  if (!ogTitle || NOT_FOUND_TITLE_RE.test(ogTitle)) return null;

  const author = normalizeText(ogTitle.replace(/\s+on\s+(?:X|Twitter)\s*$/i, ''), FIELD_LIMITS.author, {
    singleLine: true,
  });
  let text: string | null = ogDescription ?? twitterDescription;
  if (!text && htmlTitle) {
    const quoted = /on (?:X|Twitter):\s*[“"](.*)[”"]\s*\/\s*(?:X|Twitter)$/s.exec(htmlTitle);
    text = quoted ? quoted[1] : null;
  }
  const { title, description } = splitTweetText(text);

  const card = (twitterCard ?? '').trim().toLowerCase();
  const imageCandidates =
    card === 'summary'
      ? []
      : dedupe(picked.imageCandidates.filter((c) => isMediaHost(c) && !isAvatarUrl(c)).map(xSmallJpegUrl));

  return {
    title: title ?? author,
    description,
    author,
    siteName: 'X',
    canonicalUrl: picked.canonicalUrl,
    imageCandidates,
  };
}

function handleFromAuthorUrl(authorUrl: string | null): string | null {
  const u = authorUrl ? parseHttpUrl(authorUrl) : null;
  if (!u || !matchesHost(u.hostname, X_HOSTS)) return null;
  const first = pathSegments(u)[0];
  return first && HANDLE_RE.test(first) ? first : null;
}

/** html 끝의 '&mdash; Name (@handle) <a>date</a>' 에서 핸들. author_url 이 없을 때의 보조. */
function handleFromHtml(html: string): string | null {
  const m = /&mdash;\s*[^<]*?\(@([A-Za-z0-9_]{1,15})\)/.exec(html);
  return m ? m[1] : null;
}

/**
 * oEmbed html 의 첫 <p> 본문. 끝에 붙는 미디어 자리표시 앵커 'pic.twitter.com/…' 는 지운다(사진 글의 본문이 그 토큰으로 끝나던 문제).
 * <p> 가 없으면(형식 변경 대비) 작성자 서명(&mdash; …) 앞까지를 태그 제거해서 쓴다.
 */
export function tweetTextFromOembedHtml(html: string): string | null {
  const p = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/i.exec(html);
  const inner = p ? p[1] : html.replace(/&mdash;[\s\S]*$/i, '');
  const noPic = inner.replace(/<a\b[^>]*>\s*pic\.(?:twitter|x)\.com\/[^<]*<\/a>/gi, '');
  const text = stripTags(noPic);
  return text.trim() ? text : null;
}

/** publish.x.com 응답(JSON) → 필드. 이미지는 절대 없다. 제목·작성자 둘 다 못 얻으면 null. */
export function parseXOembed(json: unknown): PreviewFields | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  const html = typeof j.html === 'string' ? j.html : '';
  const authorName = typeof j.author_name === 'string' ? j.author_name.trim() : '';
  const handle = handleFromAuthorUrl(typeof j.author_url === 'string' ? j.author_url : null) ?? handleFromHtml(html);
  const authorRaw = authorName ? (handle ? `${authorName} (@${handle})` : authorName) : handle ? `@${handle}` : null;
  const author = normalizeText(authorRaw, FIELD_LIMITS.author, { singleLine: true });

  const text = tweetTextFromOembedHtml(html);
  const split = splitTweetText(text);
  const title =
    split.title ??
    (typeof j.title === 'string' ? normalizeText(j.title, FIELD_LIMITS.title, { singleLine: true }) : null);
  if (!title && !author) return null;

  let canonicalUrl: string | null = null;
  if (typeof j.url === 'string') {
    const u = parseHttpUrl(j.url);
    const t = u ? parseXUrl(u) : null;
    if (t?.kind === 'status') canonicalUrl = xCanonicalStatusUrl(t);
  }
  return {
    title: title ?? author,
    description: split.description,
    author,
    siteName: 'X',
    canonicalUrl,
    imageCandidates: [],
  };
}

type OembedResult = { kind: 'ok'; fields: PreviewFields } | { kind: 'gone' } | { kind: 'error'; error: string };

async function fetchXOembed(ctx: ProviderCtx, id: string): Promise<OembedResult> {
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return { kind: 'error', error: 'timeout' };
  let res: FetchJsonResult;
  try {
    res = await ctx.io.fetchJson(xOembedUrl(id), { timeoutMs, hopAllow: ['publish.x.com', 'publish.twitter.com'] });
  } catch (e) {
    return { kind: 'error', error: errorCode(e) };
  }
  if (res.status === 404 || res.status === 410) return { kind: 'gone' }; // 없는·삭제·비공개 글 (HTML 404 페이지)
  if (!isOk(res.status)) return { kind: 'error', error: httpErrorCode(res.status) };
  const fields = parseXOembed(res.json); // fetchJson 은 content-type 이 JSON 이 아니면 json=null 을 준다
  return fields ? { kind: 'ok', fields } : { kind: 'error', error: 'oembed_invalid' };
}

type ResolvedTco = { kind: 'ok'; url: URL } | { kind: 'failed'; outcome: ProviderOutcome };

/** t.co → t.co 가 이어질 때 첫 홉 읽기를 반복하는 상한 (관측된 적은 없다 — 방어). */
const TCO_MAX_HOPS = 3;

/**
 * t.co → 첫 Location. hopAllow 없이 firstHopOnly 로 읽는다: 홉 0(t.co) 의 SSRF 검사는 그대로 받고, Location 은 따라가지 않고
 * 돌려받아 호출자가 호스트로 분기한다. 외부 기사면 runGeneric 이 자기 fetch 에서 SSRF·리다이렉트 검사를 한다.
 */
async function resolveTco(ctx: ProviderCtx, href: string): Promise<ResolvedTco> {
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return { kind: 'failed', outcome: failed('timeout') };
  let r: ResolveRedirectsResult;
  try {
    r = await ctx.io.resolveRedirects(href, { maxHops: 1, firstHopOnly: true, timeoutMs });
  } catch (e) {
    return { kind: 'failed', outcome: failed(errorCode(e)) };
  }
  if (!r.firstLocation) {
    // 리다이렉트가 아니었다 — 없는 단축 링크는 404(영구), 그 외는 재시도
    const status = r.status ?? 0;
    if (status === 404 || status === 410) return { kind: 'failed', outcome: unsupported('gone') };
    return { kind: 'failed', outcome: failed(status && !isOk(status) ? httpErrorCode(status) : 'tco_unresolved') };
  }
  const u = parseHttpUrl(r.firstLocation);
  return u ? { kind: 'ok', url: u } : { kind: 'failed', outcome: failed('redirect_invalid') };
}

type PageState = { kind: 'shell' } | { kind: 'blocked'; error: string } | { kind: 'error'; error: string };

async function runStatus(ctx: ProviderCtx, target: { id: string; handle: string | null }): Promise<ProviderOutcome> {
  const pageUrl = xStatusPageUrl(target.id);
  const fallbackCanonical = xCanonicalStatusUrl(target);
  const partial = emptyFields({ siteName: 'X', canonicalUrl: fallbackCanonical });

  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return failed('timeout');
  let state: PageState = { kind: 'error', error: 'fetch_failed' };
  let page: FetchTextResult | null = null;
  try {
    page = await ctx.io.fetchText(pageUrl, {
      maxBytes: X_STATUS_PAGE_MAX_BYTES,
      timeoutMs,
      stopAtHead: true,
      hopAllow: X_HOP_HOSTS,
      maxHops: 3, // /i/status 307 + twitter.com 301 정도
    });
  } catch (e) {
    state = { kind: 'error', error: errorCode(e) };
  }

  if (page) {
    // ★ 404 본문의 og('Post Not Found') 는 절대 읽지 않는다 — 삭제·비공개 글은 영구 실패
    if (page.status === 404 || page.status === 410) return unsupported('gone');
    const sig = detectBlockPage(page.status, page.headers, page.text);
    if (sig) {
      state = { kind: 'blocked', error: blockErrorCode(sig) };
    } else if (isOk(page.status)) {
      const fields = parseXStatusHtml(page.text, page.finalUrl);
      if (fields) return ready({ ...fields, canonicalUrl: fields.canonicalUrl ?? fallbackCanonical }, 'og');
      state = { kind: 'shell' }; // og:title 없는 JS 셸 (데이터센터 IP 에서 가능)
    } else {
      state = { kind: 'error', error: httpErrorCode(page.status) };
    }
  }

  ctx.log('x.page_fallback', { state: state.kind, error: 'error' in state ? state.error : undefined });
  const oembed = await fetchXOembed(ctx, target.id);
  if (oembed.kind === 'ok') {
    return ready({ ...oembed.fields, canonicalUrl: oembed.fields.canonicalUrl ?? fallbackCanonical }, 'oembed');
  }
  if (oembed.kind === 'gone') return unsupported('gone');

  // 페이지도 oEmbed 도 안 됐다: 서버가 셸·차단을 받았으면 폰(주거용 IP) 이 같은 페이지를 읽어 본다. 네트워크 오류는 재시도.
  if (state.kind === 'shell') return needsClient('blocked:shell', pageUrl, 'fetch', 'generic', partial);
  if (state.kind === 'blocked') return needsClient(state.error, pageUrl, 'fetch', 'generic', partial);
  return failed(state.error);
}

export const xAdapter: SiteAdapter = {
  id: 'x',
  serverFetch: true,
  imageHosts: [/^pbs\.twimg\.com$/, /^abs\.twimg\.com$/],

  match(u: URL): boolean {
    return matchesHost(u.hostname, X_HOSTS);
  },

  canonicalize(u: URL): CanonicalResult {
    const t = parseXUrl(u);
    if (t?.kind === 'status') {
      const c = xCanonicalStatusUrl(t);
      return { fetchUrl: c, canonicalUrl: c };
    }
    if (t?.kind === 'profile') {
      const c = `https://x.com/${t.handle}`;
      return { fetchUrl: c, canonicalUrl: c };
    }
    return canonicalize(u); // t.co·기타 — 기본 정리(x.com 의 s/t 는 canonical.ts 가 뺀다)
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    let u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    if (!u) return failed('bad_url');
    let target = parseXUrl(u);

    for (let hops = 0; target?.kind === 'tco'; hops++) {
      if (hops >= TCO_MAX_HOPS) return failed('tco_unresolved');
      const resolved = await resolveTco(ctx, u.href);
      if (resolved.kind === 'failed') return resolved.outcome;
      u = resolved.url;
      target = parseXUrl(u);
      if (!target) return runGeneric(ctx, { url: u.href }); // t.co 가 외부 사이트로 — 범용 og (SSRF·홉 검사는 generic fetch 가)
    }
    if (!target || target.kind === 'other') {
      return runGeneric(ctx, { url: u.href, hopAllow: X_HOP_HOSTS });
    }
    if (target.kind === 'profile') {
      return ready(
        emptyFields({
          title: `Posts by @${target.handle}`,
          author: `@${target.handle}`,
          siteName: 'X',
          canonicalUrl: `https://x.com/${target.handle}`,
        }),
        'slug',
      );
    }
    return runStatus(ctx, target);
  },

  parseSubmitted: parseXStatusHtml,
};
