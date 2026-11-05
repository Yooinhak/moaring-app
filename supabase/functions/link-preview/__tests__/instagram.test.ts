// 실행: bun test supabase/functions/link-preview
// 고정 HTML 은 2026-11-04 프로브 본문(embed_DI3R5NfBWn__p_embedcaptioned · embed_DVnTUlzgrGe · embed_DHAfcsvMXwT(BrokenMedia) ·
// page_DI3R5NfBWn_ · threads/post_DXt5n9UlLl-) 에서 판정에 필요한 태그만 발췌·축약했다. 긴 CDN 서명은 잘랐지만 &amp;·oe= 꼴은 그대로다.
import { describe, expect, test } from 'bun:test';

import { canonicalize } from '../canonical.ts';
import {
  classifyInstagramUrl,
  extractInstagramShortcode,
  instagramAdapter,
  instagramEmbedUrl,
  instagramPostUrl,
  parseInstagramEmbed,
  parseInstagramEmbedRaw,
  parseInstagramPage,
  parseThreadsPostUrl,
  pickSrcsetVariant,
  threadsAdapter,
} from '../sites/instagram.ts';
import type { FetchTextResult, PreviewIO, ProviderCtx, ProviderOutcome, SiteAdapter } from '../types.ts';

// ---------------------------------------------------------------------------
// 가짜 io / ctx
// ---------------------------------------------------------------------------

type TextRoute = Partial<FetchTextResult> | (() => Partial<FetchTextResult>);

function makeIo(text: Record<string, TextRoute> = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const io: PreviewIO = {
    fetchText(url) {
      calls.push({ method: 'fetchText', url });
      const r = text[url];
      if (!r) return Promise.reject(new Error(`fake io: no route (fetchText) ${url}`));
      const p = typeof r === 'function' ? r() : r;
      return Promise.resolve({ status: 200, finalUrl: url, contentType: 'text/html', text: '', headers: {}, ...p });
    },
    fetchJson(url) {
      calls.push({ method: 'fetchJson', url });
      return Promise.reject(new Error(`fake io: no route (fetchJson) ${url}`));
    },
    head(url) {
      calls.push({ method: 'head', url });
      return Promise.reject(new Error(`fake io: no route (head) ${url}`));
    },
    resolveRedirects(url) {
      calls.push({ method: 'resolveRedirects', url });
      return Promise.reject(new Error(`fake io: no route (resolveRedirects) ${url}`));
    },
  };
  return { io, calls };
}

function makeCtx(adapter: SiteAdapter, postUrl: string, io: PreviewIO, extra: Partial<ProviderCtx> = {}): ProviderCtx {
  const u = new URL(postUrl);
  const c = adapter.canonicalize ? adapter.canonicalize(u) : canonicalize(u);
  return {
    postUrl,
    fetchUrl: c.fetchUrl,
    canonicalUrl: c.canonicalUrl,
    io,
    deadline: Date.now() + 25_000,
    log: () => {},
    hintTitle: null,
    attempts: 1,
    ...extra,
  };
}

function expectKind<K extends ProviderOutcome['kind']>(
  o: ProviderOutcome,
  kind: K,
): Extract<ProviderOutcome, { kind: K }> {
  if (o.kind !== kind) throw new Error(`expected ${kind}, got ${o.kind}${'error' in o ? ` (${o.error})` : ''}`);
  return o as Extract<ProviderOutcome, { kind: K }>;
}

// ---------------------------------------------------------------------------
// 고정 HTML
// ---------------------------------------------------------------------------

const CDN =
  'https://scontent-gmp1-1.cdninstagram.com/v/t51.75761-15/491467072_17956207457943435_3584634691123754100_n.jpg';
const SIG = '_nc_cat=109&amp;_nc_sid=58cdad&amp;oh=00_AQTtJ5BZ9RO8i7MbvysZyMVfAoN1ZkoZgKcIL7TGejHDZQ&amp;oe=6AF0CB4B';

