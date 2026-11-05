// 범용 og/twitter/<title> 어댑터 + 다른 어댑터들이 공유하는 fetch·판정 헬퍼
//
// 관측 근거 (2026-11-04 프로브, 주거용 IP·curl 기본 UA): github·pinterest·brunch·tistory·velog·daum·kakao·ohou·kurly·
// daangn·chosun·joongang·yes24·namu 는 전부 <head> 안의 og 로 충분했다. 반면 비 2xx 본문도 og 를 담고 있었다 —
// X 404 는 'Post Not Found', Cloudflare 403 은 'Attention Required!' — 그래서 파싱보다 상태코드 게이트가 먼저다.
// gov.kr 은 og 없이 <meta http-equiv=refresh> 만, excalidraw·diagrams.net 은 가시 텍스트 수백 자의 SPA 셸이었다.
//
// 네트워크는 ctx.io 만 쓴다. Deno 전역(fetch 등) 을 직접 부르지 않아야 bun 에서 가짜 io 를 꽂아 테스트할 수 있고,
// SSRF·홉 허용목록·바이트 캡이 fetch.ts 한 곳에만 있게 된다.

import { matchesHost, parseHttpUrl } from '../canonical.ts';
import {
  detectBlockPage,
  filenameFromUrl,
  findMetaRefresh,
  isUsefulMeta,
  looksLikeSpaShell,
  normalizeText,
  parseTags,
  pickFields,
} from '../html.ts';
import type { BlockSignature, ParsedTags, PickedFields } from '../html.ts';
import { BUDGET, FIELD_LIMITS } from '../types.ts';
import type {
  ClientParser,
  ClientRunner,
  FetchTextResult,
  HostPattern,
  PreviewFields,
  PreviewSource,
  ProviderCtx,
  ProviderOutcome,
  SiteAdapter,
} from '../types.ts';

// ---------------------------------------------------------------------------
// outcome 생성·에러 코드 (어댑터 공용)
// ---------------------------------------------------------------------------

/** 치환문자(U+FFFD) 비율이 이보다 크면 디코딩 실패로 보고 텍스트 필드를 버린다 (설계 §10). */
export const MAX_REPLACEMENT_RATIO = 0.05;

export function emptyFields(partial: Partial<PreviewFields> = {}): PreviewFields {
  return {
    title: null,
    description: null,
    author: null,
    siteName: null,
    canonicalUrl: null,
    imageCandidates: [],
    ...partial,
  };
}

export function ready(fields: PreviewFields, source: PreviewSource): ProviderOutcome {
  return { kind: 'ready', fields, source };
}

export function failed(error: string): ProviderOutcome {
  return { kind: 'failed', error: clampError(error) };
}

export function unsupported(error: string, fields?: PreviewFields): ProviderOutcome {
  return fields
    ? { kind: 'unsupported', error: clampError(error), fields }
    : { kind: 'unsupported', error: clampError(error) };
}

export function needsClient(
  error: string,
  url: string,
  runner: ClientRunner,
  parser: ClientParser,
  fields?: PreviewFields,
): ProviderOutcome {
  const base = { kind: 'needs_client' as const, error: clampError(error), task: { runner, parser, url } };
  return fields ? { ...base, fields } : base;
}

function clampError(code: string): string {
  return normalizeText(code, FIELD_LIMITS.error, { singleLine: true }) ?? 'unknown';
}

/** 남은 예산(ms). 0 이면 네트워크 호출을 시작하지 말고 failed('timeout') 으로 끝낸다. */
export function remainingMs(ctx: ProviderCtx, cap: number): number {
  return Math.max(0, Math.min(cap, ctx.deadline - Date.now()));
}

/**
 * io 가 던진 예외 → 짧은 코드. fetch.ts 가 code 속성을 주면 그대로 쓰고, 아니면 메시지로 추정한다.
 * catch-up 이 재시도하는 일시 코드는 'timeout' | 'dns_failed' | 'http_5xx' | 'network'(fetch.ts toIoError) | 'fetch_failed' —
 * 클라이언트 src/utils/preview/types.ts TRANSIENT_PREVIEW_ERRORS 와 1:1 이라 이름을 정확히 맞춘다.
 */
export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.trim()) return clampError(code);
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (name === 'AbortError' || name === 'TimeoutError' || /time[d ]?out|aborted|deadline/i.test(msg)) return 'timeout';
  if (/dns|getaddrinfo|enotfound|eai_again|name not resolved|resolve/i.test(msg)) return 'dns_failed';
  if (/ssrf|private|loopback|link-local|metadata|not allowed|disallowed|hop/i.test(msg)) return 'ssrf';
  if (/too (?:large|many)|max ?bytes|exceed/i.test(msg)) return 'too_large';
  return 'fetch_failed';
}

