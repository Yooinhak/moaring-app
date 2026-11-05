// 실행: bun test supabase/functions/link-preview
// 고정 HTML/JSON 은 2026-11-04 프로브(page_xcom_jack20.html, page_xcom_obama.html, page_xcom_badid.html, oembed_*.json,
// tco_nofollow.headers) 에서 판정에 필요한 태그만 발췌. 네트워크는 전부 가짜 io.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { matchesHost } from '../canonical.ts';
import type {
  FetchJsonResult,
  FetchTextResult,
  HeadResult,
  PreviewIO,
  ProviderCtx,
  ResolveRedirectsOptions,
  ResolveRedirectsResult,
} from '../types.ts';
import {
  X_HOP_HOSTS,
  parseXOembed,
  parseXStatusHtml,
  parseXUrl,
  tweetTextFromOembedHtml,
  xAdapter,
  xOembedUrl,
  xSmallJpegUrl,
} from '../sites/x.ts';

// ---------------------------------------------------------------------------
// 가짜 io
// ---------------------------------------------------------------------------

interface Call {
  method: keyof PreviewIO;
  url: string;
  opts: unknown;
}

/** 시작 URL 의 응답 체인 — locations[k] 는 k번째 응답의 Location. 비면 리다이렉트가 아니었고 status 가 그 응답 코드. */
interface RedirectChain {
  locations: string[];
  status?: number;
}

interface FakeHandlers {
  text?: (url: string) => FetchTextResult | Promise<FetchTextResult>;
  json?: (url: string) => FetchJsonResult | Promise<FetchJsonResult>;
  head?: (url: string) => HeadResult | Promise<HeadResult>;
  /** Error 면 그대로 던진다 (홉 0 의 SSRF 거부 등). */
  redirects?: Record<string, RedirectChain | Error>;
}

/**
 * fetch.ts requestWithRedirects 의 규칙을 그대로 흉내 낸다: 홉 ≥1 이 hopAllow 밖이면 ssrf:hop_host 를 던지고(어댑터는 Location 을
 * 못 본다), firstHopOnly 면 첫 Location 을 검사 없이 돌려주며 따라가지 않는다. 가짜 io 가 "외부 URL 을 final 로 돌려주는" 식이면
 * 진짜 io 로는 불가능한 경로가 통과한다 — t.co → 외부 기사가 영구 실패하던 버그가 그렇게 숨었다.
 */
export function followChain(url: string, chain: RedirectChain, opts: ResolveRedirectsOptions): ResolveRedirectsResult {
  const hops: string[] = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    const host = new URL(current).hostname;
    if (hop >= 1 && opts.hopAllow && opts.hopAllow.length > 0 && !matchesHost(host, opts.hopAllow)) {
      throw Object.assign(new Error(`ssrf:hop_host (${host})`), { code: 'ssrf:hop_host' });
    }
    const next = chain.locations[hop];
    if (!next) return { hops, final: current, firstLocation: chain.locations[0], status: chain.status ?? 200 };
    if (opts.firstHopOnly) return { hops, final: current, firstLocation: next, status: 301 };
    if (hop >= opts.maxHops) throw Object.assign(new Error('too_many_redirects'), { code: 'too_many_redirects' });
    hops.push(current);
    current = next;
  }
}

function fakeIo(h: FakeHandlers): { io: PreviewIO; calls: Call[] } {
  const calls: Call[] = [];
  const unexpected = (method: string, url: string) => new Error(`unexpected io.${method} ${url}`);
  const io: PreviewIO = {
    async fetchText(url, opts) {
      calls.push({ method: 'fetchText', url, opts });
      if (!h.text) throw unexpected('fetchText', url);
      return h.text(url);
    },
    async fetchJson(url, opts) {
      calls.push({ method: 'fetchJson', url, opts });
      if (!h.json) throw unexpected('fetchJson', url);
      return h.json(url);
    },
    async head(url, opts) {
      calls.push({ method: 'head', url, opts });
      if (!h.head) throw unexpected('head', url);
      return h.head(url);
    },
    async resolveRedirects(url, opts) {
      calls.push({ method: 'resolveRedirects', url, opts });
      const chain = h.redirects?.[url];
      if (!chain) throw unexpected('resolveRedirects', url);
      if (chain instanceof Error) throw chain;
      return followChain(url, chain, opts);
    },
  };
  return { io, calls };
}

