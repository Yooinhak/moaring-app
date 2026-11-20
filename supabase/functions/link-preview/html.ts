// HTML 메타 파서 — DOM 없이 정규식으로 <meta>/<title>/<link>/JSON-LD 를 읽어 PreviewFields 를 만든다 (순수 모듈)
//
// 왜 DOM 파서를 안 쓰나: Edge Runtime 의 CPU 예산은 요청당 2 s. ≤1 MiB 문자열에 선형 정규식 몇 번이 한계다.
// 왜 속성 맵인가: 프로브 ~45곳은 전부 property="…" content="…" 순서였지만 표본이 작다. 순서·따옴표에 기대지 않는다.
// 왜 상태코드를 여기서 안 보나: 비 2xx 본문은 호출자(generic 어댑터) 가 아예 파싱하지 않는다 — 404 X 페이지가
// 'Post Not Found' og 를, Cloudflare 403 이 'Attention Required!' <title> 을 담고 있었다.
//
// 관측 근거 (2026-11-04): nts.go.kr 루트상대 og:image · namu.wiki 프로토콜상대 og:image(SVG) · Daum 카페 상대 og:url +
// 숫자 엔티티 설명 + http 이미지 · gov.kr <meta http-equiv=refresh> · 컬리 보일러플레이트 og:description ·
// YouTube twitter:app:url 'vnd.youtube://' · 당근 twitter:description 안의 \u0000 · excalidraw/diagrams.net SPA 셸.

import { stripTrackingParams } from './canonical.ts';
import { decodeEntities } from './entities.ts';
import { isPlaceholderImage } from './placeholders.ts';
import { FIELD_LIMITS } from './types.ts';
import type { PreviewFields } from './types.ts';

// ---------------------------------------------------------------------------
// 태그 파싱
// ---------------------------------------------------------------------------

/** 소문자 속성명 → 엔티티 디코드된 값. 값 없는 속성(예: async) 은 ''. */
export type TagAttrs = Record<string, string>;

export interface ParsedTags {
  metas: TagAttrs[];
  links: TagAttrs[];
  /** 첫 <title> 의 디코드·공백 정리된 텍스트. 없으면 null. */
  title: string | null;
  /** <script type="application/ld+json"> 들을 JSON.parse 한 결과 (파싱 실패는 건너뜀). */
  jsonLd: unknown[];
}

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const SCRIPT_STYLE_RE = /<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const JSON_LD_RE = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
const META_OPEN_RE = /<meta\b/gi;
const LINK_OPEN_RE = /<link\b/gi;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
// name  |  name=value  |  name="value"  |  name='value'
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

/** 문서당 <meta>/<link> 최대 개수 — 비정상 페이지 방어 (보통 10~50개). 아래 스캐너의 최악 비용 상한이기도 하다. */
const MAX_TAGS = 400;
/** 태그 하나의 속성 구간을 따옴표 인식으로 훑는 최대 길이. 넘으면 첫 '>' 로 자른다 — 실제 og:description 은 수 KB 를 넘지 않는다. */
const TAG_SCAN_LIMIT = 16384;

/**
 * start(태그 이름 바로 뒤) 부터 태그를 닫는 '>' 의 인덱스. 값 따옴표 안의 '>' 는 건너뛴다 — `content="홈 > 패션 > 남성"` 처럼
 * 이스케이프 안 한 값이 있어서다. 따옴표는 HTML 토크나이저처럼 '=' 뒤에서만 값을 연다 (`content=Schindler's` 의 ' 는 글자).
 * 따옴표가 안 닫히거나 TAG_SCAN_LIMIT 를 넘으면 첫 '>' 로 되돌아간다(없으면 -1) — 어떤 입력에도 선형이다.
 */
