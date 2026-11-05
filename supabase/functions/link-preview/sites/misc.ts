// 소규모 어댑터 묶음 — Reddit·Pinterest·oEmbed 레지스트리(Vimeo/Spotify/SoundCloud/Flickr)·Facebook·LinkedIn·
// 슬러그 전용(Medium/Notion)·서버 차단 사이트(무신사/29CM)
//
// 관측 (2026-11-04 프로브, 주거용 IP·curl 기본 UA):
//   Reddit    HTML 은 200 인데 8 KB JS 챌린지 스텁(<title>Reddit</title>), .json 403, old. 로그인 → fetch 안 함.
//             https://www.reddit.com/oembed?url= 만 title·author_name 을 줬다(이미지·설명 없음). 서브레딧은 경로에서.
//             앱 공유 버튼의 /r/<sub>/s/<shareId> 는 댓글 permalink 로 가는 리다이렉터 — 첫 Location 으로 바꿔 oEmbed 에 묻는다(미검증).
//   Pinterest 핀 페이지 1.38 MB 지만 og 는 <head> 에 완비(og:image i.pinimg.com 비서명). oembed.json 은 title·author·236px.
//   Vimeo/Spotify/SoundCloud/Flickr  고정 keyless oEmbed 가 title(+author/description/thumbnail) 을 줬다.
//   Facebook  공개 글은 og 제공. og:title = 페이지/작성자명, og:description = 본문 앞 ~160자, 텍스트 글엔 og:image 없음.
//   LinkedIn  /posts/ 두 건은 og + JSON-LD SocialMediaPosting 200, /in/·/directory/ 는 HTTP 999(1.5 KB) 차단.
//             미디어 없는 글의 og:image 는 static.licdn.com 플레이스홀더(placeholders.ts 가 거른다).
//             lnkd.in 은 글 본문의 외부 링크도 전부 감싼다 → 첫 Location 만 읽고 LinkedIn 안이면 위 흐름, 밖이면 generic.
//   Medium    403 cf-mitigated: challenge (본문·서브도메인·oEmbed 전부). 폰 fetch 도 JS 없이는 못 넘는다 → 슬러그 제목만.
//   Notion    200 이지만 og 는 전역 기본값(og:url https://app.notion.com), 실제 제목은 HTML 에 없다 → 슬러그 제목만.
//   무신사·29CM  Cloudflare 403 → 서버 fetch 안 함, 폰 1회.

import { canonicalize, matchesHost, parseHttpUrl, pathSegments } from '../canonical.ts';
import { normalizeText, stripTags } from '../html.ts';
import type { ParsedTags } from '../html.ts';
import { BUDGET, FIELD_LIMITS } from '../types.ts';
import type {
  CanonicalResult,
  FetchJsonResult,
  HostPattern,
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
  httpErrorCode,
  isOk,
  needsClient,
  ready,
  remainingMs,
  runGeneric,
  unsupported,
} from './generic.ts';

// ---------------------------------------------------------------------------
// 공용: 슬러그 제목·oEmbed JSON 읽기
// ---------------------------------------------------------------------------

/**
 * 경로 조각 → 사람이 읽을 제목. 'understanding-the-react-native-new-architecture' → 'Understanding the react native new architecture'.
 * 확장자·구분자 정리 뒤 첫 글자만 대문자. 비거나 숫자뿐이면 null (호출자가 '상품 <id>' 등으로 대신한다).
 */
export function deslug(segment: string | null | undefined): string | null {
  if (!segment) return null;
  let s: string;
  try {
    s = decodeURIComponent(segment);
  } catch {
    s = segment;
  }
  s = s
    .replace(/\.(?:html?|php|aspx?|jsp)$/i, '')
    .replace(/[-_+]+/g, ' ')
    .trim();
  if (!s || /^\d+$/.test(s)) return null;
  return normalizeText(s.charAt(0).toUpperCase() + s.slice(1), FIELD_LIMITS.title, { singleLine: true });
}

