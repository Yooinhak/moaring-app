// PreviewIO 구현 — 리다이렉트 수동 추적 · 스트림 바이트 캡 · Content-Type 선분류 · charset 디코드
//
// 설계 §5·§7 의 I/O 규칙을 한 곳에 모은다. 어댑터(sites/*.ts) 는 여기서 만든 io 만 쓰고 fetch 를 직접 부르지 않는다.
//   - 모든 요청은 requestWithRedirects 하나를 지난다 → 시작 URL 과 모든 홉이 ssrf.assertPublicHttpUrl 을 거친다.
//   - redirect:'manual' 로 홉마다 Location 을 직접 해석한다 (naver.me 는 5홉·3호스트·상대 Location — probes/edge-cases).
//     hopAllow 가 있으면 홉 호스트를 허용목록으로 좁힌다 (t.co → x.com 계열만, naver.me → *.naver.com 만 …).
//   - 바이트 캡은 Range 가 아니라 스트림 읽기 + cancel 로 건다 (프로브 5곳 중 4곳이 Range 를 무시). stopAtHead 면
//     `</head>`·`<body` 가 보이는 즉시 멈춘다 — YouTube 는 첫 og 가 777 KB 뒤라 1 MiB 캡이 필요하지만 보통 head 는 35 KB 미만.
//   - 본문은 바이트로 모아 charset.decodeHtmlBytes 로 "한 번만" 디코드한다 (yes24 EUC-KR — 잘못 디코드하면 복구 불가).
//   - 비 2xx 의 HTML 본문도 64 KB 까지는 읽어 돌려준다 — html.detectBlockPage 가 Cloudflare 'Attention Required!'·
//     Akamai 'Access Denied' 시그니처를 보려면 본문이 필요하다. 비 2xx 를 저장하지 않는 것은 호출자 책임이다.
//   - 요청 헤더는 Accept 만 둔다. UA 헤더는 설정하지 않는다 (런타임 기본값 — 설계 §5, 스푸핑·미검증 변수 금지). 쿠키·리퍼러 없음.
//
// bun 테스트: fetchImpl·resolve 를 주입해 네트워크 없이 전 경로를 돌린다 (__tests__/fetch.test.ts).

import { decodeHtmlBytes, mediaType } from './charset.ts';
import { assertPublicHttpUrl, SsrfError } from './ssrf.ts';
import type { DnsResolver, FetchLike } from './ssrf.ts';
import { BUDGET } from './types.ts';
import type {
  FetchJsonOptions,
  FetchJsonResult,
  FetchTextOptions,
  FetchTextResult,
  HeadOptions,
  HeadResult,
  HostPattern,
  PreviewIO,
  PreviewLogger,
  ResolveRedirectsOptions,
  ResolveRedirectsResult,
} from './types.ts';

// ---------------------------------------------------------------------------
// 에러
// ---------------------------------------------------------------------------

export type IoErrorCode = 'timeout' | 'too_many_redirects' | 'network';

export class PreviewIoError extends Error {
  readonly code: IoErrorCode;
  /** 로그엔 호스트만 남긴다 (URL 전체는 추적 토큰·개인 경로를 담을 수 있다). */
  readonly hostname: string;

  constructor(code: IoErrorCode, hostname: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause);
    super(detail ? `${code} (${hostname}): ${detail}` : `${code} (${hostname})`);
    this.name = 'PreviewIoError';
    this.code = code;
    this.hostname = hostname;
  }
}

/**
 * 어떤 예외든 preview_error 에 넣을 짧은 코드로. SsrfError·PreviewIoError 는 자기 code, AbortSignal.timeout 의
 * TimeoutError/AbortError 는 'timeout', fetch 의 TypeError(연결 실패) 는 'network', 나머지는 'unexpected'.
 */