function makeCtx(postUrl: string, io: PreviewIO, extra: Partial<ProviderCtx> = {}): ProviderCtx {
  const canon = xAdapter.canonicalize ? xAdapter.canonicalize(new URL(postUrl)) : null;
  return {
    postUrl,
    fetchUrl: canon?.fetchUrl ?? postUrl,
    canonicalUrl: canon?.canonicalUrl ?? postUrl,
    io,
    deadline: Date.now() + 25_000,
    log: () => {},
    hintTitle: null,
    attempts: 1,
    ...extra,
  };
}

const page = (
  status: number,
  text: string,
  finalUrl: string,
  headers: Record<string, string> = {},
): FetchTextResult => ({
  status,
  finalUrl,
  contentType: 'text/html',
  text,
  headers: { server: 'cloudflare envoy', ...headers },
});

const json = (status: number, body: unknown, contentType = 'application/json'): FetchJsonResult => ({
  status,
  finalUrl: 'https://publish.x.com/oembed',
  contentType,
  json: body,
  headers: {},
});

// ---------------------------------------------------------------------------
// 고정값 (프로브 발췌)
// ---------------------------------------------------------------------------

// page_xcom_jack20.html — 텍스트 글: twitter:card=summary, og:image 는 작성자 아바타
const JACK_HTML = `<!DOCTYPE html><html><head>
<meta property="og:site_name" content="X (formerly Twitter)"/>
<meta property="og:url" content="https://x.com/jack/status/20"/>
<meta property="og:type" content="article"/>
<meta property="og:title" content="jack (@jack) on X"/>
<meta name="twitter:title" content="jack (@jack) on X"/>
<meta property="og:description" content="just setting up my twttr"/>
<meta property="og:image" content="https://pbs.twimg.com/profile_images/1661201415899951105/azNjKOSH_400x400.jpg"/>
<meta property="og:image:secure_url" content="https://pbs.twimg.com/profile_images/1661201415899951105/azNjKOSH_400x400.jpg"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:creator" content="@jack"/>
<meta name="twitter:image" content="https://pbs.twimg.com/profile_images/1661201415899951105/azNjKOSH_400x400.jpg"/>
<title>jack on X: &quot;just setting up my twttr&quot; / X</title>
</head><body></body></html>`;

// page_xcom_obama.html — 사진 글: twitter:card=summary_large_image, og:image 는 첨부 사진(&amp; 인코딩)
const OBAMA_HTML = `<!DOCTYPE html><html><head>
<meta property="og:site_name" content="X (formerly Twitter)"/>
<meta property="og:url" content="https://x.com/BarackObama/status/266031293945503744"/>
<meta property="og:title" content="Barack Obama (@BarackObama) on X"/>
<meta property="og:description" content="Four more years."/>
<meta property="og:image" content="https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=webp&amp;name=large"/>
<meta property="og:image:secure_url" content="https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=webp&amp;name=large"/>
<meta property="og:image:type" content="image/webp"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:creator" content="@BarackObama"/>
<link rel="apple-touch-icon" href="https://x.com/apple-touch-icon.png">
<title>Barack Obama on X: &quot;Four more years.&quot; / X</title>
</head><body></body></html>`;

// page_xcom_badid.html — HTTP 404 인데 og 가 들어 있다
const NOT_FOUND_HTML = `<!DOCTYPE html><html><head>
<meta property="og:site_name" content="X (formerly Twitter)"/>
<meta property="og:image" content="https://abs.twimg.com/x-web/assets/og/default-og.a2e144f0cf66.jpg"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="Post Not Found - X | 404 Error"/>
<meta property="og:description" content="The post you&#x27;re looking for could not be found or may have been deleted."/>
<meta name="twitter:card" content="summary"/>
<title>Post Not Found - X | 404 Error</title>
</head><body></body></html>`;