/** Medium 끝 12-hex id · Notion 32-hex id 를 뗀 슬러그 제목. */
export function slugTitle(u: URL): string | null {
  const segs = pathSegments(u);
  const last = segs.length ? segs[segs.length - 1] : '';
  if (!last) return null;
  const stripped = last.replace(/-?[0-9a-f]{32}$/i, '').replace(/-[0-9a-f]{12}$/i, '');
  return deslug(stripped);
}

interface OembedFields {
  title: string | null;
  author: string | null;
  description: string | null;
  thumbnail: string | null;
  /** type=photo 일 때의 원본 이미지 URL (Flickr). */
  photoUrl: string | null;
  url: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** 표준 oEmbed 키만 읽는다. description 은 HTML 이 섞여 올 수 있어(SoundCloud 의 <a>, &nbsp;) 태그 제거 후 정규화. */
export function readOembed(json: unknown): OembedFields | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  const desc = str(j.description);
  return {
    title: normalizeText(str(j.title), FIELD_LIMITS.title, { singleLine: true }),
    author: normalizeText(str(j.author_name), FIELD_LIMITS.author, { singleLine: true }),
    description: desc ? normalizeText(stripTags(desc), FIELD_LIMITS.description) : null,
    thumbnail: httpOnly(str(j.thumbnail_url)),
    photoUrl: j.type === 'photo' ? httpOnly(str(j.url)) : null,
    url: httpOnly(str(j.url)),
  };
}

function httpOnly(v: string | null): string | null {
  return v && /^https?:\/\//i.test(v) ? v : null;
}

type OembedCall = { kind: 'ok'; fields: OembedFields } | { kind: 'gone' } | { kind: 'error'; error: string };

async function callOembed(ctx: ProviderCtx, endpoint: string, hopAllow: HostPattern[]): Promise<OembedCall> {
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return { kind: 'error', error: 'timeout' };
  let res: FetchJsonResult;
  try {
    res = await ctx.io.fetchJson(endpoint, { timeoutMs, hopAllow });
  } catch (e) {
    return { kind: 'error', error: errorCode(e) };
  }
  if (res.status === 404 || res.status === 410) return { kind: 'gone' };
  if (!isOk(res.status)) return { kind: 'error', error: httpErrorCode(res.status) };
  const fields = readOembed(res.json);
  if (!fields || !fields.title) return { kind: 'error', error: 'oembed_invalid' };
  return { kind: 'ok', fields };
}

function unique(list: Array<string | null>): string[] {
  const out: string[] = [];
  for (const v of list) if (v && !out.includes(v)) out.push(v);
  return out;
}

type FirstHop =
  { kind: 'location'; url: URL } | { kind: 'none'; status: number } | { kind: 'failed'; outcome: ProviderOutcome };

/**
 * 단축·공유 리다이렉터의 첫 Location 만 읽는다 (본문 0 B, 따라가지 않음). hopAllow 를 걸지 않는 이유: fetch.ts 는 허용목록 밖
 * 홉을 ssrf:hop_host 로 던져(영구 unsupported) 어댑터가 Location 을 볼 수 없다. 홉 0 의 SSRF 검사는 그대로 받고, Location 의
 * 호스트 분기와 그 뒤 fetch 의 SSRF·홉 검사는 호출자(또는 generic) 몫이다.
 */
async function readFirstHop(ctx: ProviderCtx, href: string): Promise<FirstHop> {
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return { kind: 'failed', outcome: failed('timeout') };
  let r: ResolveRedirectsResult;
  try {
    r = await ctx.io.resolveRedirects(href, { maxHops: 1, firstHopOnly: true, timeoutMs });
  } catch (e) {
    return { kind: 'failed', outcome: failed(errorCode(e)) };
  }
  if (!r.firstLocation) return { kind: 'none', status: r.status ?? 0 };
  const url = parseHttpUrl(r.firstLocation);
  return url ? { kind: 'location', url } : { kind: 'failed', outcome: failed('redirect_invalid') };
}

