import type { DeviceHints } from './preview/types';

/**
 * 기기(폰) 측 링크 메타데이터 파서.
 *
 * 역할이 둘이다.
 * 1. SaveLinkSheet 가 저장 전에 제목을 미리 보여주는 용도(parseMetadata). 공유 시트는 저장 직후 280 ms 뒤
 *    Activity 를 닫으므로 시간 예산이 짧다(기본 4 s). 실패해도 도메인만 보여주면 되니 예외는 전부 null 로 삼킨다.
 * 2. 서버(Edge Function link-preview)가 데이터센터 IP 로 차단당한 글을 폰의 주거용 IP 로 1회 보조하는 용도
 *    (parseOnDevice → toDeviceHints → mode 'assist'). 인스타그램이 핵심이다 — 임베드 페이지는 서버에서 막혀도
 *    폰에서는 열리는 경우가 많고, 캡션·썸네일을 키 없이 얻을 수 있는 유일한 경로가 그 임베드다.
 *
 * 하지 않는 것:
 * - 제3자 메타 API 호출: 무료 티어가 IP 당 5회/일이라 사실상 죽었다(429 관측).
 * - User-Agent 스푸핑: 브라우저 UA 를 흉내 내면 WAF 가 더 엄격해지고 약관상으로도 문제다. 런타임 기본 UA 그대로,
 *   헤더는 Accept 하나만 보낸다.
 * - EUC-KR 디코딩: Hermes 에는 레거시 TextDecoder 가 없고, 네이티브 계층이 본문을 어떤 인코딩으로 문자열화하는지도
 *   플랫폼마다 달라 깨진 글자를 저장할 위험이 있다. 레거시 라벨이 보이면 텍스트 필드는 null 로 두고
 *   ASCII 인 이미지·canonical 만 돌려준다(서버가 euc-kr 로 다시 읽는다).
 *
 * 메타 우선순위는 서버의 generic 파서(supabase/functions/link-preview)와 같다. 여기 결과는 힌트일 뿐이며
 * 서버가 길이·스킴·이미지 재다운로드(매직바이트)로 다시 검증한 뒤 저장한다.
 */

export interface Metadata {
  title: string | null;
  description: string | null;
  image: string | null;
  /** 채널명·@계정·기자명 — 설명이 없을 때 부제로 쓴다 */
  author: string | null;
}

export interface ParseOptions {
  /** 연결 + 본문 수신 전체 예산. 기본 4 s — 공유 시트가 닫히기 전에 끝나야 한다 */
  timeoutMs?: number;
  /** 호출자(화면 언마운트 등)가 중단시킬 때 */
  signal?: AbortSignal;
}

export interface DeviceParseResult {
  /** 응답이 2xx 가 아니었다 — 폰에서도 막힌 것이므로 서버는 더 재시도하지 않고 종결한다 */
  blocked?: boolean;
  http_status?: number;
  /**
   * 파서 자체의 시간 예산(timeoutMs)이 먼저 끊어 빈 결과가 됐다. 호출자의 signal 로 끊긴 경우엔 붙지 않는다(호출자가 이미 안다).
   * "폰에서도 못 얻었다" 가 아니라 "시간이 모자랐다" 이므로, 보조(assist) 호출자는 이 결과를 빈 결과로 제출해
   * 서버가 종결하게 두는 대신 다음 기회에 다시 시도하도록 구분할 수 있다. DeviceHints 로는 보내지 않는다.
   */
  timedOut?: boolean;
  title: string | null;
  description: string | null;
  image_url: string | null;
  author: string | null;
  canonical_url: string | null;
  /** 인스타 임베드 원문(≤256 K 문자). 서버의 instagram_embed 파서가 폰이 받은 그대로 다시 읽는다 */
  html?: string;
}

