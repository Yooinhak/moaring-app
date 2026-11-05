// Instagram 어댑터 (+ Threads) — 공개 임베드 페이지 /p/<code>/embed/captioned/ 파싱. oEmbed·Microlink 는 쓰지 않는다.
//
// 관측 근거 (2026-11-04 프로브, 주거용 IP·curl 기본 UA, Edge egress 미검증):
//   게시물 페이지(≈580 KB)    og:title·og:description 없음, <title> 'Instagram'. 있는 것: og:image(서명 CDN), og:url(/<user>/reel/<code>/),
//                            twitter:title '이름 (@user) • Instagram reel'(엔티티 인코딩). 캡션은 본문 어디에도 없다 → 폴백 전용
//   /embed/captioned/(≈230 KB) 서버 렌더, og·<title> 없음, 쓸 만한 JSON 없음. <img class="EmbeddedMediaImage" src srcset(1206w…150w)>,
//                            <span class="UsernameText">, <div class="Caption"><a class="CaptionUsername">…</a><br />캡션…<div class="CaptionComments">.
//                            /p/·/reel/ 코드 호환(리다이렉트 0) — 항상 /p/<code>/ 로 통일해 요청한다. igsh 제거는 응답에 영향 없음
//   삭제·비공개              페이지는 302 → /<user>/ 프로필, 임베드는 200 + class="EmbedBrokenMedia"(≈184 KB) → unsupported('gone')
//   썸네일 CDN               oe=(hex epoch) 서명 ~4.4일 뒤 만료, 쿼리 제거 시 403 'Bad URL hash' → 같은 처리 안에서 즉시 복사, 쿼리 변경 금지
//   Threads                 게시물 페이지 og 완비: og:title 'Name (@handle) on Threads', og:description = 본문, og:image = 아바타
//                            (경로 t51.82787-19 → placeholders.ts 가 이미 제외). threads.net → .com 301. 첨부 미디어 글은 미검증
//
// 비공식 마크업이라 바뀌면 needs_client 가 늘어난다(모니터링 SQL 로 감지). Meta oEmbed 약관의 영속 금지 조항을 직접 적용받지 않도록
// oEmbed 는 쓰지 않는다. 캡션 저장 범위는 decisionsForUser — 기본은 제목(첫 줄 ≤80자) 만, env INSTAGRAM_STORE_CAPTION=full 일 때만
// 전체 캡션을 설명에 넣는다. 네트워크는 ctx.io 만.

import { canonicalize, matchesHost, parseHttpUrl, pathSegments } from '../canonical.ts';
import { decodeEntities } from '../entities.ts';
import {
  firstLine,
  normalizeFields,
  normalizeText,
  parseAttrs,
  parseTags,
  pickFields,
  resolveUrl,
  stripTags,
} from '../html.ts';
import type { PickedFields } from '../html.ts';
import { BUDGET, FIELD_LIMITS } from '../types.ts';
import type {
  CanonicalResult,
  FetchTextResult,
  HostPattern,
  PreviewFields,
  ProviderCtx,
  ProviderOutcome,
  SiteAdapter,
} from '../types.ts';
import {
  emptyFields,
  errorCode,
  failed,
  fetchPage,
  isOk,
  needsClient,
  ready,
  runGeneric,
  remainingMs,
  unsupported,
} from './generic.ts';

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/** 정확히 이 호스트들만 — 'instagram.com.evil.com' 이 인스타로 보이면 안 된다. */
export const INSTAGRAM_HOSTS: HostPattern[] = [
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am',
];
const INSTAGRAM_HOP_HOSTS: HostPattern[] = ['*.instagram.com', 'instagr.am'];
/** 게시물 미디어·아바타 CDN. 폰이 제출한 image_url 도 여기 맞아야 재다운로드한다. */
export const INSTAGRAM_IMAGE_HOSTS: RegExp[] = [/(?:^|\.)cdninstagram\.com$/i, /(?:^|\.)fbcdn\.net$/i];

