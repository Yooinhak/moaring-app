// TikTok 어댑터 — og 가 전무해 SSR JSON(__UNIVERSAL_DATA_FOR_REHYDRATION__) 을 읽는다
//
// 관측 (2026-11-04 프로브): /@user/video/<id> 432 KB 본문에 og:*/twitter:* 가 0개, <title> 은 'TikTok - Make Your Day'.
// 데이터는 <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json"> 의
// __DEFAULT_SCOPE__['webapp.video-detail'] 아래 statusCode(0 = 정상)·shareMeta.title·itemInfo.itemStruct.{id, desc,
// author.nickname, author.uniqueId, video.cover, video.originCover}. 커버 URL 은 x-expires 서명이라 같은 호출에서 즉시 복사된다.
// 프로필 경로는 HTTP 200 인데 1,462 B WAF 스텁(slardar_us_waf, x-tt-system-error: 3) 이 왔다 → 상태코드를 믿지 말고 스텁을 따로
// 판정한다. 공식 oEmbed 는 html 만 돌려줘(title·author·thumbnail 없음) 쓰지 않는다. vm./vt. 단축 링크는 미검증 —
// *.tiktok.com 안에서만 ≤5홉 해석한다. 비공식 마크업이라 형태가 바뀌면 failed('tiktok_shape') 가 늘어난다(모니터링 SQL 로 감지).

import { canonicalize, matchesHost, parseHttpUrl } from '../canonical.ts';
import { firstLine, normalizeText } from '../html.ts';
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
  needsClient,
  nonOkOutcome,
  ready,
  remainingMs,
  runGeneric,
  unsupported,
} from './generic.ts';

export const TIKTOK_HOSTS: HostPattern[] = ['*.tiktok.com'];
/** 정상 영상 페이지는 400 KB 대, WAF 스텁은 1.5 KB 였다. */
export const TIKTOK_WAF_MIN_BYTES = 5000;