const DEFAULT_TIMEOUT_MS = 4000;
/**
 * 본문 상한. RN fetch 는 스트리밍이 안 돼 네이티브 계층이 본문을 통째로 받아 두는 것까지는 막을 수 없다 —
 * 이 캡이 아끼는 것은 그 뒤의 JS 문자열화(res.text())와 정규식 스캔이다. 그래서 두 겹으로 본다:
 * content-length 헤더가 있으면 text() 전에 끊고(1차), 헤더가 없으면(Android OkHttp 는 gzip 을 풀면서 헤더를 뗀다)
 * 문자열화 뒤 길이로 한 번 더 끊는다(2차).
 */
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;
/** 정규식을 돌릴 최대 길이. YouTube 처럼 <head> 가 777 KB 인 경우도 있어 1 MiB 까지 본다 */
const MAX_SCAN_CHARS = 1024 * 1024;
/** assist 페이로드에 실어 보낼 원문 상한 */
const MAX_HTML_RETURN_CHARS = 256 * 1024;
/** 태그 하나의 속성 문자열 상한 — 이보다 긴 <meta …> 는 깨진 마크업이고 정규식 비용만 키운다 */
const MAX_TAG_INNER_CHARS = 16 * 1024;
/** 인스타 캡션 스캔 범위 — 캡션은 길어도 수 KB (서버 sites/instagram.ts 와 같은 값) */
const MAX_CAPTION_SCAN_CHARS = 64 * 1024;
/** URL 힌트 상한 — 서버 resolveUrl 이 같은 길이에서 버리고, 힌트 2개를 합쳐도 fetch 바디 8 KB 캡을 밀어내지 않게 */
const MAX_URL_CHARS = 2048;
const ACCEPT_HTML = 'text/html,application/xhtml+xml';
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 1000;
const MAX_AUTHOR = 120;
/** 인스타 캡션 첫 줄을 제목으로 쓸 때의 길이 */
const MAX_CAPTION_TITLE = 80;

const EMPTY: DeviceParseResult = {
  title: null,
  description: null,
  image_url: null,
  author: null,
  canonical_url: null,
};

export async function parseMetadata(url: string, opts?: ParseOptions): Promise<Metadata> {
  const r = await parseOnDevice(url, opts);
  return { title: r.title, description: r.description, image: r.image_url, author: r.author };
}

/**
 * 폰에서 1회 수집. 어떤 경우에도 reject 하지 않는다 — 네트워크·파싱 예외는 빈 결과로 삼킨다.
 * 호스트별 분기: YouTube 는 oEmbed(1.4 MB 페이지 대신 900 B JSON), 인스타는 /embed/captioned/, TikTok 영상·단축 링크는 SSR JSON,
 * 서버·폰 모두 의미 없는 호스트(쿠팡 Akamai 403, Medium Cloudflare 챌린지, Notion 전역 og, 네이버 지도·카페 SPA)는
 * 즉시 빈 결과, 나머지는 generic og 파서.
 */
export async function parseOnDevice(url: string, opts: ParseOptions = {}): Promise<DeviceParseResult> {
  try {
    const target = new URL(url.trim());
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return { ...EMPTY };
    const host = target.hostname.toLowerCase();

    if (isSkippedHost(host)) return { ...EMPTY };

    if (isYouTubeHost(host)) {
      const id = extractYouTubeId(target);
      if (id) return await parseYouTube(id, opts);
    }

    if (isInstagramHost(host)) {
      const code = extractInstagramCode(target);
      if (code) return await parseInstagram(code, opts);
    }

    // 영상·단축 링크만 SSR 파서. 프로필·/photo/·newsroom 등 나머지 경로는 og 가 있으니 generic (서버 sites/tiktok.ts 와 같은 분기)
    if (isTikTokHost(host) && isTikTokVideoUrl(target)) return await parseTikTok(target, opts);

    return await parseGeneric(target, opts);
  } catch {
    return { ...EMPTY };
  }
}

/** assist 요청 바디용. html 은 DeviceHints 가 아니라 별도 필드로 실린다. timedOut 은 폰 안에서만 쓰는 신호라 싣지 않는다 */
export function toDeviceHints(r: DeviceParseResult): DeviceHints {
  const hints: DeviceHints = {
    title: r.title,
    description: r.description,
    image_url: capUrl(r.image_url),
    author: r.author,
    canonical_url: capUrl(r.canonical_url),
  };
  if (r.blocked) hints.blocked = true;
  if (r.http_status !== undefined) hints.http_status = r.http_status;
  return hints;
}

// ---------------------------------------------------------------------------
// 호스트 판별
// ---------------------------------------------------------------------------

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * 폰이 받아도 쓸 게 없는 호스트. 쿠팡(Akamai 403, IP 무관)·Medium(Cloudflare JS 챌린지)·Notion(제목이 HTML 에 없음)·
 * 네이버 지도/플레이스(SPA 셸 + 429)·네이버 카페(글 단위 og 없음). 서버가 슬러그·브랜드 카드로 처리한다.
 */