/** 캡션이 본문 뒤에 있어 조기중단 없이 읽는다. 관측 최대 235 KB — 512 KB 면 여유. */
const EMBED_MAX_BYTES = 512 * 1024;
/** srcset 에서 이 폭 이하의 가장 큰 변형을 먼저 — 카드 썸네일에 1080w 원본은 과하고 3 MiB 캡·대역폭을 아낀다. */
const MAX_SRCSET_WIDTH = 640;

const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,}$/;
const MEDIA_SEGMENTS = new Set(['p', 'reel', 'reels', 'tv']);
/** 미디어 세그먼트 뒤에 오지만 shortcode 가 아닌 예약어 — /reels/audio/<id>/ 가 'audio' 를 코드로 읽혀 전부 /p/audio/ 로 묶였다. */
const RESERVED_AFTER_MEDIA = new Set(['audio', 'embed', 'explore', 'videos']);
const USERNAME_RE = /^[A-Za-z0-9_.]{1,30}$/;

/** /p|reel|reels|tv/<code>/ 또는 og:url 폼 /<username>/reel/<code>/. 프로필·탐색·/reels/audio/ 등은 null(generic). */
export function extractInstagramShortcode(u: URL): string | null {
  if (!matchesHost(u.hostname, INSTAGRAM_HOSTS)) return null;
  const segs = pathSegments(u);
  for (const i of [0, 1]) {
    const code = segs[i + 1] ?? '';
    if (MEDIA_SEGMENTS.has(segs[i] ?? '') && SHORTCODE_RE.test(code) && !RESERVED_AFTER_MEDIA.has(code)) {
      if (i === 1 && !USERNAME_RE.test(segs[0])) return null;
      return code;
    }
  }
  return null;
}

export const instagramPostUrl = (code: string): string => `https://www.instagram.com/p/${code}/`;
export const instagramEmbedUrl = (code: string): string => `https://www.instagram.com/p/${code}/embed/captioned/`;

export type InstagramLanding = 'post' | 'profile' | 'login' | 'other';

/** 리다이렉트가 어디로 끝났나. 프로필(/<user>/) 은 삭제·비공개, /accounts/login/ 은 로그인 벽. */
export function classifyInstagramUrl(url: string): InstagramLanding {
  const u = parseHttpUrl(url);
  if (!u) return 'other';
  const segs = pathSegments(u);
  if (segs[0] === 'accounts') return 'login';
  if (extractInstagramShortcode(u)) return 'post';
  if (segs.length === 1 && USERNAME_RE.test(segs[0])) return 'profile';
  return 'other';
}

// ---------------------------------------------------------------------------
// 임베드 파서 (순수 — 폰이 제출한 HTML 에도 같은 규칙)
// ---------------------------------------------------------------------------

export interface InstagramEmbed {
  /** class="EmbedBrokenMedia" — 삭제·비공개·임베드 금지 (HTTP 는 200) */
  broken: boolean;
  username: string | null;
  /** CaptionUsername 제거, <br> → 줄바꿈, 태그 제거, 엔티티 디코드, 공백 정리. 없으면 null */
  caption: string | null;
  /** [≤640w srcset 변형, 원본 src] 순 — 복사 단계가 첫 성공만 저장한다 */
  imageCandidates: string[];
  /** 루트 <div class="Embed" data-media-type> — GraphVideo | GraphImage | GraphSidecar (사진·캐러셀은 미검증) */
  mediaType: string | null;
}