const VIDEO_RE = /\/video\/(\d+)(?:[/?#]|$)/;
const USER_RE = /^\/@([^/?#]+)\//;
const SSR_SCRIPT_RE =
  /<script\b[^>]*\bid\s*=\s*["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script\s*>/i;

export interface TikTokVideoRef {
  id: string;
  /** '@' 없는 uniqueId. m.tiktok.com/v/<id>.html 같은 폼엔 없다. */
  user: string | null;
}

export function extractTikTokVideo(u: URL): TikTokVideoRef | null {
  if (!matchesHost(u.hostname, TIKTOK_HOSTS)) return null;
  const m = VIDEO_RE.exec(u.pathname);
  if (!m) return null;
  const user = USER_RE.exec(u.pathname);
  return { id: m[1], user: user ? user[1] : null };
}

/** vm./vt. 단축 호스트와 www.tiktok.com/t/<code> 는 Location 을 따라가야 영상 경로가 나온다. */
export function tiktokNeedsResolve(u: URL): boolean {
  return /^v[mt]\.tiktok\.com$/.test(u.hostname) || /^\/t\/[^/]+/.test(u.pathname);
}

export function tiktokVideoUrl(ref: TikTokVideoRef): string {
  return ref.user ? `https://www.tiktok.com/@${ref.user}/video/${ref.id}` : `https://www.tiktok.com/video/${ref.id}`;
}

/** 200 이어도 본문이 WAF 스텁이면 파싱 금지. 크기·마커·헤더 셋 중 하나면 스텁. */
export function isTikTokWafStub(res: FetchTextResult): boolean {
  if (res.headers['x-tt-system-error'] !== undefined) return true;
  if (res.text.length < TIKTOK_WAF_MIN_BYTES) return true;
  return /slardar_us_waf/i.test(res.text.slice(0, 16384));
}

export type TikTokSsrResult =
  | { kind: 'ok'; fields: PreviewFields }
  | { kind: 'unsupported'; error: string } // statusCode ≠ 0 — 삭제·비공개·지역 제한
  | { kind: 'failed'; error: string }; // 'tiktok_shape' — 스크립트 없음·JSON 깨짐·경로 불일치

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function isHttpUrl(v: string | null): v is string {
  return v !== null && /^https?:\/\//i.test(v);
}

/** SSR JSON → 필드. 순수 함수 — bun 테스트와 parseSubmitted(폰이 보낸 HTML) 가 같이 쓴다. */
export function parseTikTokSsr(html: string): TikTokSsrResult {
  const m = SSR_SCRIPT_RE.exec(html);
  if (!m) return { kind: 'failed', error: 'tiktok_shape' };
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return { kind: 'failed', error: 'tiktok_shape' }; // 1 MiB 캡에 잘린 JSON 도 여기로 — 정상 본문은 ~430 KB
  }
  const detail = obj(obj(obj(data)?.__DEFAULT_SCOPE__)?.['webapp.video-detail']);
  if (!detail) return { kind: 'failed', error: 'tiktok_shape' };

  const statusCode = detail.statusCode;
  if (typeof statusCode === 'number' && statusCode !== 0) {
    return { kind: 'unsupported', error: `tiktok_status_${statusCode}` };
  }
  const item = obj(obj(detail.itemInfo)?.itemStruct);
  if (!item) return { kind: 'failed', error: 'tiktok_shape' };

  const author = obj(item.author);
  const video = obj(item.video);
  const share = obj(detail.shareMeta);
  const desc = str(item.desc);
  const nickname = str(author?.nickname);
  const uniqueId = str(author?.uniqueId);
  const id = str(item.id);

  // 제목은 캡션 첫 줄(≤80). 캡션이 없으면 shareMeta.title('Khabane lame on TikTok').
  const title =
    firstLine(desc, 80) ??
    normalizeText(str(share?.title), FIELD_LIMITS.title, { singleLine: true }) ??
    (nickname ? `${nickname} on TikTok` : null);
  const full = normalizeText(desc, FIELD_LIMITS.description);
  const description = full && full !== title ? full : null;

  const imageCandidates = [str(video?.cover), str(video?.originCover)]
    .filter(isHttpUrl)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  return {
    kind: 'ok',
    fields: {
      title,
      description,
      author: uniqueId ? `@${uniqueId}` : nickname,
      siteName: 'TikTok',
      canonicalUrl: uniqueId && id ? tiktokVideoUrl({ id, user: uniqueId }) : null,
      imageCandidates,
    },
  };
}

export const tiktokAdapter: SiteAdapter = {
  id: 'tiktok',
  serverFetch: true,
  // p16-common-sign.tiktokcdn.com 관측. 리전별 tiktokcdn-us.com / tiktokcdn-eu.com 변형도 같은 패턴
  imageHosts: [/(?:^|\.)tiktokcdn(?:-[a-z]{2,3})?\.com$/i],

  match(u: URL): boolean {
    return matchesHost(u.hostname, TIKTOK_HOSTS);
  },

  canonicalize(u: URL): CanonicalResult {
    const ref = extractTikTokVideo(u);
    if (!ref || !ref.user) return canonicalize(u);
    const c = tiktokVideoUrl(ref);
    return { fetchUrl: c, canonicalUrl: c };
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    let u = parseHttpUrl(ctx.fetchUrl) ?? parseHttpUrl(ctx.postUrl);
    if (!u) return failed('bad_url');

    if (tiktokNeedsResolve(u)) {
      const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
      if (timeoutMs <= 0) return failed('timeout');
      try {
        const r = await ctx.io.resolveRedirects(u.href, { maxHops: 5, hopAllow: TIKTOK_HOSTS, timeoutMs });
        const resolved = parseHttpUrl(r.final);
        if (!resolved) return failed('tiktok_unresolved');
        u = resolved;
      } catch (e) {
        return failed(errorCode(e));
      }
    }

    const ref = extractTikTokVideo(u);
    // 프로필·사진 글 등은 generic — WAF 스텁이면 generic 의 detectBlockPage 가 blocked:waf 로 보낸다
    if (!ref) return runGeneric(ctx, { url: u.href, hopAllow: TIKTOK_HOSTS });

    const pageUrl = tiktokVideoUrl(ref);
    const partial = emptyFields({
      siteName: 'TikTok',
      author: ref.user ? `@${ref.user}` : null,
      canonicalUrl: ref.user ? pageUrl : ctx.canonicalUrl,
    });

    const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
    if (timeoutMs <= 0) return failed('timeout');
    let res: FetchTextResult;
    try {
      // SSR JSON 은 <body> 안이라 조기 중단 금지. 정상 본문 ~430 KB → 1 MiB 캡 안.
      res = await ctx.io.fetchText(pageUrl, {
        maxBytes: BUDGET.htmlMaxBytes,
        timeoutMs,
        stopAtHead: false,
        hopAllow: TIKTOK_HOSTS,
        maxHops: 3,
      });
    } catch (e) {
      return failed(errorCode(e));
    }

    const nonOk = nonOkOutcome(ctx, res, pageUrl);
    if (nonOk) return nonOk;
    if (isTikTokWafStub(res)) {
      ctx.log('tiktok.waf_stub', { bytes: res.text.length });
      return needsClient('blocked:waf', pageUrl, 'fetch', 'tiktok_ssr', partial);
    }

    const parsed = parseTikTokSsr(res.text);
    if (parsed.kind === 'ok') {
      return ready({ ...parsed.fields, canonicalUrl: parsed.fields.canonicalUrl ?? partial.canonicalUrl }, 'embed');
    }
    if (parsed.kind === 'unsupported') return unsupported(parsed.error, partial);
    return failed(parsed.error);
  },

  parseSubmitted(html: string, finalUrl: string): PreviewFields | null {
    const parsed = parseTikTokSsr(html);
    if (parsed.kind !== 'ok') return null;
    const u = parseHttpUrl(finalUrl);
    const ref = u ? extractTikTokVideo(u) : null;
    return { ...parsed.fields, canonicalUrl: parsed.fields.canonicalUrl ?? (ref?.user ? tiktokVideoUrl(ref) : null) };
  },
};