function isSkippedHost(host: string): boolean {
  return (
    hostIs(host, 'coupang.com') ||
    hostIs(host, 'medium.com') ||
    hostIs(host, 'notion.site') ||
    host === 'map.naver.com' ||
    host.endsWith('.place.naver.com') ||
    host === 'cafe.naver.com' ||
    host === 'm.cafe.naver.com'
  );
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

function isYouTubeHost(host: string): boolean {
  return YOUTUBE_HOSTS.has(host);
}

function isInstagramHost(host: string): boolean {
  return hostIs(host, 'instagram.com') || hostIs(host, 'instagr.am');
}

/** www·m·vm·vt 전부 — 단축 링크는 fetch 가 리다이렉트를 따라가므로 같은 경로로 처리한다 */
function isTikTokHost(host: string): boolean {
  return hostIs(host, 'tiktok.com');
}

/** /@user/video/<id>·/video/<id>, vm./vt. 단축 호스트, /t/<code> — 서버 extractTikTokVideo·tiktokNeedsResolve 와 같은 기준 */
function isTikTokVideoUrl(u: URL): boolean {
  if (/^v[mt]\.tiktok\.com$/i.test(u.hostname)) return true;
  return /\/video\/\d+(?:[/?#]|$)/.test(u.pathname) || /^\/t\/[^/]+/.test(u.pathname);
}

// ---------------------------------------------------------------------------
// YouTube — oEmbed
// ---------------------------------------------------------------------------

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * 11자 영상 id. youtu.be 는 첫 경로, 그 외는 v 쿼리(리다이렉트 후엔 si= 가 v= 앞에 오므로 정규식이 아니라 쿼리 파싱)
 * → /shorts|live|embed|v|e/<id>. 채널·재생목록은 null → generic.
 */
function extractYouTubeId(u: URL): string | null {
  if (u.hostname === 'youtu.be') {
    const seg = u.pathname.split('/')[1] ?? '';
    return YOUTUBE_ID_RE.test(seg) ? seg : null;
  }
  const v = u.searchParams.get('v');
  if (v && YOUTUBE_ID_RE.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|live|embed|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/**
 * oEmbed 에는 원본 URL 이 아니라 watch?v=<id> 를 넘긴다 — /embed/·/v/ 폼은 404 다.
 * 썸네일은 oEmbed 의 480px 대신 i.ytimg.com hqdefault(모든 영상에 존재, 서명 없음).
 */
async function parseYouTube(id: string, opts: ParseOptions): Promise<DeviceParseResult> {
  const canonical = `https://www.youtube.com/watch?v=${id}`;
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`;
  return withBudget(opts, async (signal) => {
    const res = await fetch(oembed, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return { ...EMPTY, canonical_url: canonical, blocked: true, http_status: res.status };
    if (exceedsContentLength(res)) return { ...EMPTY, canonical_url: canonical };
    const raw = await res.text();
    if (raw.length > MAX_CONTENT_LENGTH) return { ...EMPTY, canonical_url: canonical };
    const json = JSON.parse(raw) as { title?: unknown; author_name?: unknown };
    return {
      title: cleanText(json.title, MAX_TITLE),
      description: null,
      image_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      author: cleanText(json.author_name, MAX_AUTHOR),
      canonical_url: canonical,
    };
  });
}

// ---------------------------------------------------------------------------
// Instagram — /p/<code>/embed/captioned/
// ---------------------------------------------------------------------------

/** /reels/audio/<id>/ 처럼 미디어 세그먼트 뒤에 오지만 shortcode 가 아닌 예약어 — 서버 sites/instagram.ts 와 같은 목록 */
const INSTAGRAM_RESERVED_CODES = new Set(['audio', 'embed', 'explore', 'videos']);

/** /p|reel|reels|tv/<code>, og:url 형태인 /<username>/reel/<code>/ 도 허용. 예약어는 generic 으로 떨어진다 */
function extractInstagramCode(u: URL): string | null {
  const m = u.pathname.match(/^\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/);
  if (!m || INSTAGRAM_RESERVED_CODES.has(m[1])) return null;
  return m[1];
}

/**
 * 게시물 페이지에는 og:title/og:description 이 없고 <title> 이 'Instagram' 이라 쓸 수 없다.
 * /p/<code>/embed/captioned/ 는 서버 렌더 HTML 이라 정규식으로 충분하다(reel 코드도 /p/ 경로로 열린다).
 * 삭제·비공개 글은 200 으로 EmbedBrokenMedia 를 돌려주므로 상태코드가 아니라 마크업으로 판정한다.
 * 원문을 함께 돌려준다 — 서버가 같은 마크업을 자기 규칙(srcset 640w 등)으로 다시 읽기 위해서다.
 */
async function parseInstagram(code: string, opts: ParseOptions): Promise<DeviceParseResult> {
  const canonical = `https://www.instagram.com/p/${code}/`;
  const embedUrl = `${canonical}embed/captioned/`;
  return withBudget(opts, async (signal) => {
    const res = await fetch(embedUrl, { headers: { Accept: ACCEPT_HTML }, signal });
    if (!res.ok) return { ...EMPTY, canonical_url: canonical, blocked: true, http_status: res.status };
    if (!isHtmlResponse(res) || exceedsContentLength(res)) return { ...EMPTY, canonical_url: canonical };
    const raw = await res.text();
    if (raw.length > MAX_CONTENT_LENGTH) return { ...EMPTY, canonical_url: canonical };
    const html = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
    const returned = raw.length > MAX_HTML_RETURN_CHARS ? raw.slice(0, MAX_HTML_RETURN_CHARS) : raw;
    const finalUrl = res.url || embedUrl;

    // 로그인 페이지로 튕기면 폰 IP 도 막힌 것 — 서버가 종결할 수 있게 blocked 로 표시
    if (/\/accounts\/login/i.test(finalUrl)) {
      return { ...EMPTY, canonical_url: canonical, blocked: true, http_status: res.status, html: returned };
    }

    const imgTag = html.match(/<img\b[^>]*\bclass=["'][^"']*\bEmbeddedMediaImage\b[^"']*["'][^>]*>/i)?.[0];
    const image = imgTag ? resolveHttpUrl(parseAttrs(imgTag).src, 'https://www.instagram.com/') : null;
    const username = cleanText(
      html.match(/<span\b[^>]*\bclass=["']UsernameText["'][^>]*>([^<]*)<\/span>/i)?.[1],
      MAX_AUTHOR,
    );

    if (!image || /class=["']EmbedBrokenMedia/i.test(html)) {
      return { ...EMPTY, canonical_url: canonical, html: returned };
    }

    const caption = extractInstagramCaption(html);
    const firstLine = caption?.split('\n').find((l) => l.trim().length > 0) ?? null;
    const title = firstLine
      ? truncate(firstLine.trim(), MAX_CAPTION_TITLE)
      : username
        ? `@${username} • Instagram`
        : null;

    return {
      title,
      description: caption ? truncate(caption, MAX_DESCRIPTION) : null,
      image_url: image,
      author: username,
      canonical_url: canonical,
      html: returned,
    };
  });
}

/**
 * <div class="Caption"> 에서 선두 <a class="CaptionUsername"> 를 떼고 <div class="CaptionComments"> 앞까지만.
 * 마커가 없는 마크업(댓글 비활성 등)에서는 첫 </div> 까지 — 그마저 없으면 64 KB 범위 안에서 끝낸다(서버 sites/instagram.ts 와 같은 규칙).
 * 범위를 묶지 않으면 페이지 끝까지의 <script> 내용·푸터가 캡션이 된다.
 * <br> → 줄바꿈, 해시태그 앵커 등 태그 제거, 엔티티 디코드. 인스타는 캡션 안의 '<' 를 &lt; 로 인코딩하므로
 * 태그 제거를 먼저 하고 엔티티를 풀어야 본문이 사라지지 않는다.
 */
function extractInstagramCaption(html: string): string | null {
  const open = /<div\b[^>]*\bclass=["']Caption["'][^>]*>/i.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const rest = html.slice(start, start + MAX_CAPTION_SCAN_CHARS);
  const marker = rest.search(/<div\b[^>]*\bclass=["']CaptionComments/i);
  const end = marker >= 0 ? marker : rest.search(/<\/div\s*>/i);
  let body = end >= 0 ? rest.slice(0, end) : rest;
  body = body.replace(/<a\b[^>]*\bclass=["']CaptionUsername["'][^>]*>[\s\S]*?<\/a>/i, '');
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<[^>]+>/g, '');
  body = decodeEntities(body).replace(CONTROL_CHARS_RE, '');
  const lines = body.split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').trim());
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .normalize('NFC');
  return text || null;
}

// ---------------------------------------------------------------------------
// TikTok — SSR JSON (__UNIVERSAL_DATA_FOR_REHYDRATION__)
// ---------------------------------------------------------------------------

const TIKTOK_VIDEO_PATH_RE = /^\/@([^/?#]+)\/video\/(\d+)(?:[/?#]|$)/;
const TIKTOK_SSR_RE =
  /<script\b[^>]*\bid\s*=\s*["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script\s*>/i;
/** 정상 영상 페이지는 400 KB 대, WAF 스텁은 1.5 KB 였다(서버 sites/tiktok.ts 와 같은 기준) */
const TIKTOK_WAF_MIN_CHARS = 5000;
/** 영상 페이지의 <title> — 글과 무관한 사이트 문구라 제목으로 저장하면 안 된다 */
const TIKTOK_BOILERPLATE_TITLE_RE = /^TikTok\s*[-–|]\s*Make Your Day$/i;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * 영상 페이지(~430 KB)에는 og/twitter 메타가 전무하고 <title> 은 'TikTok - Make Your Day' 다. 데이터는 SSR JSON 의
 * __DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct 에 있다 — 서버 sites/tiktok.ts 와 같은 경로를 읽는다.
 * 원문은 256 K 캡을 넘어 동봉하지 않고(JSON 이 390 KB 지점에 있다) 필드만 힌트로 보낸다. 서버는 cover URL 을
 * tiktokcdn 허용목록 + 재다운로드로 검증한 뒤에만 저장한다.
 * 200 이어도 본문이 WAF 스텁이면(크기·마커) 폰도 막힌 것 → blocked 로 서버가 종결한다.
 * SSR JSON 이 없는 정상 크기 페이지(단축 링크가 영상 아닌 곳으로 풀림, 마크업 변경)는 같은 본문을 generic 규칙으로 읽는다.
 */
async function parseTikTok(target: URL, opts: ParseOptions): Promise<DeviceParseResult> {
  return withBudget(opts, async (signal) => {
    const res = await fetch(target.href, { headers: { Accept: ACCEPT_HTML }, signal });
    if (!res.ok) return { ...EMPTY, blocked: true, http_status: res.status };
    if (!isHtmlResponse(res) || exceedsContentLength(res)) return { ...EMPTY };
    const raw = await res.text();
    if (raw.length > MAX_CONTENT_LENGTH) return { ...EMPTY };
    const finalUrl = res.url || target.href;

    let canonicalFromUrl: string | null = null;
    try {
      const m = new URL(finalUrl).pathname.match(TIKTOK_VIDEO_PATH_RE);
      if (m) canonicalFromUrl = `https://www.tiktok.com/@${m[1]}/video/${m[2]}`;
    } catch {
      // finalUrl 이 이상하면 canonical 없이 진행
    }

    const script = raw.match(TIKTOK_SSR_RE)?.[1];
    if (!script) {
      const stub = raw.length < TIKTOK_WAF_MIN_CHARS || /slardar_us_waf/i.test(raw.slice(0, 16384));
      if (stub) return { ...EMPTY, canonical_url: canonicalFromUrl, blocked: true, http_status: res.status };
      const generic = fieldsFromHtml(raw, finalUrl, res.headers.get('content-type') ?? '', target);
      return {
        ...generic,
        title: generic.title && TIKTOK_BOILERPLATE_TITLE_RE.test(generic.title) ? null : generic.title,
        canonical_url: canonicalFromUrl ?? generic.canonical_url,
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(script);
    } catch {
      return { ...EMPTY, canonical_url: canonicalFromUrl };
    }
    const detail = asRecord(asRecord(asRecord(data)?.__DEFAULT_SCOPE__)?.['webapp.video-detail']);
    // statusCode ≠ 0 은 삭제·비공개·지역 제한 — 빈 결과로 돌려 서버가 종결하게 둔다
    if (!detail || (typeof detail.statusCode === 'number' && detail.statusCode !== 0)) {
      return { ...EMPTY, canonical_url: canonicalFromUrl };
    }
    const item = asRecord(asRecord(detail.itemInfo)?.itemStruct);
    if (!item) return { ...EMPTY, canonical_url: canonicalFromUrl };

    const author = asRecord(item.author);
    const video = asRecord(item.video);
    const desc = asString(item.desc);
    const nickname = cleanText(author?.nickname, MAX_AUTHOR);
    const uniqueId = cleanText(author?.uniqueId, MAX_AUTHOR);
    const id = asString(item.id);

    // 제목은 캡션 첫 줄(≤80). 캡션이 없으면 shareMeta.title('<nickname> on TikTok') → 닉네임
    const firstLine = cleanText(
      desc?.split('\n').find((l) => l.trim().length > 0),
      MAX_CAPTION_TITLE,
    );
    const shareTitle = cleanText(asRecord(detail.shareMeta)?.title, MAX_TITLE);
    const title = firstLine ?? shareTitle ?? (nickname ? `${nickname} on TikTok` : null);

    const fullDesc = desc
      ? truncate(
          desc
            .replace(CONTROL_CHARS_RE, '')
            .replace(/[^\S\n]+/g, ' ')
            .trim()
            .normalize('NFC'),
          MAX_DESCRIPTION,
        )
      : null;
    const description = fullDesc && fullDesc !== title ? fullDesc : null;

    const image_url =
      resolveHttpUrl(asString(video?.cover), finalUrl) ?? resolveHttpUrl(asString(video?.originCover), finalUrl);
    const canonical_url = uniqueId && id ? `https://www.tiktok.com/@${uniqueId}/video/${id}` : canonicalFromUrl;

    return {
      title,
      description,
      image_url,
      author: uniqueId ? `@${uniqueId}` : nickname,
      canonical_url,
    };
  });
}

// ---------------------------------------------------------------------------
// Generic — og / twitter / <title>
// ---------------------------------------------------------------------------

async function parseGeneric(target: URL, opts: ParseOptions): Promise<DeviceParseResult> {
  return withBudget(opts, async (signal) => {
    const res = await fetch(target.href, { headers: { Accept: ACCEPT_HTML }, signal });
    // 비 2xx 본문은 절대 파싱하지 않는다 — Cloudflare 403 의 <title>'Attention Required!' 가 제목으로 저장되는 사고 방지
    if (!res.ok) return { ...EMPTY, blocked: true, http_status: res.status };
    if (!isHtmlResponse(res) || exceedsContentLength(res)) return { ...EMPTY };
    const raw = await res.text();
    if (raw.length > MAX_CONTENT_LENGTH) return { ...EMPTY };
    return fieldsFromHtml(raw, res.url || target.href, res.headers.get('content-type') ?? '', target);
  });
}

/**
 * 받은 HTML → 필드. parseGeneric 과, SSR JSON 이 없는 TikTok 페이지의 폴백이 같은 규칙을 쓴다.
 * target 은 finalUrl 을 URL 로 못 읽을 때 호스트명 폴백(generic-title 판정)으로만 쓴다.
 */
function fieldsFromHtml(raw: string, finalUrl: string, contentType: string, target: URL): DeviceParseResult {
  const tags = collectTags(raw);

  // 응답마다 판정한다 — yes24 는 메인이 ks_c_5601-1987, 상품 페이지가 UTF8 이다
  const legacy = isLegacyKoreanCharset(charsetFromContentType(contentType)) || isLegacyKoreanCharset(tags.charset);

  const image_url = pickImage(tags, finalUrl);
  const canonical_url =
    resolveHttpUrl(tags.meta.get('og:url'), finalUrl) ??
    resolveHttpUrl(tags.links.get('canonical'), finalUrl) ??
    resolveHttpUrl(finalUrl, finalUrl);

  if (legacy) return { ...EMPTY, image_url, canonical_url };

  let hostname: string;
  try {
    hostname = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    hostname = target.hostname.toLowerCase().replace(/^www\./, '');
  }
  const siteName = cleanText(tags.meta.get('og:site_name'), MAX_AUTHOR);

  let title =
    cleanText(tags.meta.get('og:title'), MAX_TITLE) ??
    cleanText(tags.meta.get('twitter:title'), MAX_TITLE) ??
    cleanText(tags.title, MAX_TITLE);
  // 'Instagram' 처럼 사이트명·호스트명과 같은 제목은 정보가 없다 → 카드는 도메인을 보여준다
  if (title && isGenericTitle(title, siteName, hostname)) title = null;

  const description =
    cleanText(tags.meta.get('og:description'), MAX_DESCRIPTION) ??
    cleanText(tags.meta.get('twitter:description'), MAX_DESCRIPTION) ??
    cleanText(tags.meta.get('description'), MAX_DESCRIPTION);

  const author = pickAuthor(tags);

  return { title, description, image_url, author, canonical_url };
}

interface PageTags {
  /** property | name | http-equiv (소문자) → 첫 번째 비어 있지 않은 content */
  meta: Map<string, string>;
  /** <link rel> 토큰(소문자) → 첫 href */
  links: Map<string, string>;
  title: string | null;
  /** <meta charset> 또는 http-equiv Content-Type 의 charset 라벨 */
  charset: string | null;
}

/**
 * 속성 순서·따옴표 유무에 의존하지 않도록 태그마다 속성을 맵으로 푼다.
 * 관측된 ~45개 페이지는 전부 property→content 순이었지만 표본이 작다.
 */
function collectTags(raw: string): PageTags {
  let html = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
  // <head> 가 끝나면 메타는 더 없다 — 1 MB 본문에 정규식을 돌리지 않기 위한 조기중단
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd > 0) html = html.slice(0, headEnd);

  const meta = new Map<string, string>();
  const links = new Map<string, string>();
  let charset: string | null = null;

  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    if (a.charset && !charset) charset = a.charset;
    const key = (a.property ?? a.name ?? a['http-equiv'])?.toLowerCase();
    if (!key || a.content === undefined) continue;
    if (key === 'content-type' && !charset) charset = charsetFromContentType(a.content);
    if (a.content.trim() && !meta.has(key)) meta.set(key, a.content);
  }

  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    if (!a.rel || !a.href) continue;
    for (const rel of a.rel.toLowerCase().split(/\s+/)) {
      if (rel && !links.has(rel)) links.set(rel, a.href);
    }
  }

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  return { meta, links, title, charset };
}

// name | name=value | name="value" | name='value' — 값 그룹이 선택이어야 '=' 없는 긴 토큰에서도 선형이다
// (필수로 두면 토큰의 모든 시작 위치에서 끝까지 먹고 되돌아가 O(n²): 깨진 <meta …> 하나로 수십 초). 서버 html.ts 와 같은 식
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

/** 태그 내부 문자열 → { 속성명(소문자): 값 }. 값 없는 속성은 '', 같은 속성이 반복되면 첫 값. 16 KB 를 넘는 부분은 보지 않는다 */
function parseAttrs(tagInner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const inner = tagInner.length > MAX_TAG_INNER_CHARS ? tagInner.slice(0, MAX_TAG_INNER_CHARS) : tagInner;
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

const IMAGE_META_KEYS = ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'];

function pickImage(tags: PageTags, base: string): string | null {
  const candidates = [...IMAGE_META_KEYS.map((k) => tags.meta.get(k)), tags.links.get('image_src')];
  for (const c of candidates) {
    const href = resolveHttpUrl(c, base);
    if (href && !isPlaceholderImage(href) && !isSvgUrl(href)) return href;
  }
  return null;
}

/** meta[name=author] → article:author (URL 이면 제외). og:site_name 은 브랜드 라벨이라 author 로 쓰지 않는다 */
function pickAuthor(tags: PageTags): string | null {
  const direct = cleanText(tags.meta.get('author'), MAX_AUTHOR);
  if (direct && !/^https?:\/\//i.test(direct)) return direct;
  const article = cleanText(tags.meta.get('article:author'), MAX_AUTHOR);
  if (article && !/^https?:\/\//i.test(article)) return article;
  return null;
}

function isGenericTitle(title: string, siteName: string | null, hostname: string): boolean {
  const t = title.toLowerCase();
  if (siteName && t === siteName.toLowerCase()) return true;
  return t === hostname || t === `www.${hostname}`;
}

/**
 * 플랫폼 기본 이미지 — 글과 무관한 로고라 썸네일로 쓰면 카드가 전부 같은 그림이 된다.
 * velog 기본, 티스토리 관리자 opengraph.png, LinkedIn 정적 에셋, Notion 기본 og.
 */
function isPlaceholderImage(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return true;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (host === 'images.velog.io' && path.endsWith('/velog.png')) return true;
  if (path.includes('tistory_admin') && path.endsWith('/opengraph.png')) return true;
  if (host === 'static.licdn.com') return true;
  if (
    (hostIs(host, 'notion.so') || hostIs(host, 'notion.com') || hostIs(host, 'notion.site')) &&
    path.endsWith('/default.png')
  ) {
    return true;
  }
  return false;
}

/** RN <Image> 는 SVG 를 그리지 못하고 서버도 SVG 를 거부한다(namu.wiki og:image 가 .svg) */
function isSvgUrl(href: string): boolean {
  try {
    return new URL(href).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 응답 헤더 게이트
// ---------------------------------------------------------------------------

/** content-length 헤더가 있고 상한을 넘으면 true — 본문을 JS 문자열로 올리기 전(res.text() 전)에 끊는 1차 방어 */
function exceedsContentLength(res: Response): boolean {
  const n = Number(res.headers.get('content-length'));
  return Number.isFinite(n) && n > MAX_CONTENT_LENGTH;
}

/** text/html · application/xhtml+xml 만 — 이미지·JSON·octet-stream 을 정규식에 넣지 않기 위해 */
function isHtmlResponse(res: Response): boolean {
  const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
}

// ---------------------------------------------------------------------------
// 문자열·URL 유틸
// ---------------------------------------------------------------------------

/**
 * 상대(/img.png)·프로토콜상대(//cdn/…)·엔티티(&amp;) 섞인 값을 최종 URL 기준 절대 http(s) URL 로. 그 외 스킴과
 * 2048 자 초과(풀어 쓴 href 기준 — 퍼센트 인코딩으로 늘어난다)는 거부
 */
function resolveHttpUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  const v = decodeEntities(value).trim();
  if (!v || v.length > MAX_URL_CHARS) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return capUrl(u.href);
  } catch {
    return null;
  }
}

/** 2048 자를 넘는 URL 은 버린다 — 서버 resolveUrl 도 같은 길이에서 버리므로 보내도 쓰이지 않는다 */
function capUrl(href: string | null): string | null {
  return href && href.length <= MAX_URL_CHARS ? href : null;
}

function charsetFromContentType(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** euc-kr · ks_c_5601-1987 · ksc5601 · ms949 · cp949 · windows-949 (WHATWG 가 전부 EUC-KR 로 묶는 라벨들) */
function isLegacyKoreanCharset(label: string | null): boolean {
  if (!label) return false;
  const l = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    l.startsWith('euckr') ||
    l.includes('ksc5601') ||
    l.includes('ms949') ||
    l.includes('cp949') ||
    l.includes('windows949') ||
    l === 'cseuckr' ||
    l === 'korean' ||
    l === 'isoir149'
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  middot: '·',
  bull: '•',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * 숫자 엔티티는 10진(&#39;, 0 패딩 &#039;)·16진(&#x27;, 인스타 twitter:title 의 &#xc96c;) 모두, 세미콜론 누락도 허용.
 * 명명 엔티티는 세미콜론이 있을 때만 — URL 쿼리의 &copy=1 같은 것을 망가뜨리지 않기 위해.
 */
const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(
    ENTITY_RE,
    (m: string, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex !== undefined || dec !== undefined) {
        const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
        if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
        return String.fromCodePoint(cp);
      }
      if (!named || !m.endsWith(';')) return m;
      const v = NAMED_ENTITIES[named.toLowerCase()];
      return v === undefined ? m : v;
    },
  );
}

// \s 로 접히지 않는 C0 제어문자(\u0000 등)와 DEL — DB 에 들어가면 Postgres text 가 거부한다
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 엔티티 디코드 → 제어문자 제거 → 공백 정리 → NFC → 길이 캡. 빈 문자열은 null */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = decodeEntities(value).replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return truncate(s.normalize('NFC'), max);
}

/**
 * 코드포인트 기준으로 자른다(서버 normalizeText·PG char_length 와 같은 기준). UTF-16 단위로 자르면 이모지(서로게이트 쌍)
 * 한가운데가 잘려 홀로 남은 서로게이트가 제목 끝에 붙는다 — 서버는 그걸 고치지 않고 그대로 저장한다.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s; // UTF-16 길이가 max 이하면 코드포인트 수도 max 이하
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return `${cps
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// 타임아웃
// ---------------------------------------------------------------------------

interface Budget {
  signal: AbortSignal;
  /** 파서 자체 타이머가 끊었나 — 호출자 signal 이 먼저 끊은 경우는 false */
  timedOut: () => boolean;
  release: () => void;
}

/**
 * 연결부터 본문 수신까지 하나의 예산. 호출자 signal 이 먼저 끊기면 그대로 따라 끊는다.
 * fetch 결과를 다 읽은 뒤 release() 로 타이머·리스너를 정리해야 한다.
 */
function createBudget(opts: ParseOptions): Budget {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return; // 호출자가 먼저 끊었다 — 타임아웃으로 치지 않는다
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const outer = opts.signal;
  const onAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    release: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 예산 안에서 fetch + 파싱을 돌린다. 파서 자체 타이머가 끊은 경우만 { timedOut: true } 가 붙은 빈 결과로 바꿔 돌려주고,
 * 호출자 signal 로 끊긴 것과 그 외 예외는 그대로 던져 parseOnDevice 가 평범한 빈 결과로 삼키게 둔다.
 */
async function withBudget(
  opts: ParseOptions,
  run: (signal: AbortSignal) => Promise<DeviceParseResult>,
): Promise<DeviceParseResult> {
  const budget = createBudget(opts);
  try {
    return await run(budget.signal);
  } catch (e) {
    if (budget.timedOut()) return { ...EMPTY, timedOut: true };
    throw e;
  } finally {
    budget.release();
  }
}