/** 리다이렉트가 아니었을 때: 없는 링크(404/410) 는 영구, 그 외는 재시도. */
function noRedirectOutcome(status: number, fallback: string): ProviderOutcome {
  if (status === 404 || status === 410) return unsupported('gone');
  return failed(status && !isOk(status) ? httpErrorCode(status) : fallback);
}

// ---------------------------------------------------------------------------
// Reddit — HTML 미fetch, oEmbed 만
// ---------------------------------------------------------------------------

const REDDIT_HOSTS: HostPattern[] = ['*.reddit.com', 'redd.it'];
const REDDIT_HOP_HOSTS: HostPattern[] = ['*.reddit.com', 'redd.it'];

export function redditOembedUrl(postUrl: string): string {
  return `https://www.reddit.com/oembed?url=${encodeURIComponent(postUrl)}`;
}

/** 쿼리·호스트 변형(old./np./m.) 을 버리고 www.reddit.com + 경로만. Reddit 은 /comments/<id>/ 로만 해석한다. */
function redditCanonical(u: URL): string {
  return `https://www.reddit.com${u.pathname}`;
}

export const redditAdapter: SiteAdapter = {
  id: 'reddit',
  serverFetch: true,

  match(u: URL): boolean {
    return matchesHost(u.hostname, REDDIT_HOSTS);
  },

  canonicalize(u: URL): CanonicalResult {
    if (u.hostname === 'redd.it') return canonicalize(u);
    const c = redditCanonical(u);
    return { fetchUrl: c, canonicalUrl: c };
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    let u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    if (!u) return failed('bad_url');

    if (u.hostname === 'redd.it') {
      const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
      if (timeoutMs <= 0) return failed('timeout');
      try {
        const r = await ctx.io.resolveRedirects(u.href, { maxHops: 3, hopAllow: REDDIT_HOP_HOSTS, timeoutMs });
        const resolved = parseHttpUrl(r.final);
        if (!resolved || resolved.hostname === 'redd.it') return failed('reddit_unresolved');
        u = resolved;
      } catch (e) {
        return failed(errorCode(e));
      }
    }

    let segs = pathSegments(u);
    // 앱 공유 링크 /r/<sub>/s/<shareId> 는 permalink 로 가는 리다이렉터다 — oEmbed 는 /comments/<id>/ 만 받고,
    // canonical 도 permalink 여야 같은 글이 그룹 안에서 하나로 모인다(공유 id 는 공유마다 다르다)
    if (segs[0] === 'r' && segs[2] === 's' && segs[3]) {
      const hop = await readFirstHop(ctx, u.href);
      if (hop.kind === 'failed') return hop.outcome;
      if (hop.kind === 'none') return noRedirectOutcome(hop.status, 'reddit_unresolved');
      if (!matchesHost(hop.url.hostname, REDDIT_HOSTS)) return unsupported('offsite_redirect');
      u = hop.url;
      segs = pathSegments(u);
    }
    const sub = segs[0] === 'r' && segs[1] ? segs[1] : null;
    const canonicalUrl = redditCanonical(u);
    const siteName = sub ? `r/${sub}` : 'Reddit';

    // 서브레딧 루트는 oEmbed 가 없다 — 경로만으로 카드
    if (sub && segs.length <= 2) {
      return ready(emptyFields({ title: `r/${sub}`, siteName: 'Reddit', canonicalUrl }), 'slug');
    }

    const call = await callOembed(ctx, redditOembedUrl(canonicalUrl), REDDIT_HOP_HOSTS);
    if (call.kind === 'gone') return unsupported('gone', emptyFields({ siteName, canonicalUrl }));
    if (call.kind === 'error') return failed(call.error);
    const f = call.fields;
    return ready(
      {
        title: f.title,
        description: f.description,
        author: f.author ? `u/${f.author.replace(/^u\//, '')}` : null,
        siteName,
        canonicalUrl,
        imageCandidates: [], // Reddit oEmbed 엔 썸네일이 없다
      },
      'oembed',
    );
  },
};