// 데이터센터 IP 에서 올 수 있는 JS 셸 (og 없음)
const SHELL_HTML = `<!DOCTYPE html><html><head><title>X</title><meta name="viewport" content="width=device-width"></head>
<body><noscript>JavaScript is not available.</noscript><div id="react-root"></div></body></html>`;

// oembed_pubx_xcom_jack20.json / oembed_pubtwitter_xcom_obama.json
const OEMBED_JACK = {
  url: 'https://x.com/jack/status/20',
  author_name: 'jack',
  author_url: 'https://x.com/jack',
  html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://x.com/jack/status/20?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>\n\n',
  width: 550,
  height: null,
  type: 'rich',
  provider_name: 'X',
  version: '1.0',
};

const OEMBED_OBAMA = {
  url: 'https://x.com/BarackObama/status/266031293945503744',
  author_name: 'Barack Obama',
  author_url: 'https://x.com/BarackObama',
  html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Four more years. <a href="http://t.co/bAJE6Vom">pic.twitter.com/bAJE6Vom</a></p>&mdash; Barack Obama (@BarackObama) <a href="https://x.com/BarackObama/status/266031293945503744?ref_src=twsrc%5Etfw">November 7, 2012</a></blockquote>\n\n',
  type: 'rich',
  provider_name: 'X',
};

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error('adapter must not call fetch() directly');
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// URL 해석
// ---------------------------------------------------------------------------

describe('parseXUrl', () => {
  const p = (href: string) => parseXUrl(new URL(href));

  test('3가지 status 폼 + photo/video 접미·추적 쿼리 무시', () => {
    expect(p('https://x.com/jack/status/20')).toEqual({ kind: 'status', id: '20', handle: 'jack' });
    expect(p('https://twitter.com/BarackObama/status/266031293945503744/photo/1')).toEqual({
      kind: 'status',
      id: '266031293945503744',
      handle: 'BarackObama',
    });
    expect(p('https://x.com/jack/status/20/video/1?s=20&t=AbCdEfGh123')).toEqual({
      kind: 'status',
      id: '20',
      handle: 'jack',
    });
    expect(p('https://x.com/i/status/20')).toEqual({ kind: 'status', id: '20', handle: null });
    expect(p('https://x.com/i/web/status/20')).toEqual({ kind: 'status', id: '20', handle: null });
    expect(p('https://mobile.twitter.com/jack/status/20')).toEqual({ kind: 'status', id: '20', handle: 'jack' });
    expect(p('https://www.x.com/jack/statuses/20')).toEqual({ kind: 'status', id: '20', handle: 'jack' });
  });

  test('프로필·예약 경로·t.co', () => {
    expect(p('https://x.com/jack')).toEqual({ kind: 'profile', handle: 'jack' });
    expect(p('https://x.com/home')).toEqual({ kind: 'other' });
    expect(p('https://x.com/i/lists/123')).toEqual({ kind: 'other' });
    expect(p('https://x.com/jack/status/notanumber')).toEqual({ kind: 'other' });
    expect(p('https://t.co/bAJE6Vom')).toEqual({ kind: 'tco' });
  });

  test('호스트 허용목록 밖은 null', () => {
    expect(p('https://evil.com/jack/status/20')).toBe(null);
    expect(p('https://www.x.com.evil.com/jack/status/20')).toBe(null);
    expect(p('https://xcom/jack/status/20')).toBe(null);
  });

  test('canonicalize: x.com 으로 통일, 사용자명 없으면 /i/status/', () => {
    const c = (href: string) => xAdapter.canonicalize!(new URL(href)).canonicalUrl;
    expect(c('https://twitter.com/jack/status/20?s=20&t=AbCd')).toBe('https://x.com/jack/status/20');
    expect(c('https://x.com/BarackObama/status/266031293945503744/photo/1')).toBe(
      'https://x.com/BarackObama/status/266031293945503744',
    );
    expect(c('https://x.com/i/web/status/20')).toBe('https://x.com/i/status/20');
    expect(c('https://mobile.twitter.com/jack')).toBe('https://x.com/jack');
    expect(c('https://t.co/bAJE6Vom?utm_source=x')).toBe('https://t.co/bAJE6Vom');
  });

  test('xSmallJpegUrl: 미디어 두 폼 모두 ?format=jpg&name=small, 다른 호스트는 그대로', () => {
    expect(xSmallJpegUrl('https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=webp&name=large')).toBe(
      'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=jpg&name=small',
    );
    expect(xSmallJpegUrl('https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg')).toBe(
      'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=jpg&name=small',
    );
    expect(xSmallJpegUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/abc.jpg')).toBe(
      'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/abc.jpg',
    );
  });
});