export function errorCode(err: unknown): string {
  if (err instanceof SsrfError || err instanceof PreviewIoError) return err.code;
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (err instanceof TypeError) return 'network';
  return 'unexpected';
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function toIoError(err: unknown, url: string): Error {
  if (err instanceof SsrfError || err instanceof PreviewIoError) return err;
  const code = errorCode(err);
  return new PreviewIoError(code === 'timeout' ? 'timeout' : 'network', hostnameOf(url), err);
}

// ---------------------------------------------------------------------------
// 스트림 읽기 — 캡 + 조기 중단
// ---------------------------------------------------------------------------

/** 비 2xx 응답 본문은 차단 시그니처 판정에만 쓰므로 이만큼만 읽는다 (Cloudflare 5.6 KB, TikTok WAF 스텁 <8 KB). */
export const NON_2XX_BODY_CAP = 64 * 1024;

const HEAD_END_MARKERS = ['</head>', '<body'] as const;
const MARKER_CARRY = 6; // '</head>' 7바이트가 청크 경계에 걸칠 때 직전 청크에서 들고 올 꼬리 길이

/** ASCII 대소문자 무관으로 마커('<' 로 시작) 중 하나가 있는가. 1 MiB 청크도 '<' 위치에서만 비교해 싸다. */
export function hasHeadEnd(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x3c) continue; // '<'
    for (const marker of HEAD_END_MARKERS) {
      if (i + marker.length > bytes.length) continue;
      let match = true;
      for (let j = 1; j < marker.length; j++) {
        let c = bytes[i + j];
        if (c >= 0x41 && c <= 0x5a) c |= 0x20;
        if (c !== marker.charCodeAt(j)) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }
  return false;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  // 항상 새 ArrayBuffer 에 복사한다 — crypto.subtle.digest·Blob 이 받는 타입으로 고정되고, 청크 참조도 끊긴다
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface ReadCappedOptions {
  maxBytes: number;
  /** `</head>`·`<body` 를 보면 멈춘다. 본문이 필요한 곳(Instagram 임베드·TikTok SSR·이미지) 은 false. */
  stopAtHead?: boolean;
}

export interface ReadCappedResult {
  bytes: Uint8Array;
  /** 캡 또는 조기 중단으로 끝까지 읽지 않았으면 true. */
  truncated: boolean;
}

/**
 * 본문 스트림을 maxBytes 까지만 읽고 reader.cancel 로 연결을 끊는다. 압축은 fetch 가 이미 풀었으므로 캡은 해제 후 바이트.
 * 읽기 중 타임아웃(fetch signal) 은 그대로 전파된다 — 부분 본문으로 파싱하지 않는다.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  opts: ReadCappedOptions,
): Promise<ReadCappedResult> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let carry: Uint8Array = new Uint8Array(0);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      let chunk = value;
      if (total + chunk.length > opts.maxBytes) {
        chunk = chunk.subarray(0, Math.max(0, opts.maxBytes - total));
        truncated = true;
      }
      if (chunk.length > 0) {
        chunks.push(chunk);
        total += chunk.length;
      }
      if (truncated) break;

      if (opts.stopAtHead) {
        const window = carry.length > 0 ? concatBytes([carry, chunk], carry.length + chunk.length) : chunk;
        if (hasHeadEnd(window)) {
          truncated = true;
          break;
        }
        carry = chunk.subarray(Math.max(0, chunk.length - MARKER_CARRY));
      }
    }
  } finally {
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        // 이미 닫힌 스트림 — 무시
      }
    } else {
      reader.releaseLock();
    }
  }

  return { bytes: concatBytes(chunks, total), truncated };
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 본문이 없거나 이미 소비됨
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

// ---------------------------------------------------------------------------
// 요청 공통 경로 — 리다이렉트 수동 추적 (여기 말고는 fetch 를 부르는 곳이 없다)
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Location 을 현재 URL 기준으로 절대화한다 (naver.me 는 '/service/5637?lang=ko' 같은 상대 Location). 해석 불가면 null. */
export function resolveLocation(location: string, currentUrl: string): string | null {
  try {
    const next = new URL(location.trim(), currentUrl);
    next.hash = '';
    return next.href;
  } catch {
    return null;
  }
}

export interface PreviewIODeps {
  /** 테스트용 가짜 fetch. 기본 globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** 테스트용 DNS 해석기. SSRF 검사는 항상 수행되고 해석기만 바뀐다. */
  resolve?: DnsResolver;
  log?: PreviewLogger;
}

export interface RawRequestOptions {
  method?: 'GET' | 'HEAD';
  accept: string;
  /** 홉 전체(연결·헤더·본문 읽기 포함) 의 총 예산. 홉마다 남은 시간을 AbortSignal.timeout 으로 건다. */
  timeoutMs: number;
  /** 따라갈 리다이렉트 수 상한. BUDGET.maxHops(8) 를 넘길 수는 없다. */
  maxHops?: number;
  /** 리다이렉트 대상(홉 ≥ 1) 호스트 허용목록. 시작 URL 에는 적용하지 않는다 — 어댑터가 이미 고른 주소다. */
  hopAllow?: readonly HostPattern[];
  /** 시작 URL 에도 적용할 허용목록 (이미지 imageHosts). */
  startAllow?: readonly HostPattern[];
  /** 첫 응답의 Location 만 읽고 따라가지 않는다 (naver.me·link.coupang.com). */
  firstHopOnly?: boolean;
}

export interface RawRequestResult {
  /** 최종 응답. 리다이렉트 응답의 본문은 이미 cancel 됐고, firstHopOnly 로 멈췄으면 그 3xx 응답이다. */
  response: Response;
  /** response 를 받은 URL. */
  finalUrl: string;
  /** 거친 URL (시작 포함, finalUrl 제외). */
  hops: string[];
  /** 첫 응답이 리다이렉트였으면 그 Location 의 절대 URL. */
  firstLocation?: string;
}

/**
 * GET/HEAD 를 보내고 3xx 를 직접 따라간다. 홉마다 assertPublicHttpUrl(+hopAllow) 을 통과해야 다음 요청이 나간다.
 * Location 이 없거나 해석 불가인 3xx 는 최종 응답으로 취급한다 (304 등). 홉 초과는 PreviewIoError('too_many_redirects').
 */
export async function requestWithRedirects(
  url: string,
  opts: RawRequestOptions,
  deps: PreviewIODeps = {},
): Promise<RawRequestResult> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const method = opts.method ?? 'GET';
  const maxHops = Math.max(0, Math.min(opts.maxHops ?? BUDGET.maxHops, BUDGET.maxHops));
  const deadline = Date.now() + opts.timeoutMs;
  const hops: string[] = [];
  let firstLocation: string | undefined;
  let current = url;

  for (let hop = 0; ; hop++) {
    const check = await assertPublicHttpUrl(current, {
      allowHosts: hop === 0 ? opts.startAllow : opts.hopAllow,
      resolve: deps.resolve,
    });
    current = check.url.href;

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PreviewIoError('timeout', check.hostname, 'budget exhausted before request');

    let res: Response;
    try {
      res = await fetchImpl(current, {
        method,
        redirect: 'manual',
        headers: { accept: opts.accept },
        signal: AbortSignal.timeout(Math.max(1, Math.floor(remaining))),
      });
    } catch (err) {
      throw toIoError(err, current);
    }

    if (!isRedirectStatus(res.status)) {
      return { response: res, finalUrl: current, hops, firstLocation };
    }

    const location = res.headers.get('location');
    await discardBody(res);
    const next = location ? resolveLocation(location, current) : null;
    if (!next) {
      // Location 없는 3xx — 더 갈 곳이 없으니 이 응답이 끝이다
      return { response: res, finalUrl: current, hops, firstLocation };
    }
    if (hop === 0) firstLocation = next;
    deps.log?.('redirect', { from_host: check.hostname, to_host: hostnameOf(next), status: res.status, hop: hop + 1 });

    if (opts.firstHopOnly) {
      return { response: res, finalUrl: current, hops, firstLocation };
    }
    if (hop >= maxHops) throw new PreviewIoError('too_many_redirects', check.hostname);
    hops.push(current);
    current = next;
  }
}

// ---------------------------------------------------------------------------
// PreviewIO
// ---------------------------------------------------------------------------

const HTML_ACCEPT = 'text/html, application/xhtml+xml';
const JSON_ACCEPT = 'application/json';
const JSON_DEFAULT_MAX_BYTES = 256 * 1024;

function isHtmlType(contentType: string | null): boolean {
  // Content-Type 이 없으면 HTML 로 보고 읽는다 — 파서가 유용성 판정으로 걸러낸다
  return contentType === null || contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

function isJsonType(contentType: string | null): boolean {
  return (
    contentType !== null &&
    (contentType === 'application/json' || contentType === 'text/json' || contentType.endsWith('+json'))
  );
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * PreviewIO 를 만든다. deps 는 테스트 주입용 — 운영에서는 createPreviewIO() 로 충분하다.
 * 네 메서드 전부 requestWithRedirects 를 지나므로 SSRF 검사를 우회하는 경로가 없다.
 */
export function createPreviewIO(deps: PreviewIODeps = {}): PreviewIO {
  return {
    async fetchText(url: string, opts: FetchTextOptions): Promise<FetchTextResult> {
      const r = await requestWithRedirects(
        url,
        {
          method: 'GET',
          accept: HTML_ACCEPT,
          timeoutMs: opts.timeoutMs,
          maxHops: opts.maxHops,
          hopAllow: opts.hopAllow,
        },
        deps,
      );
      const res = r.response;
      const headers = headersToRecord(res.headers);
      const rawContentType = res.headers.get('content-type');
      const contentType = mediaType(rawContentType);
      const base: FetchTextResult = { status: res.status, finalUrl: r.finalUrl, contentType, text: '', headers };

      if (!isHtmlType(contentType)) {
        // image/*·application/pdf·기타 — 본문을 읽지 않는다. 호출자가 contentType 으로 분기한다 (파일명 제목·이미지 직접 복사)
        await discardBody(res);
        return base;
      }

      const maxBytes = is2xx(res.status) ? opts.maxBytes : Math.min(opts.maxBytes, NON_2XX_BODY_CAP);
      let read: ReadCappedResult;
      try {
        read = await readCapped(res.body, { maxBytes, stopAtHead: opts.stopAtHead ?? false });
      } catch (err) {
        throw toIoError(err, r.finalUrl);
      }
      const decoded = decodeHtmlBytes(read.bytes, rawContentType);
      deps.log?.('fetch_text', {
        host: hostnameOf(r.finalUrl),
        status: res.status,
        bytes: read.bytes.length,
        truncated: read.truncated,
        charset: decoded.charset,
      });
      return {
        ...base,
        text: decoded.text,
        truncated: read.truncated,
        charset: decoded.charset,
        replacementRatio: decoded.replacementRatio,
      };
    },

    async fetchJson(url: string, opts: FetchJsonOptions): Promise<FetchJsonResult> {
      const r = await requestWithRedirects(
        url,
        { method: 'GET', accept: JSON_ACCEPT, timeoutMs: opts.timeoutMs, hopAllow: opts.hopAllow },
        deps,
      );
      const res = r.response;
      const headers = headersToRecord(res.headers);
      const contentType = mediaType(res.headers.get('content-type'));
      const base: FetchJsonResult = { status: res.status, finalUrl: r.finalUrl, contentType, json: null, headers };

      if (!isJsonType(contentType)) {
        await discardBody(res);
        return base;
      }
      let read: ReadCappedResult;
      try {
        read = await readCapped(res.body, { maxBytes: opts.maxBytes ?? JSON_DEFAULT_MAX_BYTES });
      } catch (err) {
        throw toIoError(err, r.finalUrl);
      }
      if (read.truncated) return base; // 잘린 JSON 은 파싱 의미가 없다
      try {
        return { ...base, json: JSON.parse(new TextDecoder('utf-8').decode(read.bytes)) as unknown };
      } catch {
        return base;
      }
    },

    async head(url: string, opts: HeadOptions): Promise<HeadResult> {
      const r = await requestWithRedirects(
        url,
        { method: 'HEAD', accept: '*/*', timeoutMs: opts.timeoutMs, hopAllow: opts.hopAllow },
        deps,
      );
      await discardBody(r.response);
      return { status: r.response.status, contentType: mediaType(r.response.headers.get('content-type')) };
    },

    async resolveRedirects(url: string, opts: ResolveRedirectsOptions): Promise<ResolveRedirectsResult> {
      // GET 으로 보낸다 (프로브와 동일; 단축 서비스 중엔 HEAD 를 다르게 다루는 곳이 있다). 본문은 읽지 않고 바로 끊는다.
      const r = await requestWithRedirects(
        url,
        {
          method: 'GET',
          accept: HTML_ACCEPT,
          timeoutMs: opts.timeoutMs ?? BUDGET.htmlTimeoutMs,
          maxHops: opts.maxHops,
          hopAllow: opts.hopAllow,
          firstHopOnly: opts.firstHopOnly,
        },
        deps,
      );
      await discardBody(r.response);
      return { hops: r.hops, final: r.finalUrl, firstLocation: r.firstLocation, status: r.response.status };
    },
  };
}