const EMBED_IMG =
  `<a class="EmbeddedMedia" href="https://www.instagram.com/reel/DI3R5NfBWn_/?utm_source=ig_embed" target="_blank">` +
  `<img class="EmbeddedMediaImage" alt="Instagram post shared by &#064;jewvely_home" src="${CDN}?stp=dst-jpg_e15_tt6&amp;${SIG}" ` +
  `srcset="${CDN}?stp=dst-jpg_e15_tt6&amp;${SIG} 608w,${CDN}?stp=dst-jpg_e35_p480x480_tt6&amp;${SIG} 480w,${CDN}?stp=dst-jpg_e35_p320x320_tt6&amp;${SIG} 320w"></a>`;

const EMBED_CAPTION =
  `<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/jewvely_home/?utm_source=ig_embed&amp;ig_rid=AO_8vBNzFLLB9aTASG7cILW" ` +
  `data-log-event="captionProfileClick" target="_blank">jewvely_home</a><br /><br />옷에 자주 흘리는 칠칠이들 주목!!🙌🙌<br /><br />` +
  `밖에서 옷에 얼룩생기면 하루죙일 신경쓰이져..?<br />(사람들이 내가 점심에 뭐먹었는지 다 알아..)<br /><br />` +
  `프로필링크 &lt;53번&gt;에서도 확인 가능해요:)<br /><br />` +
  `<a href="/explore/tags/%EC%96%BC%EB%A3%A9%EC%A0%9C%EA%B1%B0%EC%A0%9C/?utm_source=ig_embed">#얼룩제거제</a> ` +
  `<a href="/explore/tags/%EA%BF%80%ED%85%9C%EC%B6%94%EC%B2%9C/?utm_source=ig_embed">#꿀템추천</a>` +
  `<div class="CaptionComments"><a class="CaptionCommentsExpand" href="https://www.instagram.com/reel/DI3R5NfBWn_/?utm_source=ig_embed">View all 12 comments</a></div></div>`;

function embedHtml(parts: { img?: string; caption?: string; username?: string }): string {
  return (
    `<!DOCTYPE html><html><head><title>Instagram</title></head><body class="x1 Locale_en_US" dir="ltr">` +
    `<div class="Embed" data-ios-link="media?id=3618439523895437823&amp;utm_source=ig_embed" ` +
    `data-permalink="https://www.instagram.com/reel/DI3R5NfBWn_/?utm_source=ig_embed&amp;ig_rid=AO_8vBNzFLLB9aTASG7cILW" ` +
    `data-log-event="bodyClick" data-media-type="GraphVideo" data-media-id="3618439523895437823" data-owner-id="58244231434">` +
    (parts.img ?? '') +
    `<div class="HeaderContainer"><a class="Avatar" href="https://www.instagram.com/jewvely_home/?utm_source=ig_embed">` +
    `<img class="Avatar InsideRing" src="https://scontent-gmp1-1.cdninstagram.com/v/t51.2885-19/avatar_n.jpg?oe=6AF0CB4B" alt=""></a>` +
    `<span class="UsernameText">${parts.username ?? 'jewvely_home'}</span></div>` +
    (parts.caption ?? '') +
    `</div></body></html>`
  );
}

const EMBED_LIVE = embedHtml({ img: EMBED_IMG, caption: EMBED_CAPTION });
const EMBED_NO_IMAGE = embedHtml({ caption: EMBED_CAPTION });

/** embed_DVnTUlzgrGe_p_embedcaptioned — srcset 최상위가 1080w(= src), 캡션에 &#039; */
const CDN2 =
  'https://scontent-gmp1-1.cdninstagram.com/v/t51.82787-15/649224316_17885489874456065_5503446460506152071_n.jpg';