// ---------------------------------------------------------------------------
// Pinterest — pin.it 해석 → generic og → 실패 시 oembed.json
// ---------------------------------------------------------------------------

const PINTEREST_HOSTS: HostPattern[] = ['*.pinterest.com', 'pin.it'];
const PINTEREST_HOP_HOSTS: HostPattern[] = ['*.pinterest.com', 'pin.it'];
const PIN_ID_RE = /^\/pin\/(?:[^/]*--)?(\d+)\/?/;

export function pinterestPinUrl(id: string): string {
  return `https://www.pinterest.com/pin/${id}/`;
}

export function pinterestOembedUrl(pinUrl: string): string {
  return `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(pinUrl)}`;
}

/** kr./uk. 등 지역 호스트와 슬러그 폼('pearl-barley-broth-recipe--3219…') 을 www.pinterest.com/pin/<id>/ 로. */
function pinterestCanonical(u: URL): string | null {
  const m = PIN_ID_RE.exec(u.pathname);
  return m ? pinterestPinUrl(m[1]) : null;
}

export const pinterestAdapter: SiteAdapter = {
  id: 'pinterest',
  serverFetch: true,
  imageHosts: [/(?:^|\.)pinimg\.com$/i],

  match(u: URL): boolean {
    return matchesHost(u.hostname, PINTEREST_HOSTS);
  },

  canonicalize(u: URL): CanonicalResult {
    const c = pinterestCanonical(u);
    return c ? { fetchUrl: c, canonicalUrl: c } : canonicalize(u);
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    let u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    if (!u) return failed('bad_url');

    if (u.hostname === 'pin.it') {
      const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
      if (timeoutMs <= 0) return failed('timeout');
      try {
        const r = await ctx.io.resolveRedirects(u.href, { maxHops: 5, hopAllow: PINTEREST_HOP_HOSTS, timeoutMs });
        const resolved = parseHttpUrl(r.final);
        if (!resolved || resolved.hostname === 'pin.it') return failed('pinterest_unresolved');
        u = resolved;
      } catch (e) {
        return failed(errorCode(e));
      }
    }

    const pinUrl = pinterestCanonical(u);
    const pageUrl = pinUrl ?? u.href;
    const page = await runGeneric(ctx, { url: pageUrl, hopAllow: PINTEREST_HOP_HOSTS });
    if (page.kind === 'ready' && page.fields.title) {
      return ready(
        {
          ...page.fields,
          siteName: page.fields.siteName ?? 'Pinterest',
          canonicalUrl: pinUrl ?? page.fields.canonicalUrl,
        },
        'og',
      );
    }
    if (!pinUrl) return page; // 보드·프로필은 oEmbed 범위 밖

    const call = await callOembed(ctx, pinterestOembedUrl(pinUrl), PINTEREST_HOP_HOSTS);
    if (call.kind !== 'ok') return page.kind === 'ready' ? page : call.kind === 'gone' ? unsupported('gone') : page;
    const f = call.fields;
    return ready(
      {
        title: f.title,
        description: f.description,
        author: f.author,
        siteName: 'Pinterest',
        canonicalUrl: pinUrl,
        imageCandidates: unique([f.thumbnail]),
      },
      'oembed',
    );
  },
};

// ---------------------------------------------------------------------------
// oEmbed 레지스트리 — 고정 엔드포인트 (키 불필요, content-type JSON 확인은 fetchJson 이 한다)
// ---------------------------------------------------------------------------

interface OembedProvider {
  id: string;
  siteName: string;
  hosts: HostPattern[];
  /** url= 파라미터 앞까지. 호출 시 encodeURIComponent(fetchUrl) 을 붙인다. */
  endpoint: string;
  hopAllow: HostPattern[];
}

