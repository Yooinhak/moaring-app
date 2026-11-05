// 어댑터 레지스트리 — URL → SiteAdapter, 폰 제출 HTML → 파서
//
// 순서가 곧 우선순위다. 앞의 어댑터가 match 하면 뒤는 보지 않으므로 호스트가 좁은 것(쿠팡·네이버·인스타 …) 을 앞에,
// `match: () => true` 인 generic 을 반드시 마지막에 둔다. 같은 사이트군 안의 순서는 호스트가 서로 겹치지 않아 의미가 없다.
// 새 사이트를 붙일 때는 sites/<site>.ts 에 어댑터를 만들고 여기 한 줄만 추가한다 — index.ts/process.ts 는 건드리지 않는다.
//
// 이 파일은 Deno 전역·URL import 가 없어 bun 테스트에서 그대로 import 된다 (__tests__/process.test.ts).

import type { ClientParser, PreviewFields, SiteAdapter } from '../types.ts';
import { coupangAdapters } from './coupang.ts';
import { genericAdapter, parseGenericSubmitted } from './generic.ts';
import { instagramAdapters, parseInstagramEmbed } from './instagram.ts';
import { kakaoAdapters } from './kakao.ts';
import {
  blockedSitesAdapter,
  facebookAdapter,
  linkedinAdapter,
  oembedRegistryAdapter,
  pinterestAdapter,
  redditAdapter,
  slugAdapter,
} from './misc.ts';
import { naverAdapters } from './naver.ts';
import { parseTikTokSsr, tiktokAdapter } from './tiktok.ts';
import { xAdapter } from './x.ts';
import { youtubeAdapter } from './youtube.ts';

/**
 * 설계 §6 의 전략 표 순서. generic 이 마지막이어야 한다는 것만 지키면 된다.
 *   coupang(link.·www./m.) → naver 6종 → instagram·threads → youtube → x → tiktok → kakao 9종(place·kko·brunch·tistory·velog·
 *   daum cafe·ohou·kurly·daangn) → 무신사/29CM(blocked) → medium/notion(slug) → reddit → pinterest → facebook → linkedin →
 *   vimeo/spotify/soundcloud/flickr(oembed) → generic
 */
export const ADAPTERS: readonly SiteAdapter[] = [
  ...coupangAdapters,
  ...naverAdapters,
  ...instagramAdapters,
  youtubeAdapter,
  xAdapter,
  tiktokAdapter,
  ...kakaoAdapters,
  blockedSitesAdapter,
  slugAdapter,
  redditAdapter,
  pinterestAdapter,
  facebookAdapter,
  linkedinAdapter,
  oembedRegistryAdapter,
  genericAdapter,
];

/** 첫 match 어댑터. generic 이 모든 URL 을 받으므로 null 이 되는 일은 없다. match 가 던지면(이상한 URL) generic 으로. */
export function resolveAdapter(u: URL): SiteAdapter {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.match(u)) return adapter;
    } catch {
      // match 가 URL 파싱 등으로 던지는 경우 — 그 어댑터만 건너뛴다
    }
  }
  return genericAdapter;
}

/** 폰이 제출한 HTML 을 해석할 때 넘기는 옵션. storeCaption 은 env INSTAGRAM_STORE_CAPTION=full (index.ts 가 읽어 넘긴다). */
export interface SubmittedParseOptions {
  storeCaption?: boolean;
}

export type SubmittedParser = (html: string, finalUrl: string, opts?: SubmittedParseOptions) => PreviewFields | null;

/**
 * ClientTask.parser 키 → 서버 파서. 폰은 받은 HTML 을 그대로 보내고(폰 IP 가 핵심 가치) 해석 규칙은 서버 하나만 둔다.
 *   generic         : og/twitter/<title> (sites/generic.ts)
 *   instagram_embed : /p/<code>/embed/captioned/ 마크업 (sites/instagram.ts) — 캡션 전체 저장은 storeCaption 일 때만
 *   tiktok_ssr      : __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON (sites/tiktok.ts) — statusCode≠0·shape 불일치는 null
 */
export const PARSERS: Readonly<Record<ClientParser, SubmittedParser>> = {
  generic: (html, finalUrl) => parseGenericSubmitted(html, finalUrl),
  instagram_embed: (html, _finalUrl, opts) => parseInstagramEmbed(html, { storeCaption: opts?.storeCaption ?? false }),
  tiktok_ssr: (html) => {
    const r = parseTikTokSsr(html);
    return r.kind === 'ok' ? r.fields : null;
  },
};

/**
 * assist 에서 폰 HTML 을 해석한다: 어댑터 자체 parseSubmitted 가 있으면 그것(인스타는 임베드·게시물 페이지 둘 다 처리,
 * 네이버·카카오는 자기 remap 적용), 없으면 generic. 어떤 파서도 예외를 밖으로 내지 않는다 — 폰 HTML 은 신뢰할 수 없는 입력이다.
 */
export function parseSubmittedHtml(
  adapter: SiteAdapter,
  html: string,
  finalUrl: string,
  opts: SubmittedParseOptions = {},
): PreviewFields | null {
  try {
    if (adapter.parseSubmitted) return adapter.parseSubmitted(html, finalUrl);
    return PARSERS.generic(html, finalUrl, opts);
  } catch {
    return null;
  }
}