const SIG2 = '_nc_cat=103&amp;_nc_sid=58cdad&amp;oh=00_AQSN8SXivYfNqCcQ96WifzhqgJWW7FwUvghRahJkfDvCDA&amp;oe=6AF0AB09';
const EMBED_DVN =
  `<!DOCTYPE html><html><body><div class="Embed" data-media-type="GraphVideo" data-media-id="3848129384477274526">` +
  `<img class="EmbeddedMediaImage" alt="Instagram post shared by &#064;modooit" src="${CDN2}?stp=dst-jpg_e15_tt6&amp;${SIG2}" ` +
  `srcset="${CDN2}?stp=dst-jpg_e15_tt6&amp;${SIG2} 1080w,${CDN2}?stp=dst-jpg_e35_p720x720_sh2.08_tt6&amp;${SIG2} 720w,` +
  `${CDN2}?stp=dst-jpg_e35_p640x640_sh0.08_tt6&amp;${SIG2} 640w,${CDN2}?stp=dst-jpg_e35_p480x480_tt6&amp;${SIG2} 480w">` +
  `<span class="UsernameText">modooit</span>` +
  `<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/modooit/?utm_source=ig_embed" target="_blank">modooit</a><br /><br />` +
  `☝️ 프로필사진을 누르면 &#039;제품구매링크&#039; 가 나옵니다 [241 회전헤어드라이기]<br />📌 댓글에 “구매” 남겨주시면 DM으로 바로 보내드릴게요<br /><br />` +
  `머리 말릴 때 드라이기 계속 들고 있기 힘들죠.<div class="CaptionComments"></div></div></div></body></html>`;

/** embed_DHAfcsvMXwT_p_embedcaptioned — HTTP 200 인데 깨진 글 */
const EMBED_BROKEN =
  `<!DOCTYPE html><html><head><title>Instagram</title></head><body class="x1 Locale_en_US" dir="ltr"><div class="_aa4c">` +
  `<div class="EmbedBrokenMedia"><div class="ebmLogo"><a class="EmbedLogo embedNonTextLink" data-has-android-intent="1" data-log-event="clickthru" ` +
  `href="https://www.instagram.com/p/DHAfcsvMXwT/?utm_source=ig_embed&amp;utm_campaign=invalid&amp;ig_rid=Ao6DsS6LPQgn90qZFRUmE2l" target="_blank">` +
  `<i class="Sprite elSprite embedLogoItemEnlarge embedHideText img sp_NKZ50SjU1-q sx_ec3884"><u>Instagram</u></i></a></div>` +
  `<div class="ebmMessage">The link to this photo or video may be broken, or the post may have been removed.</div>` +
  `<a class="EmbedVisitInstagram" href="https://www.instagram.com/p/DHAfcsvMXwT/?utm_source=ig_embed&amp;utm_campaign=invalid">View this post on Instagram</a>` +
  `</div></div></body></html>`;