export const OEMBED_PROVIDERS: readonly OembedProvider[] = [
  {
    id: 'vimeo',
    siteName: 'Vimeo',
    hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
    endpoint: 'https://vimeo.com/api/oembed.json?url=',
    hopAllow: ['*.vimeo.com'],
  },
  {
    id: 'spotify',
    siteName: 'Spotify',
    hosts: ['open.spotify.com', 'spotify.link'],
    endpoint: 'https://open.spotify.com/oembed?url=',
    hopAllow: ['*.spotify.com'],
  },
  {
    id: 'soundcloud',
    siteName: 'SoundCloud',
    hosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'],
    endpoint: 'https://soundcloud.com/oembed?format=json&url=',
    hopAllow: ['*.soundcloud.com'],
  },
  {
    id: 'flickr',
    siteName: 'Flickr',
    hosts: ['*.flickr.com', 'flic.kr'],
    endpoint: 'https://www.flickr.com/services/oembed/?format=json&url=',
    hopAllow: ['*.flickr.com'],
  },
];

export function findOembedProvider(u: URL): OembedProvider | null {
  for (const p of OEMBED_PROVIDERS) if (matchesHost(u.hostname, p.hosts)) return p;
  return null;
}

export const oembedRegistryAdapter: SiteAdapter = {
  id: 'oembed',
  serverFetch: true,

  match(u: URL): boolean {
    return findOembedProvider(u) !== null;
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    const provider = u ? findOembedProvider(u) : null;
    if (!u || !provider) return runGeneric(ctx);

    const call = await callOembed(ctx, provider.endpoint + encodeURIComponent(u.href), provider.hopAllow);
    if (call.kind !== 'ok') {
      // 404(비공개·삭제)·형식 불일치·네트워크 오류 전부 페이지 og 로 한 번 더 — 이 사이트들은 og 도 정상이다
      ctx.log('oembed.fallback_generic', { provider: provider.id, reason: call.kind === 'gone' ? 'gone' : call.error });
      const page = await runGeneric(ctx);
      if (page.kind === 'ready')
        return ready({ ...page.fields, siteName: page.fields.siteName ?? provider.siteName }, 'og');
      return call.kind === 'gone' ? unsupported('gone') : page;
    }
    const f = call.fields;
    return ready(
      {
        title: f.title,
        description: f.description,
        author: f.author,
        siteName: provider.siteName,
        canonicalUrl: ctx.canonicalUrl,
        imageCandidates: unique([f.photoUrl, f.thumbnail]), // Flickr 는 원본(url) 이 1024px, thumbnail 은 150px
      },
      'oembed',
    );
  },
};

// ---------------------------------------------------------------------------
// Facebook — generic og 재매핑 (og:description = 본문 → 제목, og:title = 페이지명 → 작성자)
// ---------------------------------------------------------------------------

const FACEBOOK_HOSTS: HostPattern[] = ['*.facebook.com', 'fb.com', 'www.fb.com', 'fb.watch', 'fb.me'];
const FACEBOOK_HOP_HOSTS: HostPattern[] = ['*.facebook.com', 'fb.com', 'www.fb.com', 'fb.watch', 'fb.me'];
/** 앱 공유 시트·알림 링크가 붙이는 추적 파라미터. 전역 utm_* 는 canonical.ts 가 뺀다. */
const FACEBOOK_TRACKING_RE =
  /^(?:mibextid|rdid|share_url|__tn__|__cft__\[\d+\]|refid|ref|_rdr|_rdc|hc_ref|fref|__xts__\[\d+\]|eid|notif_id|notif_t)$/i;
const FACEBOOK_LOGIN_TITLE_RE = /^facebook$|log ?in|sign ?up|로그인|가입/i;

export function facebookCanonicalize(u: URL): CanonicalResult {
  const base = canonicalize(u);
  const out = new URL(base.canonicalUrl);
  for (const key of Array.from(new Set(Array.from(out.searchParams.keys())))) {
    if (FACEBOOK_TRACKING_RE.test(key)) out.searchParams.delete(key);
  }
  if (out.searchParams.toString() === '') out.search = '';
  return { fetchUrl: out.href, canonicalUrl: out.href };
}