const BROKEN_RE = /\bclass\s*=\s*["'][^"']*\bEmbedBrokenMedia\b/i;
const MEDIA_IMG_RE = /<img\b[^>]*\bclass\s*=\s*["'][^"']*\bEmbeddedMediaImage\b[^"']*["'][^>]*>/i;
const USERNAME_TEXT_RE = /<span\b[^>]*\bclass\s*=\s*["'][^"']*\bUsernameText\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;
/** 정확히 class="Caption" — CaptionUsername·CaptionComments 와 구분 */
const CAPTION_OPEN_RE = /<div\b[^>]*\bclass\s*=\s*["']Caption["'][^>]*>/i;
const CAPTION_END_RE = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bCaptionComments\b/i;
const CAPTION_USERNAME_RE = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bCaptionUsername\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i;
const MEDIA_TYPE_RE = /\bdata-media-type\s*=\s*["']([A-Za-z]+)["']/;
const ALT_USERNAME_RE = /shared by @([A-Za-z0-9_.]{1,30})/i;

function cleanUsername(raw: string | null | undefined): string | null {
  const v = normalizeText(raw, 64, { singleLine: true })?.replace(/^@/, '') ?? null;
  return v && USERNAME_RE.test(v) ? v : null;
}

/**
 * srcset 에서 maxWidth 이하의 가장 큰 변형 URL. 항목은 'url 608w,url 480w' 꼴(쉼표 뒤 공백 없음) 이라 쉼표 뒤에 URL 이
 * 시작하는 자리에서만 나눈다 — URL 안의 %2C 는 건드리지 않는다. 값은 이미 엔티티 디코드된 상태로 받는다.
 */
export function pickSrcsetVariant(srcset: string, maxWidth = MAX_SRCSET_WIDTH): string | null {
  let best: { url: string; w: number } | null = null;
  for (const entry of srcset.split(/,(?=\s*https?:\/\/)/i)) {
    const m = /^\s*(\S+)\s+(\d+)w\s*$/.exec(entry);
    if (!m) continue;
    const w = Number(m[2]);
    if (w > maxWidth) continue;
    if (!best || w > best.w) best = { url: m[1], w };
  }
  return best?.url ?? null;
}

export function parseInstagramEmbedRaw(html: string): InstagramEmbed {
  const broken = BROKEN_RE.test(html);

  const imageCandidates: string[] = [];
  let altUsername: string | null = null;
  const img = MEDIA_IMG_RE.exec(html);
  if (img) {
    const attrs = parseAttrs(img[0].slice(4, -1)); // '<img' 와 '>' 사이 — 값은 parseAttrs 가 디코드(&amp; → &)
    const variant = attrs.srcset ? pickSrcsetVariant(attrs.srcset) : null;
    for (const c of [variant, attrs.src]) {
      const r = c ? resolveUrl(c, 'https://www.instagram.com/') : null;
      if (r && !imageCandidates.includes(r)) imageCandidates.push(r);
    }
    altUsername = cleanUsername(ALT_USERNAME_RE.exec(attrs.alt ?? '')?.[1]);
  }

  let caption: string | null = null;
  let captionUsername: string | null = null;
  const open = CAPTION_OPEN_RE.exec(html);
  if (open) {
    const start = open.index + open[0].length;
    const rest = html.slice(start, start + 65536); // 캡션은 길어도 수 KB
    const end = CAPTION_END_RE.exec(rest);
    const endAt = end ? end.index : rest.search(/<\/div\s*>/i);
    const inner = endAt >= 0 ? rest.slice(0, endAt) : rest;
    const cu = CAPTION_USERNAME_RE.exec(inner);
    captionUsername = cleanUsername(cu ? decodeEntities(cu[1]) : null);
    caption = normalizeText(stripTags(cu ? inner.replace(cu[0], '') : inner), 4000);
  }

  const um = USERNAME_TEXT_RE.exec(html);
  const username = cleanUsername(um ? decodeEntities(um[1]) : null) ?? altUsername ?? captionUsername;
  const mediaType = MEDIA_TYPE_RE.exec(html)?.[1] ?? null;
  return { broken, username, caption, imageCandidates, mediaType };
}

export interface InstagramParseOptions {
  /** env INSTAGRAM_STORE_CAPTION=full — 전체 캡션을 설명에. 기본 false (제목 첫 줄만). */
  storeCaption?: boolean;
}

function embedFields(raw: InstagramEmbed, storeCaption: boolean): PreviewFields | null {
  if (raw.broken) return null;
  if (!raw.username && !raw.caption && raw.imageCandidates.length === 0) return null;
  return normalizeFields({
    title: firstLine(raw.caption, 80) ?? (raw.username ? `@${raw.username} • Instagram` : null),
    description: storeCaption ? raw.caption : null,
    author: raw.username ? `@${raw.username}` : null,
    siteName: 'Instagram',
    canonicalUrl: null, // 어댑터가 /p/<code>/ 로 채운다
    imageCandidates: raw.imageCandidates,
  });
}

/** 임베드 HTML → 필드. 깨진 글(EmbedBrokenMedia) 이나 아무것도 못 찾으면 null. parseSubmitted 로도 쓴다. */
export function parseInstagramEmbed(html: string, opts: InstagramParseOptions = {}): PreviewFields | null {
  return embedFields(parseInstagramEmbedRaw(html), opts.storeCaption ?? false);
}

// ---------------------------------------------------------------------------
// 게시물 페이지 폴백 파서 — og:image + twitter:title 만 (캡션 없음)
// ---------------------------------------------------------------------------

const TWITTER_TITLE_SUFFIX_RE = /\s*[•·]\s*Instagram\b.*$/i;

function usernameFromPage(ogUrl: string | null, twitterTitle: string | null): string | null {
  const u = ogUrl ? parseHttpUrl(ogUrl) : null;
  if (u) {
    const segs = pathSegments(u);
    if (segs.length >= 2 && MEDIA_SEGMENTS.has(segs[1]) && USERNAME_RE.test(segs[0])) return segs[0];
  }
  const m = twitterTitle ? /\(@([A-Za-z0-9_.]{1,30})\)/.exec(twitterTitle) : null;
  return m ? m[1] : null;
}

/** '이름 (@user) • Instagram reel' → author '이름 (@user)', og:url 의 /<user>/ → '@user • Instagram' 제목. 둘 다 없으면 null. */
export function parseInstagramPage(html: string, finalUrl: string): PreviewFields | null {
  const f: PickedFields = pickFields(parseTags(html), finalUrl);
  const tw = f.raw.twitterTitle;
  const author = tw
    ? normalizeText(tw.replace(TWITTER_TITLE_SUFFIX_RE, ''), FIELD_LIMITS.author, { singleLine: true })
    : null;
  if (!author && f.imageCandidates.length === 0) return null;
  const username = usernameFromPage(f.raw.ogUrl, tw);
  return normalizeFields({
    title: username ? `@${username} • Instagram` : null,
    description: null,
    author,
    siteName: 'Instagram',
    canonicalUrl: null, // og:url 은 /<user>/reel/<code>/ 폼 — 어댑터가 /p/<code>/ 로 통일
    imageCandidates: f.imageCandidates,
  });
}

// ---------------------------------------------------------------------------
// 어댑터
// ---------------------------------------------------------------------------

/** env INSTAGRAM_STORE_CAPTION=full 이면 전체 캡션 저장. Deno 밖(bun 테스트) 과 권한 없음은 조용히 false. */
function instagramStoreCaption(): boolean {
  try {
    const env = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno?.env;
    return env?.get('INSTAGRAM_STORE_CAPTION') === 'full';
  } catch {
    return false;
  }
}

function codeFromCtx(ctx: ProviderCtx): string | null {
  for (const s of [ctx.postUrl, ctx.canonicalUrl, ctx.fetchUrl]) {
    const u = parseHttpUrl(s);
    const code = u ? extractInstagramShortcode(u) : null;
    if (code) return code;
  }
  return null;
}

async function runInstagram(ctx: ProviderCtx): Promise<ProviderOutcome> {
  const code = codeFromCtx(ctx);
  if (!code) return runGeneric(ctx, { hopAllow: INSTAGRAM_HOP_HOSTS }); // match 가 걸렀지만 방어
  const canonicalUrl = instagramPostUrl(code);
  const embedUrl = instagramEmbedUrl(code);
  const storeCaption = instagramStoreCaption();
  const gone = () => unsupported('gone', emptyFields({ siteName: 'Instagram', canonicalUrl }));

  // 1) 임베드 — 캡션·이미지·작성자가 전부 여기 있다
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return failed('timeout');
  let embed: FetchTextResult | null = null;
  try {
    embed = await ctx.io.fetchText(embedUrl, {
      maxBytes: EMBED_MAX_BYTES,
      timeoutMs,
      stopAtHead: false,
      hopAllow: INSTAGRAM_HOP_HOSTS,
      maxHops: 3,
    });
  } catch (e) {
    ctx.log('instagram.embed_fetch_failed', { error: errorCode(e) });
  }

  let partial: PreviewFields | null = null; // 임베드가 이미지 없이 작성자·캡션만 준 경우
  if (embed) {
    const landing = classifyInstagramUrl(embed.finalUrl);
    if (landing === 'profile') return gone();
    if (isOk(embed.status) && landing !== 'login') {
      const raw = parseInstagramEmbedRaw(embed.text);
      if (raw.broken) return gone();
      const fields = embedFields(raw, storeCaption);
      if (fields && raw.imageCandidates.length > 0) {
        // 캡션이 없을 때만 공유 텍스트 힌트가 합성 제목('@user • Instagram') 보다 낫다
        const title = raw.caption ? fields.title : (ctx.hintTitle ?? fields.title);
        return ready({ ...fields, title, canonicalUrl }, 'embed');
      }
      partial = fields;
      ctx.log('instagram.embed_no_image', { status: embed.status, truncated: embed.truncated === true });
    } else {
      ctx.log('instagram.embed_rejected', { status: embed.status, landing });
    }
  }

  // 2) 게시물 페이지 og 폴백 — og:image + twitter:title 만 있다(캡션 없음)
  const page = await fetchPage(ctx, { url: canonicalUrl, hopAllow: INSTAGRAM_HOP_HOSTS, maxHops: 3 });
  if (page.done) {
    if (page.outcome.kind === 'unsupported') return page.outcome; // 404/410
    // 임베드도 네트워크 오류였다면 일시 장애 — 재시도(failed) 가 폰 보조보다 맞다
    if (!embed && page.outcome.kind === 'failed') return page.outcome;
  } else {
    const landing = classifyInstagramUrl(page.page.res.finalUrl);
    if (landing === 'profile') return gone();
    if (landing !== 'login') {
      const pf = parseInstagramPage(page.page.res.text, page.page.res.finalUrl);
      if (pf && pf.imageCandidates.length > 0) {
        return ready(
          normalizeFields({
            title: partial?.title ?? ctx.hintTitle ?? pf.title,
            description: partial?.description ?? null,
            author: pf.author ?? partial?.author ?? null, // 페이지 쪽이 '이름 (@user)' 로 더 풍부하다
            siteName: 'Instagram',
            canonicalUrl,
            imageCandidates: pf.imageCandidates,
          }),
          'og',
        );
      }
    }
  }

  // 3) 폰(주거용 IP) 이 같은 임베드 URL 을 같은 파서로
  return needsClient(
    'instagram:embed_empty',
    embedUrl,
    'fetch',
    'instagram_embed',
    partial ? { ...partial, canonicalUrl } : emptyFields({ siteName: 'Instagram', canonicalUrl }),
  );
}

export const instagramAdapter: SiteAdapter = {
  id: 'instagram',
  serverFetch: true,
  imageHosts: INSTAGRAM_IMAGE_HOSTS,
  match: (u) => extractInstagramShortcode(u) !== null,
  canonicalize(u: URL): CanonicalResult {
    const code = extractInstagramShortcode(u);
    return code ? { fetchUrl: instagramEmbedUrl(code), canonicalUrl: instagramPostUrl(code) } : canonicalize(u);
  },
  run: runInstagram,
  /** 폰이 제출한 HTML — 임베드면 임베드 규칙, 게시물 페이지면 og 폴백 규칙. 깨진 글은 null. */
  parseSubmitted(html: string, finalUrl: string): PreviewFields | null {
    const raw = parseInstagramEmbedRaw(html);
    if (raw.broken) return null;
    return embedFields(raw, instagramStoreCaption()) ?? parseInstagramPage(html, finalUrl);
  },
};

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const THREADS_HOSTS: HostPattern[] = ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'];
const THREADS_HOP_HOSTS: HostPattern[] = ['*.threads.com', '*.threads.net'];
const THREADS_TITLE_SUFFIX_RE = /\s+on Threads\s*$/i;

export interface ThreadsPostRef {
  /** '@' 없는 핸들. /t/<code> 단축 폼은 '' */
  handle: string;
  code: string;
}

/** /@handle/post/<code> · /t/<code>. 프로필(/@handle) 은 null(generic). */
export function parseThreadsPostUrl(u: URL): ThreadsPostRef | null {
  if (!matchesHost(u.hostname, THREADS_HOSTS)) return null;
  const segs = pathSegments(u);
  if (segs.length >= 3 && segs[0].startsWith('@') && segs[1] === 'post' && SHORTCODE_RE.test(segs[2])) {
    return { handle: segs[0].slice(1), code: segs[2] };
  }
  if (segs.length >= 2 && segs[0] === 't' && SHORTCODE_RE.test(segs[1])) return { handle: '', code: segs[1] };
  return null;
}

export const threadsPostUrl = (r: ThreadsPostRef): string =>
  r.handle ? `https://www.threads.com/@${r.handle}/post/${r.code}` : `https://www.threads.com/t/${r.code}`;

/**
 * generic 결과 재매핑: og:title 'Name (@handle) on Threads' → author, og:description(본문) → 제목 첫 줄 + 설명.
 * 아바타(t51.82787-19) 는 collectImageCandidates 가 이미 제외했다. 본문이 없으면(로그인 벽·셸) null.
 */
export function remapThreadsFields(f: PickedFields): PreviewFields | null {
  const text = f.raw.ogDescription ?? f.raw.twitterDescription ?? null;
  if (!text) return null;
  const author = f.raw.ogTitle
    ? normalizeText(f.raw.ogTitle.replace(THREADS_TITLE_SUFFIX_RE, ''), FIELD_LIMITS.author, { singleLine: true })
    : null;
  return normalizeFields({
    title: firstLine(text, 80),
    description: text,
    author,
    siteName: 'Threads',
    canonicalUrl: f.canonicalUrl, // og:url 은 threads.com 폼 — .net 입력도 여기서 .com 으로 모인다
    imageCandidates: f.imageCandidates,
  });
}

export const threadsAdapter: SiteAdapter = {
  id: 'threads',
  serverFetch: true,
  imageHosts: INSTAGRAM_IMAGE_HOSTS,
  match: (u) => parseThreadsPostUrl(u) !== null,
  canonicalize(u: URL): CanonicalResult {
    const r = parseThreadsPostUrl(u);
    if (!r) return canonicalize(u);
    const c = threadsPostUrl(r);
    return { fetchUrl: c, canonicalUrl: c };
  },
  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const page = await fetchPage(ctx, { hopAllow: THREADS_HOP_HOSTS });
    if (page.done) return page.outcome;
    const fields = remapThreadsFields(page.page.fields);
    if (!fields) {
      // 본문 og 가 없다 — /embed 의 TextContentContainer 는 전용 파서가 없어 폰이 게시물 페이지를 다시 읽는다
      return needsClient(
        'threads:no_og',
        ctx.canonicalUrl,
        'fetch',
        'generic',
        emptyFields({ siteName: 'Threads', canonicalUrl: ctx.canonicalUrl }),
      );
    }
    return ready({ ...fields, canonicalUrl: fields.canonicalUrl ?? ctx.canonicalUrl }, 'og');
  },
  parseSubmitted(html: string, finalUrl: string): PreviewFields | null {
    return remapThreadsFields(pickFields(parseTags(html), finalUrl));
  },
};

/** 레지스트리(T6) 용 — 'instagram(+threads)'. */
export const instagramAdapters: SiteAdapter[] = [instagramAdapter, threadsAdapter];