// ---------------------------------------------------------------------------
// 순수 파서
// ---------------------------------------------------------------------------

describe('parseXStatusHtml', () => {
  test('summary 카드: 본문 → title, og:title 에서 " on X" 제거 → author, 아바타는 이미지로 쓰지 않음', () => {
    expect(parseXStatusHtml(JACK_HTML, 'https://x.com/jack/status/20')).toEqual({
      title: 'just setting up my twttr',
      description: null,
      author: 'jack (@jack)',
      siteName: 'X',
      canonicalUrl: 'https://x.com/jack/status/20',
      imageCandidates: [],
    });
  });

  test('summary_large_image 카드: og:image(&amp; 디코드) 를 small JPEG 로, apple-touch-icon 폴백은 제외', () => {
    const f = parseXStatusHtml(OBAMA_HTML, 'https://x.com/BarackObama/status/266031293945503744');
    expect(f?.title).toBe('Four more years.');
    expect(f?.author).toBe('Barack Obama (@BarackObama)');
    expect(f?.imageCandidates).toEqual(['https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=jpg&name=small']);
    expect(f?.canonicalUrl).toBe('https://x.com/BarackObama/status/266031293945503744');
  });

  test('404 페이지 og 는 (폰 제출 경로에서도) null', () => {
    expect(parseXStatusHtml(NOT_FOUND_HTML, 'https://x.com/jack/status/999999999999999999999')).toBe(null);
    expect(xAdapter.parseSubmitted!(NOT_FOUND_HTML, 'https://x.com/jack/status/999999999999999999999')).toBe(null);
  });

  test('og 없는 셸은 null', () => {
    expect(parseXStatusHtml(SHELL_HTML, 'https://x.com/jack/status/20')).toBe(null);
  });

  test('여러 줄 본문은 title 한 줄 + description 전체', () => {
    const html = JACK_HTML.replace('content="just setting up my twttr"', 'content="first line&#10;second line"');
    const f = parseXStatusHtml(html, 'https://x.com/jack/status/20');
    expect(f?.title).toBe('first line second line');
    expect(f?.description).toBe('first line\nsecond line');
  });
});