export const facebookAdapter: SiteAdapter = {
  id: 'facebook',
  serverFetch: true,
  imageHosts: [/(?:^|\.)fbcdn\.net$/i, /(?:^|\.)facebook\.com$/i],

  match(u: URL): boolean {
    return matchesHost(u.hostname, FACEBOOK_HOSTS);
  },

  canonicalize: facebookCanonicalize,

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const r = await fetchPage(ctx, { hopAllow: FACEBOOK_HOP_HOSTS });
    if (r.done) return r.outcome;
    const { res, fields } = r.page;
    const { ogTitle, ogDescription, htmlTitle } = fields.raw;
    const canonicalUrl = fields.canonicalUrl ?? ctx.canonicalUrl;

    // 데이터센터 IP 에선 로그인 벽이 올 수 있다 — og:title 이 'Facebook'/로그인 문구이거나 /login 으로 보내지면 폰이 1회
    const finalPath = parseHttpUrl(res.finalUrl)?.pathname ?? '';
    const loginWall = /^\/(?:login|checkpoint)\b/i.test(finalPath) || !ogTitle || FACEBOOK_LOGIN_TITLE_RE.test(ogTitle);
    if (loginWall) {
      return needsClient(
        'blocked:login',
        ctx.fetchUrl,
        'fetch',
        'generic',
        emptyFields({ siteName: 'Facebook', canonicalUrl }),
      );
    }

    // <title> 'Mark Zuckerberg - My great grandparents came…' 의 앞 이름을 떼면 본문 요약이 된다 (og:description 없을 때)
    const fromTitle =
      htmlTitle && ogTitle && htmlTitle.startsWith(ogTitle)
        ? htmlTitle.slice(ogTitle.length).replace(/^\s*[-–|:]\s*/, '')
        : null;
    const body = ogDescription ?? fromTitle;
    const title = normalizeText(body, FIELD_LIMITS.title, { singleLine: true }) ?? fields.title;
    const full = normalizeText(body, FIELD_LIMITS.description);

    return finalizeGeneric(ctx, r.page, {
      title,
      description: full && full !== title ? full : null,
      author: normalizeText(ogTitle, FIELD_LIMITS.author, { singleLine: true }),
      siteName: 'Facebook',
      canonicalUrl,
    });
  },
};

// ---------------------------------------------------------------------------
// LinkedIn — /posts/ 는 og + JSON-LD, 999 는 1회만 폰에, /in/ 프로필은 바로 unsupported
// ---------------------------------------------------------------------------

const LINKEDIN_HOSTS: HostPattern[] = ['*.linkedin.com', 'lnkd.in'];
const LINKEDIN_HOP_HOSTS: HostPattern[] = ['*.linkedin.com', 'lnkd.in'];
const LINKEDIN_TRACKING_RE =
  /^(?:trk|trackingId|lipi|licu|rcm|refId|originalSubdomain|midToken|midSig|trkEmail|otpToken|eid)$/i;

export function linkedinCanonicalize(u: URL): CanonicalResult {
  const base = canonicalize(u);
  const out = new URL(base.canonicalUrl);
  for (const key of Array.from(new Set(Array.from(out.searchParams.keys())))) {
    if (LINKEDIN_TRACKING_RE.test(key)) out.searchParams.delete(key);
  }
  if (out.searchParams.toString() === '') out.search = '';
  return { fetchUrl: out.href, canonicalUrl: out.href };
}