/** 비 2xx 상태 → 코드. 404/410 은 영구('gone'), 5xx 는 재시도 대상('http_5xx'), 나머지는 상태 그대로('http_403' …). */
export function httpErrorCode(status: number): string {
  if (status === 404 || status === 410) return 'gone';
  if (status >= 500) return 'http_5xx';
  return `http_${status}`;
}

export function blockErrorCode(sig: BlockSignature): string {
  return sig === 'waf_stub' ? 'blocked:waf' : sig;
}

export function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

export function hostnameOf(url: string): string {
  return parseHttpUrl(url)?.hostname ?? '';
}

/**
 * 비 2xx 응답의 outcome. 2xx 면 null. 차단 시그니처 → needs_client(폰이 같은 URL 을 fetch), 404/410 → unsupported('gone'),
 * 그 외 → failed. 본문은 어떤 경우에도 파싱하지 않는다 — 404 X 페이지의 og 가 그대로 저장되는 사고를 막는 게 이 함수다.
 */
export function nonOkOutcome(ctx: ProviderCtx, res: FetchTextResult, clientUrl: string): ProviderOutcome | null {
  if (isOk(res.status)) return null;
  const sig = detectBlockPage(res.status, res.headers, res.text);
  if (sig) {
    return needsClient(
      blockErrorCode(sig),
      clientUrl,
      'fetch',
      'generic',
      emptyFields({ canonicalUrl: ctx.canonicalUrl }),
    );
  }
  if (res.status === 404 || res.status === 410) return unsupported('gone');
  return failed(httpErrorCode(res.status));
}

/** fetch.ts 는 HTML 이 아니면 text 를 '' 로 준다. contentType 이 없는데 본문이 있으면 HTML 로 본다. */
export function isHtmlResponse(res: FetchTextResult): boolean {
  const ct = res.contentType ?? '';
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return true;
  return ct === '' && res.text.length > 0;
}

// ---------------------------------------------------------------------------
// 페이지 fetch + 분류 (generic 본체, facebook/linkedin/pinterest 가 재사용)
// ---------------------------------------------------------------------------

export interface FetchPageOptions {
  /** 기본 ctx.fetchUrl. 어댑터가 재작성한 주소(watch?v=, m.blog …) 를 넘긴다. */
  url?: string;
  /** 기본 BUDGET.htmlMaxBytes. */
  maxBytes?: number;
  /** 기본 true — og 는 <head> 에 있다. 본문이 필요한 어댑터만 false. */
  stopAtHead?: boolean;
  hopAllow?: HostPattern[];
  maxHops?: number;
}

export interface GenericPage {
  res: FetchTextResult;
  tags: ParsedTags;
  fields: PickedFields;
  /** 2xx 인데 JS 없이는 내용이 없는 셸 — 호출자가 needs:webview 로 보낸다. */
  spaShell: boolean;
}

export type FetchPageResult = { done: true; outcome: ProviderOutcome } | { done: false; page: GenericPage };

/** 링크 자체가 이미지·PDF 등 파일인 경우. 이미지면 자기 URL 을 후보로(서버가 받아 https Storage 로 복사). SVG 는 복사 단계가 거부한다. */
function directOutcome(ctx: ProviderCtx, res: FetchTextResult): ProviderOutcome {
  const ct = res.contentType ?? '';
  const isImage = ct.startsWith('image/') && ct !== 'image/svg+xml';
  return ready(
    emptyFields({
      title: filenameFromUrl(res.finalUrl),
      canonicalUrl: ctx.canonicalUrl,
      imageCandidates: isImage ? [res.finalUrl] : [],
    }),
    'direct',
  );
}

/**
 * 한 번 fetch 해서 2xx HTML 이면 파싱 결과를, 아니면 확정된 outcome 을 돌려준다.
 * 2xx 라도 차단 시그니처(TikTok WAF 스텁 200, LinkedIn 999 …) 는 본문을 버리고 needs_client 로 보낸다.
 */