describe('parseXOembed', () => {
  test('첫 <p> 텍스트, 끝의 pic.twitter.com 앵커 제거, author_name (@handle)', () => {
    expect(parseXOembed(OEMBED_OBAMA)).toEqual({
      title: 'Four more years.',
      description: null,
      author: 'Barack Obama (@BarackObama)',
      siteName: 'X',
      canonicalUrl: 'https://x.com/BarackObama/status/266031293945503744',
      imageCandidates: [],
    });
    expect(parseXOembed(OEMBED_JACK)?.title).toBe('just setting up my twttr');
  });

  test('tweetTextFromOembedHtml: 엔티티 디코드, <p> 없으면 서명 앞까지', () => {
    expect(tweetTextFromOembedHtml('<blockquote><p>I&#39;m &amp; you</p>&mdash; a (@a)</blockquote>')).toBe(
      "I'm & you",
    );
    expect(tweetTextFromOembedHtml('<blockquote>plain text &mdash; a (@a) <a>date</a></blockquote>')?.trim()).toBe(
      'plain text',
    );
  });

  test('JSON 이 아니거나(404 HTML → json null) 비면 null', () => {
    expect(parseXOembed(null)).toBe(null);
    expect(parseXOembed('<!DOCTYPE html>')).toBe(null);
    expect(parseXOembed({ html: '' })).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// run — 가짜 io
// ---------------------------------------------------------------------------

describe('xAdapter.run — 상태 페이지', () => {
  test('/i/status/<id> 를 32 KB·stopAtHead·X 홉만 으로 읽고 ready(og)', async () => {
    const { io, calls } = fakeIo({ text: () => page(200, JACK_HTML, 'https://x.com/jack/status/20') });
    const out = await xAdapter.run(makeCtx('https://twitter.com/jack/status/20?s=20&t=AbCdEfGh123', io));
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.source).toBe('og');
    expect(out.fields.title).toBe('just setting up my twttr');
    expect(out.fields.author).toBe('jack (@jack)');
    expect(out.fields.siteName).toBe('X');
    expect(out.fields.imageCandidates).toEqual([]);
    expect(out.fields.canonicalUrl).toBe('https://x.com/jack/status/20');

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('fetchText');
    expect(calls[0].url).toBe('https://x.com/i/status/20');
    const opts = calls[0].opts as { maxBytes: number; stopAtHead?: boolean; hopAllow?: string[] };
    expect(opts.maxBytes).toBe(32 * 1024);
    expect(opts.stopAtHead).toBe(true);
    expect(opts.hopAllow).toEqual(X_HOP_HOSTS);
  });

  test('★ 404 게이트: 본문에 og 가 있어도 unsupported(gone), "Post Not Found" 는 어디에도 없다, oEmbed 도 안 부른다', async () => {
    const { io, calls } = fakeIo({
      text: () => page(404, NOT_FOUND_HTML, 'https://x.com/jack/status/999999999999999999999'),
      json: () => json(200, OEMBED_JACK),
    });
    const out = await xAdapter.run(makeCtx('https://x.com/jack/status/999999999999999999999', io));
    expect(out).toEqual({ kind: 'unsupported', error: 'gone' });
    expect(JSON.stringify(out)).not.toContain('Post Not Found');
    expect(JSON.stringify(out)).not.toContain('default-og');
    expect(calls.map((c) => c.method)).toEqual(['fetchText']);
  });

  test('summary_large_image → 첨부 사진을 small JPEG 로 복사 후보에', async () => {
    const { io } = fakeIo({
      text: () => page(200, OBAMA_HTML, 'https://x.com/BarackObama/status/266031293945503744'),
    });
    const out = await xAdapter.run(makeCtx('https://x.com/someoneelse/status/266031293945503744', io));
    if (out.kind !== 'ready') throw new Error(out.kind);
    expect(out.fields.imageCandidates).toEqual(['https://pbs.twimg.com/media/A7EiDWcCYAAZT1D?format=jpg&name=small']);
    // 틀린 사용자명으로 저장돼도 canonical 은 og:url 의 실제 작성자
    expect(out.fields.canonicalUrl).toBe('https://x.com/BarackObama/status/266031293945503744');
  });

  test('프로필 URL 은 네트워크 없이 "Posts by @handle"', async () => {
    const { io, calls } = fakeIo({});
    const out = await xAdapter.run(makeCtx('https://x.com/jack', io));
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.fields.title).toBe('Posts by @jack');
    expect(out.fields.canonicalUrl).toBe('https://x.com/jack');
    expect(out.fields.imageCandidates).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('xAdapter.run — oEmbed 폴백', () => {
  test('JS 셸(og 없음) → publish.x.com oEmbed(/i/status/ 폼, omit_script·dnt·hide_thread) → ready(oembed)', async () => {
    const { io, calls } = fakeIo({
      text: () => page(200, SHELL_HTML, 'https://x.com/BarackObama/status/266031293945503744'),
      json: () => json(200, OEMBED_OBAMA),
    });
    const out = await xAdapter.run(makeCtx('https://x.com/i/web/status/266031293945503744', io));
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.source).toBe('oembed');
    expect(out.fields.title).toBe('Four more years.');
    expect(out.fields.author).toBe('Barack Obama (@BarackObama)');
    expect(out.fields.imageCandidates).toEqual([]);
    expect(out.fields.canonicalUrl).toBe('https://x.com/BarackObama/status/266031293945503744');

    const oembed = calls.find((c) => c.method === 'fetchJson');
    expect(oembed?.url).toBe(xOembedUrl('266031293945503744'));
    expect(oembed?.url).toContain(encodeURIComponent('https://x.com/i/status/266031293945503744'));
    expect(oembed?.url).not.toContain('i%2Fweb'); // /i/web/status/ 는 oEmbed 가 404
    expect(oembed?.url).toContain('omit_script=true');
    expect(oembed?.url).toContain('dnt=true');
  });

  test('셸 + oEmbed 404(HTML, json null) → unsupported(gone)', async () => {
    const { io } = fakeIo({
      text: () => page(200, SHELL_HTML, 'https://x.com/jack/status/20'),
      json: () => json(404, null, 'text/html'),
    });
    const out = await xAdapter.run(makeCtx('https://x.com/jack/status/20', io));
    expect(out).toEqual({ kind: 'unsupported', error: 'gone' });
  });

  test('셸 + oEmbed 5xx → needs_client(blocked:shell, runner fetch, parser generic, url /i/status/)', async () => {
    const { io } = fakeIo({
      text: () => page(200, SHELL_HTML, 'https://x.com/jack/status/20'),
      json: () => json(503, null, 'text/html'),
    });
    const out = await xAdapter.run(makeCtx('https://x.com/jack/status/20', io));
    expect(out.kind).toBe('needs_client');
    if (out.kind !== 'needs_client') return;
    expect(out.error).toBe('blocked:shell');
    expect(out.task).toEqual({ runner: 'fetch', parser: 'generic', url: 'https://x.com/i/status/20' });
    expect(out.fields?.siteName).toBe('X');
    expect(out.fields?.canonicalUrl).toBe('https://x.com/jack/status/20');
  });

  test('Cloudflare 403 + oEmbed 실패 → needs_client(blocked:cloudflare)', async () => {
    const { io } = fakeIo({
      text: () =>
        page(
          403,
          '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>',
          'https://x.com/i/status/20',
          {
            server: 'cloudflare',
            'cf-mitigated': 'challenge',
          },
        ),
      json: () => {
        throw new Error('dns lookup failed');
      },
    });
    const out = await xAdapter.run(makeCtx('https://x.com/jack/status/20', io));
    expect(out.kind).toBe('needs_client');
    if (out.kind === 'needs_client') expect(out.error).toBe('blocked:cloudflare');
  });

  test('페이지 타임아웃 + oEmbed 타임아웃 → failed(timeout) (폰에 넘기지 않고 재시도)', async () => {
    const { io } = fakeIo({
      text: () => {
        throw Object.assign(new Error('x'), { code: 'timeout' });
      },
      json: () => {
        throw new Error('request timed out');
      },
    });
    const out = await xAdapter.run(makeCtx('https://x.com/jack/status/20', io));
    expect(out).toEqual({ kind: 'failed', error: 'timeout' });
  });

  test('페이지 5xx + oEmbed 성공 → ready(oembed)', async () => {
    const { io } = fakeIo({
      text: () => page(503, '', 'https://x.com/i/status/20'),
      json: () => json(200, OEMBED_JACK),
    });
    const out = await xAdapter.run(makeCtx('https://x.com/jack/status/20', io));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.source).toBe('oembed');
  });
});

describe('xAdapter.run — t.co', () => {
  const TCO_CHAIN: RedirectChain = {
    locations: [
      'https://twitter.com/BarackObama/status/266031293945503744/photo/1',
      'https://x.com/BarackObama/status/266031293945503744',
    ],
    status: 200,
  };
  const EXTERNAL_CHAIN: RedirectChain = { locations: ['https://example.com/article'], status: 200 };
  const ARTICLE_HTML =
    '<html><head><meta property="og:title" content="Article"><meta property="og:site_name" content="Example"></head></html>';

  test('가짜 io 검증: 외부 체인을 hopAllow 로 따라가면 fetch.ts 처럼 ssrf:hop_host 를 던진다 (옛 resolveTco 가 죽던 지점)', () => {
    expect(() => followChain('https://t.co/abc', EXTERNAL_CHAIN, { maxHops: 5, hopAllow: X_HOP_HOSTS })).toThrow(
      /ssrf:hop_host/,
    );
    // firstHopOnly 는 Location 을 검사하지 않고 돌려준다 (따라가지도 않는다)
    expect(followChain('https://t.co/abc', EXTERNAL_CHAIN, { maxHops: 1, firstHopOnly: true })).toEqual({
      hops: [],
      final: 'https://t.co/abc',
      firstLocation: 'https://example.com/article',
      status: 301,
    });
  });

  test('tco_nofollow.headers: 301 → twitter.com/…/photo/1 — 첫 Location 만 읽고(firstHopOnly·hopAllow 없음) status 흐름', async () => {
    const { io, calls } = fakeIo({
      redirects: { 'https://t.co/bAJE6Vom': TCO_CHAIN },
      text: () => page(200, OBAMA_HTML, 'https://x.com/BarackObama/status/266031293945503744'),
    });
    const out = await xAdapter.run(makeCtx('https://t.co/bAJE6Vom', io));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.fields.title).toBe('Four more years.');

    expect(calls[0].method).toBe('resolveRedirects');
    const opts = calls[0].opts as ResolveRedirectsOptions;
    expect(opts.firstHopOnly).toBe(true);
    expect(opts.hopAllow).toBeUndefined();
    expect(calls[1]).toMatchObject({ method: 'fetchText', url: 'https://x.com/i/status/266031293945503744' });
    expect(calls).toHaveLength(2);
  });

  test('★ t.co → 외부 기사(대다수): Location 호스트가 X 가 아니면 generic 으로 그 URL 을 읽는다', async () => {
    const { io, calls } = fakeIo({
      redirects: { 'https://t.co/abc': EXTERNAL_CHAIN },
      text: (url) => page(200, ARTICLE_HTML, url, { server: 'nginx' }),
    });
    const out = await xAdapter.run(makeCtx('https://t.co/abc', io));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.fields.title).toBe('Article');
    expect(calls[1]).toMatchObject({ method: 'fetchText', url: 'https://example.com/article' });
    // generic 의 fetch 엔 X 홉 제한을 걸지 않는다 — 기사 사이트의 자체 리다이렉트는 SSRF 검사만 받는다
    expect((calls[1].opts as { hopAllow?: unknown }).hopAllow).toBeUndefined();
  });

  test('t.co → t.co → x.com: 첫 홉 읽기를 한 번 더', async () => {
    const { io, calls } = fakeIo({
      redirects: {
        'https://t.co/a1': { locations: ['https://t.co/a2'] },
        'https://t.co/a2': { locations: ['https://x.com/jack/status/20'] },
      },
      text: () => page(200, JACK_HTML, 'https://x.com/jack/status/20'),
    });
    const out = await xAdapter.run(makeCtx('https://t.co/a1', io));
    expect(out.kind).toBe('ready');
    expect(calls.map((c) => c.method)).toEqual(['resolveRedirects', 'resolveRedirects', 'fetchText']);
  });

  test('t.co 가 Location 없이 404 → unsupported(gone)', async () => {
    const { io } = fakeIo({ redirects: { 'https://t.co/gone': { locations: [], status: 404 } } });
    expect(await xAdapter.run(makeCtx('https://t.co/gone', io))).toEqual({ kind: 'unsupported', error: 'gone' });
  });

  test('t.co 해석이 던지면(홉 0 SSRF 거부 등) failed 에 그 코드', async () => {
    const { io } = fakeIo({
      redirects: { 'https://t.co/abc': Object.assign(new Error('blocked'), { code: 'ssrf:ip' }) },
    });
    const out = await xAdapter.run(makeCtx('https://t.co/abc', io));
    expect(out).toEqual({ kind: 'failed', error: 'ssrf:ip' });
  });
});
