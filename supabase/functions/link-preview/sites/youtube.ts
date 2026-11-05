// YouTube 어댑터 — keyless oEmbed(제목·채널) + i.ytimg.com 썸네일 HEAD. HTML 은 폴백에서만 읽는다.
//
// 관측 (2026-11-04 프로브): oEmbed 는 watch?v=·youtu.be·/shorts/·/live/·m.·music. 폼 전부 200(868 B, ~0.2 s) 이지만
// /embed/<id>·/v/<id> 는 영상이 있어도 404 → 항상 id 를 직접 뽑아 watch?v=<id> 로 묻는다. 없는 id 는 400 'Bad Request'.
// oEmbed 엔 설명이 없고 thumbnail_url 은 늘 480px(hqdefault/hq2) 라 maxresdefault → sddefault → hqdefault 를 HEAD 로 고른다 —
// 404 도 content-type image/jpeg 인 120x90 플레이스홀더를 주므로 상태 200 만 인정한다(바디·타입으로는 못 가른다).
// watch 페이지는 1.4 MB, 첫 og 가 ~777 KB 뒤 → oEmbed 가 네트워크 오류일 때만 1 MiB 캡으로 읽고, 설명이 없는 영상의
// og:description 은 로케일별 사이트 보일러플레이트라 pickFields 가 걸러낸다. 비디오 id 가 없는 채널·재생목록은 generic.

import { canonicalize, matchesHost, parseHttpUrl, pathSegments } from '../canonical.ts';
import { BUDGET } from '../types.ts';
import type {
  CanonicalResult,
  FetchJsonResult,
  HostPattern,
  PreviewFields,
  ProviderCtx,
  ProviderOutcome,
  SiteAdapter,
} from '../types.ts';
import { emptyFields, errorCode, httpErrorCode, isOk, ready, remainingMs, runGeneric, unsupported } from './generic.ts';

/** 정확히 이 호스트들만 — 'www.youtube.com.evil.com' 이나 'evil.com/watch?v=' 가 YouTube 로 보이면 안 된다. */
export const YOUTUBE_HOSTS: HostPattern[] = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
];

// 설명 없는 영상의 og:description(요청 IP 로케일의 사이트 소개문) 은 html.ts 의 BOILERPLATE_DESCRIPTION_PATTERNS 가
// 걸러낸다 — 관측된 한국어·영어·일본어 변형이 거기 기본 목록에 들어 있다 (watch 페이지 폴백 때만 쓰인다).

/** generic 위임(채널·재생목록)·watch 폴백 때 리다이렉트가 갈 수 있는 곳. m.youtube.com → www 302 가 실제 있었다. */
const YOUTUBE_HOP_HOSTS: HostPattern[] = ['*.youtube.com', 'youtu.be', '*.youtube-nocookie.com'];

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PATH_ID_RE = /^\/(?:shorts|live|embed|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;
/** 존재 확률 순. maxresdefault 는 HD 업로드만, hqdefault 는 모든 영상에 있다. */
const THUMB_NAMES = ['maxresdefault', 'sddefault', 'hqdefault'] as const;

export interface YouTubeVideoRef {
  id: string;
  /** 원본 경로가 /shorts/ 였나 — site_name 'YouTube Shorts' 용. canonical 은 둘 다 watch?v= 다. */
  shorts: boolean;
}

/**
 * 11자 비디오 id. youtu.be 는 첫 경로 조각, 그 외는 v 쿼리(파라미터 순서 무관 — 리다이렉트된 watch 는 si= 가 v= 앞에 온다),
 * 마지막으로 /shorts|live|embed|v|e/<id>. 호스트가 허용목록 밖이면 무조건 null.
 */
export function extractYouTubeId(u: URL): YouTubeVideoRef | null {
  if (!matchesHost(u.hostname, YOUTUBE_HOSTS)) return null;
  if (u.hostname === 'youtu.be') {
    const first = pathSegments(u)[0];
    return first && VIDEO_ID_RE.test(first) ? { id: first, shorts: false } : null;
  }
  const v = u.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return { id: v, shorts: false };
  const m = PATH_ID_RE.exec(u.pathname);
  if (!m) return null;
  return { id: m[1], shorts: u.pathname.startsWith('/shorts/') };
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** 원본 URL 이 아니라 canonical watch URL 을 넘긴다 — /embed/·/v/ 폼은 oEmbed 가 404 를 준다. */
export function youtubeOembedUrl(id: string): string {
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeWatchUrl(id))}&format=json`;
}

export function youtubeThumbnailUrl(id: string, name: (typeof THUMB_NAMES)[number]): string {
  return `https://i.ytimg.com/vi/${id}/${name}.jpg`;
}

type OembedResult =
  | { kind: 'ok'; title: string; author: string | null }
  | { kind: 'gone' } // 400/404 — 없는·내려간 영상
  | { kind: 'denied' } // 401/403 — 비공개 또는 임베드 금지(미검증) → 페이지 og 로 한 번 더 확인
  | { kind: 'error'; error: string };