export async function fetchPage(ctx: ProviderCtx, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const url = opts.url ?? ctx.fetchUrl;
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return { done: true, outcome: failed('timeout') };

  let res: FetchTextResult;
  try {
    res = await ctx.io.fetchText(url, {
      maxBytes: opts.maxBytes ?? BUDGET.htmlMaxBytes,
      timeoutMs,
      stopAtHead: opts.stopAtHead ?? true,
      hopAllow: opts.hopAllow,
      maxHops: opts.maxHops ?? BUDGET.maxHops,
    });
  } catch (e) {
    return { done: true, outcome: failed(errorCode(e)) };
  }

  const nonOk = nonOkOutcome(ctx, res, url);
  if (nonOk) return { done: true, outcome: nonOk };

  const sig = detectBlockPage(res.status, res.headers, res.text);
  if (sig) {
    return {
      done: true,
      outcome: needsClient(
        blockErrorCode(sig),
        url,
        'fetch',
        'generic',
        emptyFields({ canonicalUrl: ctx.canonicalUrl }),
      ),
    };
  }

  if (!isHtmlResponse(res)) return { done: true, outcome: directOutcome(ctx, res) };

  const tags = parseTags(res.text);
  const fields = pickFields(tags, res.finalUrl);

  // 치환문자가 많으면 charset 판정이 틀린 것 — 깨진 글자를 저장하지 않고 ASCII 필드(URL) 만 남긴 채 폰에 넘긴다
  if ((res.replacementRatio ?? 0) > MAX_REPLACEMENT_RATIO) {
    return {
      done: true,
      outcome: needsClient(
        'charset:undecodable',
        url,
        'fetch',
        'generic',
        emptyFields({ canonicalUrl: fields.canonicalUrl ?? ctx.canonicalUrl, imageCandidates: fields.imageCandidates }),
      ),
    };
  }

  return { done: false, page: { res, tags, fields, spaShell: looksLikeSpaShell(res.text, fields) } };
}

/**
 * 파싱된 페이지 → outcome. SPA 셸은 needs:webview(runner 'webview'), 제목이 사이트명·호스트명과 같으면 제목을 버려
 * 도메인 카드가 되게 한다. overrides 로 어댑터가 siteName 등을 덧씌운다.
 */
export function finalizeGeneric(
  ctx: ProviderCtx,
  page: GenericPage,
  overrides: Partial<PreviewFields> = {},
): ProviderOutcome {
  const { res, fields } = page;
  const canonicalUrl = fields.canonicalUrl ?? ctx.canonicalUrl;
  if (page.spaShell) {
    return needsClient(
      'needs:webview',
      res.finalUrl,
      'webview',
      'generic',
      emptyFields({ siteName: fields.siteName, canonicalUrl, imageCandidates: fields.imageCandidates, ...overrides }),
    );
  }
  const useful = isUsefulMeta(fields, hostnameOf(res.finalUrl));
  return ready(
    {
      title: useful ? fields.title : null,
      description: fields.description,
      author: fields.author,
      siteName: fields.siteName,
      canonicalUrl,
      imageCandidates: fields.imageCandidates,
      ...overrides,
    },
    'og',
  );
}

/**
 * generic 전체 흐름: fetch → (og 제목이 없고 meta refresh 가 있으면 1회 추적, 홉 1 소모) → finalize.
 * 다른 어댑터는 url/hopAllow 만 바꿔 위임한다 (YouTube 채널, X 외 경로, pin.it 해석 뒤 등).
 */
export async function runGeneric(ctx: ProviderCtx, opts: FetchPageOptions = {}): Promise<ProviderOutcome> {
  const first = await fetchPage(ctx, opts);
  if (first.done) return first.outcome;

  let page = first.page;
  if (!isUsefulMeta(page.fields, hostnameOf(page.res.finalUrl))) {
    const refresh = findMetaRefresh(page.res.text, page.res.finalUrl);
    const allowed = refresh && (!opts.hopAllow || matchesHost(hostnameOf(refresh), opts.hopAllow));
    if (refresh && allowed && refresh !== page.res.finalUrl) {
      ctx.log('generic.meta_refresh', { host: hostnameOf(refresh) });
      const second = await fetchPage(ctx, {
        ...opts,
        url: refresh,
        maxHops: Math.max(1, (opts.maxHops ?? BUDGET.maxHops) - 1),
      });
      if (second.done) return second.outcome;
      page = second.page;
    }
  }
  return finalizeGeneric(ctx, page);
}

/**
 * 폰이 제출한 HTML(assist) 을 서버 규칙으로 해석. 상태코드는 폰이 이미 게이트했다(response.ok 아니면 blocked:true).
 * 쓸 만한 게 하나도 없으면 null — 호출자가 device 필드로 폴백한다.
 */
export function parseGenericSubmitted(html: string, finalUrl: string): PreviewFields | null {
  if (!html || !html.trim()) return null;
  const tags = parseTags(html);
  const fields = pickFields(tags, finalUrl);
  if (looksLikeSpaShell(html, fields)) return null;
  const useful = isUsefulMeta(fields, hostnameOf(finalUrl));
  const out: PreviewFields = {
    title: useful ? fields.title : null,
    description: fields.description,
    author: fields.author,
    siteName: fields.siteName,
    canonicalUrl: fields.canonicalUrl,
    imageCandidates: fields.imageCandidates,
  };
  const hasAny = out.title || out.description || out.author || out.imageCandidates.length > 0;
  return hasAny ? out : null;
}

export const genericAdapter: SiteAdapter = {
  id: 'generic',
  serverFetch: true,
  match: () => true, // 레지스트리의 마지막 항목 — 어떤 어댑터도 안 잡은 URL 전부
  run: (ctx) => runGeneric(ctx),
  parseSubmitted: parseGenericSubmitted,
};