/** page_DI3R5NfBWn_ — og:title·og:description 없음, twitter:title 은 엔티티 인코딩, <title> 은 'Instagram' */
const PAGE_LIVE =
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>Instagram</title>` +
  `<meta property="og:type" content="article" /><meta name="twitter:card" content="summary_large_image" />` +
  `<meta name="twitter:title" content="&#xc96c;&#xbe14;&#xb9ac;&#xd648; | &#xc9d1;&#xafb8;&#xbbf8;&#xae30;&#x2022;&#xc0b4;&#xb9bc;&#xd15c;&#x2022;&#xafc0;&#xd15c; (&#064;jewvely_home) &#x2022; Instagram reel" />` +
  `<meta property="og:site_name" content="Instagram" />` +
  `<meta property="og:image" content="${CDN}?stp=cmp1_dst-jpg_e35_s640x640_tt6&amp;_nc_cat=109&amp;ccb=7-5&amp;_nc_sid=18de74&amp;oe=6AF0CB4B" />` +
  `<meta name="twitter:image" content="${CDN}?stp=cmp1_dst-jpg_e35_s640x640_tt6&amp;_nc_cat=109&amp;ccb=7-5&amp;_nc_sid=18de74&amp;oe=6AF0CB4B" />` +
  `<meta property="og:url" content="https://www.instagram.com/jewvely_home/reel/DI3R5NfBWn_/" />` +
  `</head><body><div id="splash-screen"></div></body></html>`;

/** threads/post_DXt5n9UlLl- — og:image 는 아바타(t51.82787-19) */
const THREADS_PAGE =
  `<!DOCTYPE html><html><head><title>Mark Zuckerberg (@zuck) on Threads</title>` +
  `<meta property="og:site_name" content="Threads" />` +
  `<meta property="og:title" content="Mark Zuckerberg (&#064;zuck) on Threads" />` +
  `<meta property="og:description" content="As part of our philanthropic work to help cure all diseases, our team &#064;biohub is announcing the Virtual Biology Initiative -- a new effort to build the imaging tools, molecular tools, and open data infrastructure needed to build AI models that can reason about cells." />` +
  `<meta property="og:url" content="https://www.threads.com/&#064;zuck/post/DXt5n9UlLl-" />` +
  `<meta property="og:image" content="https://scontent-gmp1-1.cdninstagram.com/v/t51.82787-19/825322135_17989325280103224_1252773933700107438_n.jpg?_nc_cat=107&amp;oe=6AF0A6EB" />` +
  `<meta property="og:type" content="article" /><meta name="twitter:title" content="Mark Zuckerberg (&#064;zuck) on Threads" />` +
  `</head><body></body></html>`;

const CODE = 'DI3R5NfBWn_';
const EMBED_URL = instagramEmbedUrl(CODE);
const POST_URL = instagramPostUrl(CODE);

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

describe('Instagram URL', () => {
  test('shortcode: /p /reel /reels /tv · og:url 의 /<user>/reel/ 폼 · instagr.am', () => {
    const code = (href: string) => extractInstagramShortcode(new URL(href));
    expect(code('https://www.instagram.com/reel/DI3R5NfBWn_/?igsh=MTNrdmlqbmNtazRp')).toBe('DI3R5NfBWn_');
    expect(code('https://www.instagram.com/p/DHAfcsvMXwT/?igsh=MTdxM2R4aGt2dTg2dA==')).toBe('DHAfcsvMXwT');
    expect(code('https://instagram.com/reels/DJJGpFByXk5')).toBe('DJJGpFByXk5');
    expect(code('https://www.instagram.com/tv/CAbcdefGHIJ/')).toBe('CAbcdefGHIJ');
    expect(code('https://www.instagram.com/jewvely_home/reel/DI3R5NfBWn_/')).toBe('DI3R5NfBWn_');
    expect(code('https://instagr.am/p/DVnTUlzgrGe/')).toBe('DVnTUlzgrGe');
    expect(code('https://www.instagram.com/p/DI3R5NfBWn_/embed/captioned/')).toBe('DI3R5NfBWn_');
  });

  test('프로필·탐색·가짜 호스트는 null → generic', () => {
    const code = (href: string) => extractInstagramShortcode(new URL(href));
    expect(code('https://www.instagram.com/cozymohae_campingtip/')).toBe(null);
    expect(code('https://www.instagram.com/explore/tags/abc/')).toBe(null);
    expect(code('https://www.instagram.com.evil.com/p/DI3R5NfBWn_/')).toBe(null);
    expect(code('https://evil.com/p/DI3R5NfBWn_/')).toBe(null);
    expect(code('https://www.instagram.com/p/abc/')).toBe(null); // 5자 미만
    expect(instagramAdapter.match(new URL('https://www.instagram.com/jewvely_home/'))).toBe(false);
  });

  test('/reels/audio/<id>/ 의 "audio" 는 shortcode 가 아니다 → null·match false·classify other (generic 으로)', () => {
    const href = 'https://www.instagram.com/reels/audio/1234567890123/';
    expect(extractInstagramShortcode(new URL(href))).toBe(null);
    expect(instagramAdapter.match(new URL(href))).toBe(false);
    expect(classifyInstagramUrl(href)).toBe('other');
    expect(instagramAdapter.canonicalize!(new URL(href)).canonicalUrl).toBe(href); // /p/audio/ 로 묶이지 않는다
    expect(extractInstagramShortcode(new URL('https://www.instagram.com/reel/explore/'))).toBe(null);
  });

  test('canonicalize: igsh 제거, fetchUrl 은 /p/<code>/embed/captioned/, canonical 은 /p/<code>/', () => {
    const c = instagramAdapter.canonicalize!(
      new URL('https://www.instagram.com/reel/DI3R5NfBWn_/?igsh=MTNrdmlqbmNtazRp&utm_source=ig_web'),
    );
    expect(c.fetchUrl).toBe(EMBED_URL);
    expect(c.canonicalUrl).toBe(POST_URL);
  });

  test('classifyInstagramUrl: 게시물·프로필·로그인', () => {
    expect(classifyInstagramUrl(EMBED_URL)).toBe('post');
    expect(classifyInstagramUrl('https://www.instagram.com/cozymohae_campingtip/')).toBe('profile');
    expect(classifyInstagramUrl('https://www.instagram.com/accounts/login/?next=%2Fp%2FX%2F')).toBe('login');
  });
});

// ---------------------------------------------------------------------------
// 임베드 파서
// ---------------------------------------------------------------------------

describe('parseInstagramEmbedRaw', () => {
  test('실제 임베드(DI3R5NfBWn_): 작성자·미디어 타입·이미지(&amp; 디코드)·캡션(CaptionUsername 제거, <br> 줄바꿈, 해시태그 텍스트)', () => {
    const raw = parseInstagramEmbedRaw(EMBED_LIVE);
    expect(raw.broken).toBe(false);
    expect(raw.username).toBe('jewvely_home');
    expect(raw.mediaType).toBe('GraphVideo');
    // 608w 변형 == src 라 후보는 하나, 값은 엔티티가 풀린 서명 URL 그대로
    expect(raw.imageCandidates).toHaveLength(1);
    expect(raw.imageCandidates[0]).toBe(`${CDN}?stp=dst-jpg_e15_tt6&${SIG.replace(/&amp;/g, '&')}`);
    expect(raw.imageCandidates[0].includes('&amp;')).toBe(false);
    expect(raw.caption?.startsWith('옷에 자주 흘리는 칠칠이들 주목!!🙌🙌')).toBe(true);
    expect(raw.caption?.startsWith('jewvely_home')).toBe(false);
    expect(raw.caption?.includes('프로필링크 <53번>에서도')).toBe(true);
    expect(raw.caption?.includes('#얼룩제거제 #꿀템추천')).toBe(true);
    expect(raw.caption?.includes('View all 12 comments')).toBe(false);
  });

  test('DVnTUlzgrGe: srcset 1080w 위에서 ≤640w 변형을 먼저, 원본 src 는 두 번째. &#039; 디코드', () => {
    const raw = parseInstagramEmbedRaw(EMBED_DVN);
    expect(raw.username).toBe('modooit');
    expect(raw.imageCandidates).toHaveLength(2);
    expect(raw.imageCandidates[0].includes('p640x640')).toBe(true);
    expect(raw.imageCandidates[1].includes('stp=dst-jpg_e15_tt6&_nc_cat=103')).toBe(true);
    expect(raw.caption?.startsWith("☝️ 프로필사진을 누르면 '제품구매링크' 가 나옵니다 [241 회전헤어드라이기]")).toBe(
      true,
    );
  });

  test('pickSrcsetVariant: 쉼표 뒤 공백 없는 포맷, URL 안의 숫자+w 에 속지 않음', () => {
    const ss = 'https://a.com/x.jpg?k=8w1 1206w,https://a.com/y.jpg?v=7w 640w,https://a.com/z.jpg 480w';
    expect(pickSrcsetVariant(ss)).toBe('https://a.com/y.jpg?v=7w');
    expect(pickSrcsetVariant(ss, 500)).toBe('https://a.com/z.jpg');
    expect(pickSrcsetVariant('https://a.com/big.jpg 1080w')).toBe(null);
  });

  test('EmbedBrokenMedia(HTTP 200) → broken, 필드 없음', () => {
    const raw = parseInstagramEmbedRaw(EMBED_BROKEN);
    expect(raw.broken).toBe(true);
    expect(raw.username).toBe(null);
    expect(raw.imageCandidates).toHaveLength(0);
    expect(parseInstagramEmbed(EMBED_BROKEN)).toBe(null);
  });
});

describe('parseInstagramEmbed (필드)', () => {
  test('제목 = 캡션 첫 줄, 설명은 기본 null, storeCaption 이면 전체 캡션. author 는 @user, siteName Instagram', () => {
    const f = parseInstagramEmbed(EMBED_LIVE)!;
    expect(f.title).toBe('옷에 자주 흘리는 칠칠이들 주목!!🙌🙌');
    expect(f.description).toBe(null);
    expect(f.author).toBe('@jewvely_home');
    expect(f.siteName).toBe('Instagram');
    expect(f.imageCandidates).toHaveLength(1);

    const full = parseInstagramEmbed(EMBED_LIVE, { storeCaption: true })!;
    expect(full.description?.startsWith('옷에 자주 흘리는 칠칠이들 주목!!🙌🙌\n밖에서 옷에')).toBe(true);
  });

  test('캡션 없으면 제목은 "@user • Instagram", 첫 줄이 길면 80자에서 … 로 끝', () => {
    const noCaption = parseInstagramEmbed(embedHtml({ img: EMBED_IMG }))!;
    expect(noCaption.title).toBe('@jewvely_home • Instagram');

    const longLine = '가'.repeat(120);
    const long = parseInstagramEmbed(
      embedHtml({
        img: EMBED_IMG,
        caption: `<div class="Caption">${longLine}<br />둘째 줄<div class="CaptionComments"></div></div>`,
      }),
    )!;
    expect(Array.from(long.title!)).toHaveLength(80);
    expect(long.title!.endsWith('…')).toBe(true);
  });

  test('아무것도 없는 HTML → null', () => {
    expect(parseInstagramEmbed('<html><body>nothing</body></html>')).toBe(null);
  });
});

describe('parseInstagramPage (폴백)', () => {
  test('twitter:title 엔티티 디코드 → " • Instagram reel" 접미 제거 → author, og:url 의 /<user>/ → 제목, og:image 후보', () => {
    const f = parseInstagramPage(PAGE_LIVE, POST_URL)!;
    expect(f.author).toBe('쥬블리홈 | 집꾸미기•살림템•꿀템 (@jewvely_home)');
    expect(f.title).toBe('@jewvely_home • Instagram');
    expect(f.description).toBe(null);
    expect(f.imageCandidates).toHaveLength(1);
    expect(f.imageCandidates[0].includes('_nc_sid=18de74&oe=6AF0CB4B')).toBe(true);
  });

  test('프로필 페이지(og 0개, <title> Instagram) → null', () => {
    expect(
      parseInstagramPage(
        '<html><head><title>Instagram</title></head><body></body></html>',
        'https://www.instagram.com/x/',
      ),
    ).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 어댑터 흐름 (가짜 io)
// ---------------------------------------------------------------------------

describe('instagramAdapter.run', () => {
  test('임베드 1회로 ready(source embed) — 이미지 후보는 임베드 응답에서 바로, canonical 은 /p/<code>/, 페이지는 안 읽는다', async () => {
    const { io, calls } = makeIo({ [EMBED_URL]: { text: EMBED_LIVE } });
    const ctx = makeCtx(instagramAdapter, 'https://www.instagram.com/reel/DI3R5NfBWn_/?igsh=MTNrdmlqbmNtazRp', io, {
      hintTitle: '공유 텍스트 힌트',
    });
    const out = expectKind(await instagramAdapter.run(ctx), 'ready');
    expect(out.source).toBe('embed');
    expect(out.fields.title).toBe('옷에 자주 흘리는 칠칠이들 주목!!🙌🙌'); // 캡션이 있으면 힌트보다 캡션
    expect(out.fields.author).toBe('@jewvely_home');
    expect(out.fields.siteName).toBe('Instagram');
    expect(out.fields.canonicalUrl).toBe(POST_URL);
    expect(out.fields.imageCandidates[0].startsWith(CDN)).toBe(true);
    expect(calls).toEqual([{ method: 'fetchText', url: EMBED_URL }]);
  });

  test('캡션 없는 임베드는 공유 텍스트 힌트를 제목으로', async () => {
    const { io } = makeIo({ [EMBED_URL]: { text: embedHtml({ img: EMBED_IMG }) } });
    const out = expectKind(
      await instagramAdapter.run(makeCtx(instagramAdapter, POST_URL, io, { hintTitle: '힌트 제목' })),
      'ready',
    );
    expect(out.fields.title).toBe('힌트 제목');
  });

  test('EmbedBrokenMedia → unsupported(gone), 페이지 폴백 없이 끝', async () => {
    const { io, calls } = makeIo({ [instagramEmbedUrl('DHAfcsvMXwT')]: { text: EMBED_BROKEN } });
    const out = expectKind(
      await instagramAdapter.run(makeCtx(instagramAdapter, 'https://www.instagram.com/p/DHAfcsvMXwT/', io)),
      'unsupported',
    );
    expect(out.error).toBe('gone');
    expect(calls).toHaveLength(1);
  });

  test('임베드에 EmbeddedMediaImage 없음 → 게시물 페이지 og 폴백(ready og): 임베드 캡션 제목 + 페이지 author·이미지', async () => {
    const { io, calls } = makeIo({ [EMBED_URL]: { text: EMBED_NO_IMAGE }, [POST_URL]: { text: PAGE_LIVE } });
    const out = expectKind(await instagramAdapter.run(makeCtx(instagramAdapter, POST_URL, io)), 'ready');
    expect(out.source).toBe('og');
    expect(out.fields.title).toBe('옷에 자주 흘리는 칠칠이들 주목!!🙌🙌');
    expect(out.fields.author).toBe('쥬블리홈 | 집꾸미기•살림템•꿀템 (@jewvely_home)');
    expect(out.fields.imageCandidates).toHaveLength(1);
    expect(out.fields.canonicalUrl).toBe(POST_URL);
    expect(calls.map((c) => c.url)).toEqual([EMBED_URL, POST_URL]);
  });

  test('페이지가 302 → /<user>/ 프로필로 끝나면 unsupported(gone)', async () => {
    const { io } = makeIo({
      [EMBED_URL]: { text: EMBED_NO_IMAGE },
      [POST_URL]: {
        finalUrl: 'https://www.instagram.com/cozymohae_campingtip/',
        text: '<html><head><title>Instagram</title></head></html>',
      },
    });
    const out = expectKind(await instagramAdapter.run(makeCtx(instagramAdapter, POST_URL, io)), 'unsupported');
    expect(out.error).toBe('gone');
  });

  test('임베드 429 + 페이지 로그인 리다이렉트 → needs_client(parser instagram_embed, url = 임베드 URL)', async () => {
    const { io } = makeIo({
      [EMBED_URL]: { status: 429, text: '' },
      [POST_URL]: {
        finalUrl: 'https://www.instagram.com/accounts/login/?next=%2Fp%2FDI3R5NfBWn_%2F',
        text: '<html></html>',
      },
    });
    const out = expectKind(await instagramAdapter.run(makeCtx(instagramAdapter, POST_URL, io)), 'needs_client');
    expect(out.task).toEqual({ runner: 'fetch', parser: 'instagram_embed', url: EMBED_URL });
    expect(out.fields?.canonicalUrl).toBe(POST_URL);
    expect(out.fields?.siteName).toBe('Instagram');
  });

  test('임베드·페이지 둘 다 네트워크 오류 → failed(재시도 대상)', async () => {
    const { io } = makeIo();
    const out = expectKind(await instagramAdapter.run(makeCtx(instagramAdapter, POST_URL, io)), 'failed');
    expect(out.error).toBe('fetch_failed');
  });

  test('parseSubmitted: 임베드 HTML 은 임베드 규칙, 깨진 글은 null', () => {
    expect(instagramAdapter.parseSubmitted!(EMBED_LIVE, EMBED_URL)?.author).toBe('@jewvely_home');
    expect(instagramAdapter.parseSubmitted!(EMBED_BROKEN, EMBED_URL)).toBe(null);
    expect(instagramAdapter.parseSubmitted!(PAGE_LIVE, POST_URL)?.author?.endsWith('(@jewvely_home)')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

describe('threadsAdapter', () => {
  test('URL: /@handle/post/<code> 만, threads.net → threads.com canonical, 프로필은 generic', () => {
    expect(parseThreadsPostUrl(new URL('https://www.threads.net/@zuck/post/DXt5n9UlLl-'))).toEqual({
      handle: 'zuck',
      code: 'DXt5n9UlLl-',
    });
    expect(parseThreadsPostUrl(new URL('https://www.threads.com/@zuck'))).toBe(null);
    expect(threadsAdapter.match(new URL('https://threads.com/t/DXt5n9UlLl-'))).toBe(true);
    const c = threadsAdapter.canonicalize!(new URL('https://www.threads.net/@zuck/post/DXt5n9UlLl-?xmt=abc'));
    expect(c.canonicalUrl).toBe('https://www.threads.com/@zuck/post/DXt5n9UlLl-');
  });

  test('og 재매핑: og:title → author, og:description → 제목 첫 줄(≤80)+설명, 아바타 이미지 제외, siteName Threads', async () => {
    const url = 'https://www.threads.com/@zuck/post/DXt5n9UlLl-';
    const { io } = makeIo({ [url]: { text: THREADS_PAGE } });
    const out = expectKind(
      await threadsAdapter.run(makeCtx(threadsAdapter, 'https://www.threads.net/@zuck/post/DXt5n9UlLl-', io)),
      'ready',
    );
    expect(out.source).toBe('og');
    expect(out.fields.author).toBe('Mark Zuckerberg (@zuck)');
    expect(
      out.fields.title?.startsWith('As part of our philanthropic work to help cure all diseases, our team @biohub'),
    ).toBe(true);
    expect(out.fields.title!.endsWith('…')).toBe(true);
    expect(Array.from(out.fields.title!)).toHaveLength(80);
    expect(out.fields.description?.endsWith('reason about cells.')).toBe(true);
    expect(out.fields.imageCandidates).toHaveLength(0);
    expect(out.fields.siteName).toBe('Threads');
    expect(out.fields.canonicalUrl).toBe(url);
  });

  test('본문 og 가 없으면 needs_client(폰이 게시물 페이지 재시도)', async () => {
    const url = 'https://www.threads.com/@zuck/post/DXt5n9UlLl-';
    const { io } = makeIo({
      [url]: {
        text: '<html><head><title>Threads</title><meta property="og:site_name" content="Threads" /></head><body><noscript></noscript></body></html>',
      },
    });
    const out = expectKind(await threadsAdapter.run(makeCtx(threadsAdapter, url, io)), 'needs_client');
    expect(out.task.parser).toBe('generic');
    expect(out.task.url).toBe(url);
  });
});