async function fetchOembed(ctx: ProviderCtx, id: string): Promise<OembedResult> {
  const timeoutMs = remainingMs(ctx, BUDGET.htmlTimeoutMs);
  if (timeoutMs <= 0) return { kind: 'error', error: 'timeout' };
  let res: FetchJsonResult;
  try {
    res = await ctx.io.fetchJson(youtubeOembedUrl(id), { timeoutMs, hopAllow: YOUTUBE_HOP_HOSTS });
  } catch (e) {
    return { kind: 'error', error: errorCode(e) };
  }
  if (res.status === 400 || res.status === 404) return { kind: 'gone' };
  if (res.status === 401 || res.status === 403) return { kind: 'denied' };
  if (!isOk(res.status)) return { kind: 'error', error: httpErrorCode(res.status) };
  const j = res.json;
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { kind: 'error', error: 'oembed_invalid' };
  const obj = j as Record<string, unknown>;
  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title : null;
  if (!title) return { kind: 'error', error: 'oembed_invalid' };
  const author = typeof obj.author_name === 'string' && obj.author_name.trim() ? obj.author_name : null;
  return { kind: 'ok', title, author };
}

/** HEAD 가 200 인 첫 썸네일. 404 플레이스홀더(image/jpeg) 때문에 상태코드만 본다. 실패는 다음 후보로. */
async function pickThumbnail(ctx: ProviderCtx, id: string): Promise<string | null> {
  for (const name of THUMB_NAMES) {
    const timeoutMs = remainingMs(ctx, BUDGET.imageTimeoutMs);
    if (timeoutMs <= 0) return null;
    const url = youtubeThumbnailUrl(id, name);
    try {
      const r = await ctx.io.head(url, { timeoutMs, hopAllow: ['i.ytimg.com'] });
      if (r.status === 200) return url;
    } catch (e) {
      ctx.log('youtube.thumb_head_failed', { name, error: errorCode(e) });
    }
  }
  return null;
}

function refFromCtx(ctx: ProviderCtx): YouTubeVideoRef | null {
  // postUrl 을 먼저 본다 — canonicalize 가 fetchUrl 을 watch?v= 로 바꿔 /shorts/ 흔적이 사라지기 때문
  const fromPost = parseHttpUrl(ctx.postUrl);
  const ref = fromPost ? extractYouTubeId(fromPost) : null;
  if (ref) return ref;
  const fromFetch = parseHttpUrl(ctx.fetchUrl);
  return fromFetch ? extractYouTubeId(fromFetch) : null;
}

export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  serverFetch: true,
  // i.ytimg.com = 영상 썸네일, yt3.ggpht.com = 채널 아바타(generic 위임 경로의 og:image)
  imageHosts: [/^i\.ytimg\.com$/, /^yt3\.ggpht\.com$/],

  match(u: URL): boolean {
    return matchesHost(u.hostname, YOUTUBE_HOSTS);
  },

  canonicalize(u: URL): CanonicalResult {
    const ref = extractYouTubeId(u);
    if (!ref) return canonicalize(u);
    const watch = youtubeWatchUrl(ref.id);
    return { fetchUrl: watch, canonicalUrl: watch };
  },

  async run(ctx: ProviderCtx): Promise<ProviderOutcome> {
    const ref = refFromCtx(ctx);
    if (!ref) return runGeneric(ctx, { hopAllow: YOUTUBE_HOP_HOSTS });

    const siteName = ref.shorts ? 'YouTube Shorts' : 'YouTube';
    const canonicalUrl = youtubeWatchUrl(ref.id);
    const [oembed, thumb] = await Promise.all([fetchOembed(ctx, ref.id), pickThumbnail(ctx, ref.id)]);
    const imageCandidates = thumb ? [thumb] : [];

    if (oembed.kind === 'ok') {
      return ready(
        {
          title: oembed.title,
          description: null, // oEmbed 엔 없고 watch 페이지 설명은 1 MiB 읽기 값어치가 없다 (의도된 생략)
          author: oembed.author,
          siteName,
          canonicalUrl,
          imageCandidates,
        },
        'oembed',
      );
    }
    if (oembed.kind === 'gone') return unsupported('gone');

    // 네트워크 오류·5xx·401/403 → watch 페이지 og 로 한 번 더. 보일러플레이트 설명은 pickFields 가 이미 걸렀다.
    ctx.log('youtube.oembed_fallback', { reason: oembed.kind === 'denied' ? 'denied' : oembed.error });
    const page = await runGeneric(ctx, { url: canonicalUrl, hopAllow: YOUTUBE_HOP_HOSTS });
    if (page.kind !== 'ready') {
      return oembed.kind === 'denied' ? unsupported('private', emptyFields({ siteName, canonicalUrl })) : page;
    }
    if (!page.fields.title && oembed.kind === 'denied') {
      return unsupported('private', emptyFields({ siteName, canonicalUrl, imageCandidates }));
    }
    const merged: PreviewFields = {
      ...page.fields,
      siteName,
      canonicalUrl,
      imageCandidates: [...imageCandidates, ...page.fields.imageCandidates.filter((c) => c !== thumb)],
    };
    return ready(merged, 'og');
  },
};