function findTagEnd(html: string, start: number): number {
  const limit = Math.min(html.length, start + TAG_SCAN_LIMIT);
  let quote = 0; // 열린 따옴표의 코드 (34 " · 39 '), 0 이면 없음
  let expectValue = false; // '=' 뒤 — 다음 따옴표가 값을 연다
  for (let i = start; i < limit; i++) {
    const c = html.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 62 /* > */) {
      return i;
    } else if (c === 61 /* = */) {
      expectValue = true;
    } else if (c === 32 || (c >= 9 && c <= 13)) {
      // '=' 와 값 사이의 공백 — expectValue 유지
    } else if (expectValue && (c === 34 || c === 39)) {
      quote = c;
      expectValue = false;
    } else {
      expectValue = false;
    }
  }
  return html.indexOf('>', start);
}

/**
 * openRe(`<meta\b` / `<link\b`) 로 시작하는 태그들의 속성 문자열을 문서 순서로 모은다 (최대 max 개).
 * 매 태그를 닫는 '>' 뒤에서 이어 가므로 따옴표 안에 든 가짜 `<meta` 는 다시 보지 않는다.
 */
function scanTags(html: string, openRe: RegExp, max: number): string[] {
  const out: string[] = [];
  openRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < max && (m = openRe.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const end = findTagEnd(html, start);
    if (end < 0) break; // 닫는 '>' 가 더 없으면 완성된 태그도 없다
    out.push(html.slice(start, end));
    openRe.lastIndex = end + 1;
  }
  return out;
}

/** 태그 안쪽 문자열을 속성 맵으로. 키는 소문자, 값은 엔티티 디코드. */
export function parseAttrs(raw: string): TagAttrs {
  const attrs: TagAttrs = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const key = m[1].toLowerCase();
    if (key === '/' || key in attrs) continue; // 닫는 슬래시·중복 속성(첫 값 우선)
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

/**
 * <meta>/<link>/<title>/JSON-LD 를 뽑는다. 주석과 <script>/<style> 내용은 먼저 지운다 —
 * SSR 번들이 문자열 안에 "<meta property=\"og:title\"…" 템플릿을 품고 있는 경우가 있어서다.
 * JSON-LD 는 지우기 전에 따로 꺼낸다.
 */
export function parseTags(html: string): ParsedTags {
  const noComments = html.replace(COMMENT_RE, '');

  const jsonLd: unknown[] = [];
  JSON_LD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JSON_LD_RE.exec(noComments)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    try {
      jsonLd.push(JSON.parse(body));
    } catch {
      // 잘린 1 MiB 캡·HTML 주석 섞인 JSON-LD 는 흔하다. 이미지 폴백일 뿐이라 조용히 건너뛴다
    }
    if (jsonLd.length >= 8) break;
  }

  const stripped = noComments.replace(SCRIPT_STYLE_RE, '');

  const metas = scanTags(stripped, META_OPEN_RE, MAX_TAGS).map(parseAttrs);
  const links = scanTags(stripped, LINK_OPEN_RE, MAX_TAGS).map(parseAttrs);

  // <title> 은 <head> 의 것만 — <body> 의 <svg><title> 을 피하기 위해 <body 이전 구간에서 먼저 찾는다
  const bodyAt = stripped.search(/<body\b/i);
  const headPart = bodyAt > 0 ? stripped.slice(0, bodyAt) : stripped;
  const t = TITLE_RE.exec(headPart) ?? (bodyAt > 0 ? TITLE_RE.exec(stripped) : null);
  const title = t ? normalizeText(decodeEntities(t[1]), FIELD_LIMITS.title, { singleLine: true }) : null;

  return { metas, links, title, jsonLd };
}

function metaKey(attrs: TagAttrs): string | null {
  const k = attrs.property ?? attrs.name ?? attrs.itemprop;
  return k ? k.trim().toLowerCase() : null;
}

/** property 또는 name 이 key(대소문자 무관) 인 첫 비어있지 않은 content. */
export function getMeta(tags: ParsedTags, key: string): string | null {
  const want = key.toLowerCase();
  for (const m of tags.metas) {
    if (metaKey(m) !== want) continue;
    const content = (m.content ?? '').trim();
    if (content) return content;
  }
  return null;
}