/** JSON-LD SocialMediaPosting(또는 @graph 안) 의 author.name. */
function linkedinAuthorFromJsonLd(tags: ParsedTags): string | null {
  const visit = (node: unknown, depth: number): string | null => {
    if (depth > 3 || !node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const o = node as Record<string, unknown>;
    const type = o['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => t === 'SocialMediaPosting' || t === 'DiscussionForumPosting' || t === 'Article')) {
      const author = o.author;
      const a = Array.isArray(author) ? author[0] : author;
      const name = a && typeof a === 'object' ? (a as Record<string, unknown>).name : null;
      if (typeof name === 'string' && name.trim()) return name;
    }
    return visit(o['@graph'], depth + 1);
  };
  return visit(tags.jsonLd, 0);
}

/** linkedin.com URL 본체. ctx.fetchUrl/canonicalUrl 은 lnkd.in 이 아니라 실제 LinkedIn 주소여야 한다 (run 이 보장). */
async function runLinkedin(ctx: ProviderCtx, u: URL): Promise<ProviderOutcome> {
  const segs = pathSegments(u);
  const slug = emptyFields({
    title: ctx.hintTitle ?? slugTitle(u),
    siteName: 'LinkedIn',
    canonicalUrl: ctx.canonicalUrl,
  });

  // 프로필은 로그인 벽·999 가 기본값이라 시도조차 안 한다 — 슬러그('savas-tutumlu' → 'Savas tutumlu') 로 카드
  if (segs[0] === 'in' || segs[0] === 'company' || segs[0] === 'school') {
    return unsupported('login_wall', emptyFields({ ...slug, title: ctx.hintTitle ?? deslug(segs[1]) }));
  }

  const r = await fetchPage(ctx, { hopAllow: LINKEDIN_HOP_HOSTS });
  if (r.done) {
    const o = r.outcome;
    if (o.kind !== 'needs_client') return o;
    // 999/차단은 폰에 1회만 맡긴다 — 두 번째 시도도 막혔으면 영구 포기 (IP 평판에 따라 흔들리는 사이트)
    const error = o.error === 'blocked:waf' ? 'blocked:linkedin' : o.error;
    if (ctx.attempts > 1) return unsupported(error, slug);
    return needsClient(error, o.task.url, o.task.runner, o.task.parser, slug);
  }

  const { tags, fields } = r.page;
  const ogTitle = fields.raw.ogTitle ?? fields.title;
  // og:title '#imageprocessing #dip | Hardik Kamboj | 12 comments' → 본문 조각 | 작성자 | 댓글 수
  const parts = ogTitle ? ogTitle.split(/\s+\|\s+/) : [];
  const lastIsCount = parts.length >= 2 && /\b(?:comments?|댓글)\b/i.test(parts[parts.length - 1]);
  const titlePart =
    parts.length >= 3 && lastIsCount
      ? parts.slice(0, -2).join(' | ')
      : parts.length === 2 && lastIsCount
        ? parts[0]
        : ogTitle;
  const authorPart = parts.length >= 3 && lastIsCount ? parts[parts.length - 2] : null;
  const author = linkedinAuthorFromJsonLd(tags) ?? authorPart ?? fields.author;

  return finalizeGeneric(ctx, r.page, {
    title: normalizeText(titlePart, FIELD_LIMITS.title, { singleLine: true }) ?? fields.title,
    author: normalizeText(author, FIELD_LIMITS.author, { singleLine: true }),
    siteName: 'LinkedIn',
  });
}

export const linkedinAdapter: SiteAdapter = {
  id: 'linkedin',
  serverFetch: true,
  imageHosts: [/(?:^|\.)licdn\.com$/i],

  match(u: URL): boolean {
    return matchesHost(u.hostname, LINKEDIN_HOSTS);
  },

  canonicalize: linkedinCanonicalize,

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    if (!u) return failed('bad_url');
    if (u.hostname !== 'lnkd.in') return runLinkedin(ctx, u);

    // lnkd.in 은 첫 Location 만 읽고 분기한다. hopAllow 로 따라가면 외부 기사(대다수) 가 ssrf:hop_host 로 영구 실패한다.
    const hop = await readFirstHop(ctx, u.href);
    if (hop.kind === 'failed') return hop.outcome;
    if (hop.kind === 'none') return noRedirectOutcome(hop.status, 'lnkd_unresolved');
    if (hop.url.hostname === 'lnkd.in') return failed('lnkd_unresolved');
    if (!matchesHost(hop.url.hostname, LINKEDIN_HOSTS)) return runGeneric(ctx, { url: hop.url.href }); // 외부 기사 — 범용 og
    const c = linkedinCanonicalize(hop.url);
    return runLinkedin({ ...ctx, fetchUrl: c.fetchUrl, canonicalUrl: c.canonicalUrl }, new URL(c.fetchUrl));
  },
};