/** key 에 해당하는 모든 content (문서 순서, 빈 값 제외). og:image 가 여러 개인 페이지용. */
export function getMetaAll(tags: ParsedTags, key: string): string[] {
  const want = key.toLowerCase();
  const out: string[] = [];
  for (const m of tags.metas) {
    if (metaKey(m) !== want) continue;
    const content = (m.content ?? '').trim();
    if (content) out.push(content);
  }
  return out;
}

/** rel 토큰에 rel 이 포함된 첫 <link> 의 href. 'apple-touch-icon' 은 'apple-touch-icon-precomposed' 도 잡는다. */
export function getLink(tags: ParsedTags, rel: string): string | null {
  const want = rel.toLowerCase();
  for (const l of tags.links) {
    const tokens = (l.rel ?? '').toLowerCase().split(/\s+/);
    if (!tokens.some((tok) => tok === want || tok.startsWith(want + '-'))) continue;
    const href = (l.href ?? '').trim();
    if (href) return href;
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL 해석
// ---------------------------------------------------------------------------

const MAX_URL_LENGTH = 2048;

/**
 * 메타 값 → 절대 http(s) URL. 루트상대(/images/…)·프로토콜상대(//i.namu.wiki/…)·경로상대(img/a.png) 를 base 로 푼다.
 * http(s) 외 스킴(vnd.youtube:// javascript: data:) 과 2 KB 초과는 null. 값은 이미 엔티티 디코드된 것으로 본다
 * (parseAttrs 가 했다) — 여기서 또 디코드하면 '&amp;lt;' 가 '<' 가 된다.
 */
export function resolveUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  const v = stripControlChars(value).trim();
  if (!v || v.length > MAX_URL_LENGTH) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** 호스트가 같은 사이트인지 — 'www.' 'm.' 접두만 무시 (blog.naver.com ↔ m.blog.naver.com). */
export function sameSite(hostA: string, hostB: string): boolean {
  const norm = (h: string) => h.toLowerCase().replace(/^(?:www|m)\./, '');
  return norm(hostA) === norm(hostB);
}

// ---------------------------------------------------------------------------
// 필드 선택
// ---------------------------------------------------------------------------

/** pickFields 가 본 원재료. 어댑터 보정(X 의 twitter:card 분기, 브런치 og:article:author 등) 과 유용성 판정에 쓴다. */
export interface PickedRaw {
  ogTitle: string | null;
  twitterTitle: string | null;
  htmlTitle: string | null;
  ogDescription: string | null;
  twitterDescription: string | null;
  metaDescription: string | null;
  ogSiteName: string | null;
  ogType: string | null;
  twitterCard: string | null;
  ogUrl: string | null;
  canonicalLink: string | null;
  metaAuthor: string | null;
  articleAuthor: string | null;
  ogArticleAuthor: string | null;
  /** og:* 또는 twitter:* 메타가 하나라도 있었나 (SPA 셸 판정). */
  hasOgOrTwitter: boolean;
}

export interface PickedFields extends PreviewFields {
  raw: PickedRaw;
}

/** 사이트 공통 보일러플레이트 설명. 어댑터가 자기 사이트 것을 더할 수 있게 export. */
export const BOILERPLATE_DESCRIPTION_PATTERNS: RegExp[] = [
  // YouTube 로케일별 기본 설명 (watch 페이지 og 폴백 때만 등장). 설명 없는 영상의 og:description 은 요청 IP 로케일의
  // 사이트 소개문이다. 2026-11-04 프로브(shorts J-mrNqVPEWM)에서 본 한국어·영어 변형 + 예전 문구 버전을 함께 둔다.
  /^YouTube에서 마음에 드는 동영상과 음악을 감상하고/,
  /^Enjoy the videos and music (?:that )?you love/i,
  /^Share your videos with friends, family, and the world/i,
  /^좋아하는 동영상과 음악을 감상하고, 직접 만든 콘텐츠를 업로드/,
  /^친구, 가족, 전 세계 사람들과 동영상을 공유/,
  /^YouTube で(?:お気に入りの)?動画や音楽を楽しみ/,
];

/**
 * 설명이 사이트 전역 문구인지 — 명시 패턴만 본다. "og:type=website 이고 og:description == meta description" 식 추론은
 * 쓰지 않는다: 대부분의 템플릿·SEO 헬퍼가 두 태그에 같은 문장을 넣고 website 를 기본 타입으로 두므로(Stack Overflow·MDN·
 * Next.js 블로그) 진짜 요약까지 지워 버렸다. 컬리처럼 전 페이지 공통 문구가 있는 사이트는 어댑터가 자기 패턴으로 거른다.
 */
export function isBoilerplateDescription(description: string | null | undefined): boolean {
  if (!description) return false;
  return BOILERPLATE_DESCRIPTION_PATTERNS.some((re) => re.test(description));
}

function looksLikeUrl(s: string): boolean {
  return /^(?:https?:)?\/\//i.test(s.trim());
}

function pickAuthor(...cands: Array<string | null>): string | null {
  for (const c of cands) {
    if (!c) continue;
    const v = c.trim();
    if (!v || looksLikeUrl(v)) continue; // article:author 는 보통 프로필 URL
    return v;
  }
  return null;
}

function collectJsonLdImages(node: unknown, out: string[], depth: number): void {
  if (depth > 4 || out.length >= 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdImages(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const key of ['image', 'thumbnailUrl', 'thumbnail', 'contentUrl']) {
    const v = obj[key];
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') out.push(item);
        else if (item && typeof item === 'object') {
          const url = (item as Record<string, unknown>).url ?? (item as Record<string, unknown>).contentUrl;
          if (typeof url === 'string') out.push(url);
        }
      }
    } else if (v && typeof v === 'object') {
      const url = (v as Record<string, unknown>).url ?? (v as Record<string, unknown>).contentUrl;
      if (typeof url === 'string') out.push(url);
    }
  }
  const graph = obj['@graph'];
  if (Array.isArray(graph)) collectJsonLdImages(graph, out, depth + 1);
  const main = obj.mainEntity ?? obj.mainEntityOfPage;
  if (main && typeof main === 'object') collectJsonLdImages(main, out, depth + 1);
}

/**
 * 이미지 후보 (우선순위 순, 중복·플레이스홀더·비 http(s) 제외, 최대 6개):
 * og:image:secure_url → og:image → og:image:url → twitter:image → twitter:image:src → link[rel=image_src] → JSON-LD → apple-touch-icon
 * http:// 도 후보로 둔다 — 서버가 받아 https Storage 로 복사하므로 (Daum cfile, kakao staticmap).
 */
export function collectImageCandidates(tags: ParsedTags, finalUrl: string): string[] {
  const rawCands: string[] = [
    ...getMetaAll(tags, 'og:image:secure_url'),
    ...getMetaAll(tags, 'og:image'),
    ...getMetaAll(tags, 'og:image:url'),
    ...getMetaAll(tags, 'twitter:image'),
    ...getMetaAll(tags, 'twitter:image:src'),
  ];
  const imageSrc = getLink(tags, 'image_src');
  if (imageSrc) rawCands.push(imageSrc);
  const ld: string[] = [];
  collectJsonLdImages(tags.jsonLd, ld, 0);
  rawCands.push(...ld);
  const touchIcon = getLink(tags, 'apple-touch-icon');
  if (touchIcon) rawCands.push(touchIcon);

  const out: string[] = [];
  for (const c of rawCands) {
    const resolved = resolveUrl(c, finalUrl);
    if (!resolved || isPlaceholderImage(resolved) || out.includes(resolved)) continue;
    out.push(resolved);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * og:url / link[rel=canonical] 에서 저장할 canonical 을 고른다.
 * 같은 그룹의 canonical 일치 행을 "복사" 하므로 오판은 다른 글의 미리보기를 붙이는 사고가 된다 → 보수적으로:
 * 다른 사이트(Notion 의 og:url=https://app.notion.com)·루트만 가리키는 값(홈페이지 전역 og:url) 은 버린다.
 */
export function pickCanonicalUrl(cands: Array<string | null>, finalUrl: string): string | null {
  let fin: URL;
  try {
    fin = new URL(finalUrl);
  } catch {
    return null;
  }
  for (const c of cands) {
    const resolved = resolveUrl(c, finalUrl);
    if (!resolved) continue;
    const u = new URL(resolved);
    if (!sameSite(u.hostname, fin.hostname)) continue;
    if (u.pathname === '/' && fin.pathname !== '/') continue;
    return stripTrackingParams(u).href;
  }
  return null;
}

/**
 * 우선순위 (설계 §6 generic):
 *   title: og:title → twitter:title → <title>
 *   description: og:description → twitter:description → meta[name=description] (YouTube 로케일 문구 등 보일러플레이트 패턴이면 null)
 *   author: meta[name=author] → og:article:author → article:author (URL 이면 제외)
 *   siteName: og:site_name · canonicalUrl: og:url → link[rel=canonical] (같은 사이트일 때만)
 * 결과는 NFC·제어문자 제거·길이 캡까지 끝난 상태다.
 */
export function pickFields(tags: ParsedTags, finalUrl: string): PickedFields {
  const raw: PickedRaw = {
    ogTitle: getMeta(tags, 'og:title'),
    twitterTitle: getMeta(tags, 'twitter:title'),
    htmlTitle: tags.title,
    ogDescription: getMeta(tags, 'og:description'),
    twitterDescription: getMeta(tags, 'twitter:description'),
    metaDescription: getMeta(tags, 'description'),
    ogSiteName: getMeta(tags, 'og:site_name'),
    ogType: getMeta(tags, 'og:type'),
    twitterCard: getMeta(tags, 'twitter:card'),
    ogUrl: getMeta(tags, 'og:url'),
    canonicalLink: getLink(tags, 'canonical'),
    metaAuthor: getMeta(tags, 'author'),
    articleAuthor: getMeta(tags, 'article:author'),
    ogArticleAuthor: getMeta(tags, 'og:article:author'),
    hasOgOrTwitter: tags.metas.some((m) => {
      const k = metaKey(m);
      return k !== null && (k.startsWith('og:') || k.startsWith('twitter:'));
    }),
  };

  const title = raw.ogTitle ?? raw.twitterTitle ?? raw.htmlTitle;
  let description: string | null = raw.ogDescription ?? raw.twitterDescription ?? raw.metaDescription;
  if (isBoilerplateDescription(description)) description = null;

  const fields = normalizeFields({
    title,
    description,
    author: pickAuthor(raw.metaAuthor, raw.ogArticleAuthor, raw.articleAuthor),
    siteName: raw.ogSiteName,
    canonicalUrl: pickCanonicalUrl([raw.ogUrl, raw.canonicalLink], finalUrl),
    imageCandidates: collectImageCandidates(tags, finalUrl),
  });
  return { ...fields, raw };
}

// ---------------------------------------------------------------------------
// 판정 헬퍼
// ---------------------------------------------------------------------------

/** 비교용 접기: 공백 정리 + 소문자 + NFC. */
function fold(s: string): string {
  return (normalizeText(s, 2000, { singleLine: true }) ?? '').toLowerCase();
}

/**
 * 쓸 만한 메타인가. 제목이 없거나, 제목이 사이트 이름·호스트명과 같으면(instagram.com 루트 'Instagram', 홈페이지) 아니다.
 * og:site_name/og:type 만 있는 페이지(excalidraw 류 셸) 도 아니다.
 */
export function isUsefulMeta(fields: PickedFields, hostname: string): boolean {
  const title = fields.raw.ogTitle ?? fields.raw.twitterTitle ?? fields.raw.htmlTitle;
  if (!title) return false;
  const t = fold(title);
  if (!t) return false;
  if (fields.raw.ogSiteName && t === fold(fields.raw.ogSiteName)) return false;
  const host = hostname.toLowerCase();
  if (t === host || t === host.replace(/^(?:www|m)\./, '')) return false;
  return true;
}

const BODY_NOISE_RE = /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** 태그·스크립트·스타일을 뺀 가시 텍스트 길이. SPA 셸 판정용 (diagrams.net 385자, TodoMVC 71자). */
export function visibleTextLength(html: string): number {
  const text = decodeEntities(
    html
      .replace(COMMENT_RE, '')
      .replace(BODY_NOISE_RE, '')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ');
  return text.trim().length;
}

const EMPTY_ROOT_RE = /<div\b[^>]*\bid\s*=\s*["']?(?:root|app|__next|__nuxt|___gatsby|main)["']?[^>]*>\s*<\/div>/i;

/**
 * JS 없이는 내용이 없는 셸인가: og/twitter 제목 0 + 가시 텍스트 <300자 + (noscript | 빈 #root/#app | 1 KB 미만 본문).
 * 이런 페이지는 폰 WebView 가 아니면 못 읽으므로 needs_client('needs:webview') 로 보낸다.
 */
export function looksLikeSpaShell(html: string, fields: PickedFields): boolean {
  if (fields.raw.ogTitle || fields.raw.twitterTitle) return false;
  if (visibleTextLength(html) >= 300) return false;
  const hasNoscript = /<noscript[\s>]/i.test(html);
  const hasEmptyRoot = EMPTY_ROOT_RE.test(html);
  const tiny = html.trim().length < 1024;
  return hasNoscript || hasEmptyRoot || tiny;
}

export type BlockSignature = 'blocked:cloudflare' | 'blocked:akamai' | 'waf_stub';

/**
 * 봇 차단 응답 시그니처. 본문을 저장하면 안 되는 응답을 코드로 바꿔 needs_client 사유로 남긴다.
 *   cloudflare: 403/429/503 + server:cloudflare, cf-mitigated:challenge, 'Attention Required!', 'Just a moment...' (Medium·gmarket·auction·StackOverflow)
 *   akamai:     server:AkamaiGHost 또는 <TITLE>Access Denied</TITLE> + edgesuite (쿠팡 www/m)
 *   waf_stub:   TikTok 'slardar_us_waf' 스텁·x-tt-system-error 헤더, LinkedIn 999
 * 평범한 403(ppomppu ISayPPOM2, IMDb) 은 null — 호출자가 상태코드만으로 처리한다.
 */
export function detectBlockPage(status: number, headers: Record<string, string>, html: string): BlockSignature | null {
  const server = (headers['server'] ?? '').toLowerCase();
  const head = html.slice(0, 65536);

  if (server.startsWith('akamaighost')) return 'blocked:akamai';
  if (/<title>\s*Access Denied\s*<\/title>/i.test(head) && /edgesuite\.net/i.test(head)) return 'blocked:akamai';

  if ((headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') return 'blocked:cloudflare';
  if (server === 'cloudflare' && (status === 403 || status === 429 || status === 503)) return 'blocked:cloudflare';
  if (/<title>\s*Attention Required!\s*\|\s*Cloudflare\s*<\/title>/i.test(head)) return 'blocked:cloudflare';
  if (
    /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(head) &&
    /cloudflare|cf[-_]chl|challenge-platform/i.test(head)
  ) {
    return 'blocked:cloudflare';
  }

  if (status === 999) return 'waf_stub';
  if (headers['x-tt-system-error'] !== undefined) return 'waf_stub';
  if (html.length < 8192 && /slardar_us_waf/i.test(html)) return 'waf_stub';

  return null;
}

// ---------------------------------------------------------------------------
// 텍스트 정규화
// ---------------------------------------------------------------------------

// C0(탭·개행 제외)·DEL·C1·BOM·비문자. 당근 twitter:description 에 \u0000 이 실제로 있었다 — PG text 는 NUL 을 거부한다.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f﻿￾￿]/g;

export function stripControlChars(s: string): string {
  return s.replace(CONTROL_RE, '');
}

export interface NormalizeOptions {
  /** true 면 개행도 공백으로 접는다 (제목·작성자·사이트명). 기본 false — 설명은 단락 구분을 한 줄바꿈으로 남긴다. */
  singleLine?: boolean;
}

/**
 * 제어문자 제거 → NFC → 공백 정리 → trim → 코드포인트 기준 maxLen 캡(초과 시 … 로 끝) → 비면 null.
 * PG 의 char_length 는 코드포인트 수라 Array.from 으로 센다 (이모지 서로게이트 쌍을 반으로 자르지 않기 위함).
 */
export function normalizeText(
  value: string | null | undefined,
  maxLen: number,
  opts: NormalizeOptions = {},
): string | null {
  if (value === null || value === undefined) return null;
  let s = stripControlChars(String(value)).normalize('NFC');
  if (opts.singleLine) {
    s = s.replace(/\s+/g, ' ').trim();
  } else {
    s = s
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t  - 　]+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n');
  }
  if (!s) return null;
  const cps = Array.from(s);
  if (cps.length > maxLen) {
    s =
      cps
        .slice(0, Math.max(0, maxLen - 1))
        .join('')
        .trimEnd() + '…';
  }
  return s || null;
}

/** 모든 텍스트 필드를 DB CHECK 길이에 맞춘다. imageCandidates 는 그대로. */
export function normalizeFields(fields: PreviewFields): PreviewFields {
  return {
    title: normalizeText(fields.title, FIELD_LIMITS.title, { singleLine: true }),
    description: normalizeText(fields.description, FIELD_LIMITS.description),
    author: normalizeText(fields.author, FIELD_LIMITS.author, { singleLine: true }),
    siteName: normalizeText(fields.siteName, FIELD_LIMITS.siteName, { singleLine: true }),
    canonicalUrl: fields.canonicalUrl,
    imageCandidates: fields.imageCandidates,
  };
}

/** 캡션 첫 비어있지 않은 줄 (인스타·스레드·틱톡 제목용). maxLen 초과면 … 로 끝. */
export function firstLine(text: string | null | undefined, maxLen = 80): string | null {
  const normalized = normalizeText(text, 4000);
  if (!normalized) return null;
  const line = normalized.split('\n')[0];
  return normalizeText(line, maxLen, { singleLine: true });
}

/**
 * 태그 제거 (X oEmbed 의 <p>, 인스타 Caption 등 작은 조각용). <br>·블록 닫힘은 줄바꿈으로, 스크립트/스타일은 통째로 제거,
 * 마지막에 엔티티 디코드. 공백 정리는 하지 않는다 — normalizeText/firstLine 에 넘길 것.
 */
export function stripTags(html: string): string {
  const s = html
    .replace(COMMENT_RE, '')
    .replace(SCRIPT_STYLE_RE, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

/** 직접 이미지·PDF 링크의 제목: 마지막 경로 조각을 디코드 (쿼리 제외). 경로가 없으면 호스트명. */
export function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter((s) => s.length > 0);
    const last = segs.length ? segs[segs.length - 1] : '';
    if (!last) return u.hostname || null;
    try {
      return normalizeText(decodeURIComponent(last), FIELD_LIMITS.title, { singleLine: true });
    } catch {
      return normalizeText(last, FIELD_LIMITS.title, { singleLine: true });
    }
  } catch {
    return null;
  }
}

/**
 * <meta http-equiv="refresh" content="0;URL=/portal/main"> 의 대상 (gov.kr 이 실제 사례). 속성 순서·따옴표·공백 무관.
 * 대상이 없거나(단순 새로고침) http(s) 로 풀리지 않으면 null. 호출자는 og:title 이 없을 때 1회만 따라가고 홉으로 센다.
 */
export function findMetaRefresh(html: string, baseUrl: string): string | null {
  const noComments = html.slice(0, 262144).replace(COMMENT_RE, '');
  for (const rawTag of scanTags(noComments, META_OPEN_RE, MAX_TAGS)) {
    const attrs = parseAttrs(rawTag);
    if ((attrs['http-equiv'] ?? '').trim().toLowerCase() !== 'refresh') continue;
    const content = attrs.content ?? '';
    const target = /^\s*\d*\s*[;,]\s*(?:url\s*=\s*)?['"]?\s*([^'"\s>]+)/i.exec(content);
    if (!target) continue;
    return resolveUrl(target[1], baseUrl);
  }
  return null;
}