// ---------------------------------------------------------------------------
// 슬러그 전용 — Medium·Notion (서버 fetch 없음)
// ---------------------------------------------------------------------------

const MEDIUM_HOSTS: HostPattern[] = ['medium.com', '*.medium.com'];
const NOTION_HOSTS: HostPattern[] = ['*.notion.site'];

/** Medium 의 작성자: medium.com/@user/… 또는 user.medium.com. */
function mediumAuthor(u: URL): string | null {
  const first = pathSegments(u)[0];
  if (first && first.startsWith('@') && first.length > 1) return first;
  const sub = u.hostname.replace(/\.medium\.com$/, '');
  if (sub !== u.hostname && sub !== 'www' && sub !== 'medium') return `@${sub}`;
  return null;
}

export const slugAdapter: SiteAdapter = {
  id: 'slug',
  serverFetch: false,

  match(u: URL): boolean {
    return matchesHost(u.hostname, MEDIUM_HOSTS) || matchesHost(u.hostname, NOTION_HOSTS);
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    if (!u) return failed('bad_url');
    const isMedium = matchesHost(u.hostname, MEDIUM_HOSTS);
    const fromSlug = slugTitle(u);
    const title = ctx.hintTitle ?? fromSlug;
    const source: PreviewSource = ctx.hintTitle ? 'hint' : 'slug';
    return ready(
      emptyFields({
        title,
        author: isMedium ? mediumAuthor(u) : null,
        siteName: isMedium ? 'Medium' : 'Notion',
        canonicalUrl: ctx.canonicalUrl,
      }),
      source,
    );
  },
};

// ---------------------------------------------------------------------------
// 서버 차단 사이트 — 무신사·29CM (Cloudflare 403). 서버는 손대지 않고 폰이 1회 fetch
// ---------------------------------------------------------------------------

interface BlockedSite {
  hosts: HostPattern[];
  siteName: string;
}

const BLOCKED_SITES: readonly BlockedSite[] = [
  { hosts: ['musinsa.com', '*.musinsa.com'], siteName: '무신사' },
  { hosts: ['29cm.co.kr', '*.29cm.co.kr'], siteName: '29CM' },
];

function findBlockedSite(u: URL): BlockedSite | null {
  for (const s of BLOCKED_SITES) if (matchesHost(u.hostname, s.hosts)) return s;
  return null;
}

/** 임시 제목: 공유 텍스트 힌트 → 슬러그 → 마지막 숫자 조각으로 '<사이트> 상품 <id>'. */
export function blockedSiteTitle(u: URL, siteName: string, hint: string | null): string | null {
  if (hint) return hint;
  const segs = pathSegments(u);
  const fromSlug = slugTitle(u);
  if (fromSlug) return fromSlug;
  const numeric = [...segs].reverse().find((s) => /^\d+$/.test(s));
  return numeric ? `${siteName} 상품 ${numeric}` : null;
}

export const blockedSitesAdapter: SiteAdapter = {
  id: 'blocked',
  serverFetch: false,

  match(u: URL): boolean {
    return findBlockedSite(u) !== null;
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    if (!u) return failed('bad_url');
    const site = findBlockedSite(u);
    const siteName = site?.siteName ?? null;
    return needsClient(
      'blocked:cloudflare',
      ctx.fetchUrl,
      'fetch',
      'generic',
      emptyFields({
        title: siteName ? blockedSiteTitle(u, siteName, ctx.hintTitle) : ctx.hintTitle,
        siteName,
        canonicalUrl: ctx.canonicalUrl,
      }),
    );
  },
};
