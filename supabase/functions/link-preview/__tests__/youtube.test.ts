// 실행: bun test supabase/functions/link-preview
// 고정값은 2026-11-04 프로브(oembed_watch.json, oembed_shorts_JfbnpYLe3Ms.json, thumb_*.headers, page_shorts_J-mrNqVPEWM.html) 발췌.
// 네트워크는 전부 가짜 io — 어댑터가 Deno fetch 를 직접 부르면 beforeAll 의 globalThis.fetch 가 던져서 실패한다.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type {
  FetchJsonResult,
  FetchTextResult,
  HeadResult,
  PreviewIO,
  ProviderCtx,
  ResolveRedirectsResult,
} from '../types.ts';
import { extractYouTubeId, youtubeAdapter, youtubeOembedUrl, youtubeThumbnailUrl } from '../sites/youtube.ts';

// ---------------------------------------------------------------------------
// 가짜 io
// ---------------------------------------------------------------------------

interface Call {
  method: keyof PreviewIO;
  url: string;
  opts: unknown;
}

interface FakeHandlers {
  text?: (url: string) => FetchTextResult | Promise<FetchTextResult>;
  json?: (url: string) => FetchJsonResult | Promise<FetchJsonResult>;
  head?: (url: string) => HeadResult | Promise<HeadResult>;
  redirects?: (url: string) => ResolveRedirectsResult | Promise<ResolveRedirectsResult>;
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
      if (!h.redirects) throw unexpected('resolveRedirects', url);
      return h.redirects(url);
    },
  };
  return { io, calls };
}

function makeCtx(postUrl: string, io: PreviewIO, extra: Partial<ProviderCtx> = {}): ProviderCtx {
  const canon = youtubeAdapter.canonicalize ? youtubeAdapter.canonicalize(new URL(postUrl)) : null;
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

const json = (status: number, body: unknown, contentType = 'application/json'): FetchJsonResult => ({
  status,
  finalUrl: 'https://www.youtube.com/oembed',
  contentType,
  json: body,
  headers: {},
});

const html = (status: number, text: string, finalUrl: string): FetchTextResult => ({
  status,
  finalUrl,
  contentType: 'text/html',
  text,
  headers: {},
});

/** 썸네일 HEAD: 주어진 이름만 200, 나머지 404 (404 도 image/jpeg 를 준다 — 실제 관측) */
const headOnly = (okNames: string[]) => (url: string) => ({
  status: okNames.some((n) => url.endsWith(`/${n}.jpg`)) ? 200 : 404,
  contentType: 'image/jpeg',
});

const OEMBED_WATCH = {
  title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
  author_name: 'Rick Astley',
  author_url: 'https://www.youtube.com/@RickAstleyYT',
  type: 'video',
  height: 113,
  width: 200,
  thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
};

const OEMBED_SHORTS = {
  title: 'If Cleaning Was a Timed Sport. Part 2',
  author_name: 'Daniel LaBelle',
  type: 'video',
  height: 200,
  width: 113,
  thumbnail_url: 'https://i.ytimg.com/vi/JfbnpYLe3Ms/hq2.jpg',
};

// page_shorts_J-mrNqVPEWM.html 발췌 — 설명 없는 영상의 og:description 은 한국어 보일러플레이트
const SHORTS_PAGE_HEAD = `<!DOCTYPE html><html><head>
<meta property="og:site_name" content="YouTube">
<meta property="og:url" content="https://www.youtube.com/shorts/J-mrNqVPEWM">
<meta property="og:title" content="Máy ép hoa quả siêu bền |K2k3 #shorts">
<meta property="og:image" content="https://i.ytimg.com/vi/J-mrNqVPEWM/oar2.jpg?sqp=-oaymwEk&amp;rs=AOn4CLBilbbcat6E6TLshi10GPa3PwOZBg">
<meta property="og:description" content="YouTube에서 마음에 드는 동영상과 음악을 감상하고, 직접 만든 콘텐츠를 업로드하여 친구, 가족뿐 아니라 전 세계 사람들과 콘텐츠를 공유할 수 있습니다.">
<meta property="og:type" content="video.other">
<title>Máy ép hoa quả siêu bền |K2k3 #shorts - YouTube</title>
</head><body></body></html>`;

const CHANNEL_PAGE = `<!DOCTYPE html><html><head>
<meta property="og:site_name" content="YouTube">
<meta property="og:url" content="https://www.youtube.com/@RickAstleyYT">
<meta property="og:title" content="Rick Astley">
<meta property="og:image" content="https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj">
<meta property="og:description" content="Official Rick Astley channel">
<title>Rick Astley - YouTube</title>
</head><body></body></html>`;

const realFetch = globalThis.fetch;
beforeAll(() => {
  // 어댑터는 ctx.io 만 써야 한다 — 전역 fetch 를 부르면 여기서 터진다
  globalThis.fetch = (() => {
    throw new Error('adapter must not call fetch() directly');
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// id 추출 — 호스트 허용목록 포함 17 케이스 (probe 의 extract_id.ts 와 같은 집합)
// ---------------------------------------------------------------------------

describe('extractYouTubeId', () => {
  const id = (href: string) => extractYouTubeId(new URL(href));

  test.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    ['https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ', false],
    ['https://youtu.be/dQw4w9WgXcQ?si=abcDEF123', 'dQw4w9WgXcQ', false],
    ['https://www.youtube.com/shorts/JfbnpYLe3Ms?si=TESTsi123&feature=share', 'JfbnpYLe3Ms', true],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?si=x', 'dQw4w9WgXcQ', false],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    // youtu.be 303 뒤의 watch — si= 가 v= 앞에 온다 (watch?v= 에 고정된 정규식은 놓친다)
    ['https://www.youtube.com/watch?si=abcDEF123&v=dQw4w9WgXcQ&feature=youtu.be', 'dQw4w9WgXcQ', false],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=0gcJCbsCQVKahPAF', 'dQw4w9WgXcQ', false],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    ['http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    ['https://www.youtube.com/v/dQw4w9WgXcQ', 'dQw4w9WgXcQ', false],
    ['https://www.youtube.com/e/dQw4w9WgXcQ?start=10', 'dQw4w9WgXcQ', false],
    ['https://youtu.be/J-mrNqVPEWM/', 'J-mrNqVPEWM', false],
    ['https://www.youtube.com/shorts/J-mrNqVPEWM/', 'J-mrNqVPEWM', true],
  ])('%s → %s', (href, expected, shorts) => {
    expect(id(href)).toEqual({ id: expected, shorts });
  });

  test.each([
    ['https://www.youtube.com/@RickAstleyYT', '채널'],
    ['https://www.youtube.com/playlist?list=PL123', '재생목록'],
    ['https://www.youtube.com/watch?v=short', 'v 가 11자가 아님'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQx', '경로 id 가 12자'],
    ['https://youtu.be/', '빈 youtu.be'],
    ['https://evil.com/watch?v=dQw4w9WgXcQ', '다른 호스트'],
    ['https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ', '접미 호스트 위장'],
    ['https://evil.com/?u=https://www.youtube.com/watch?v=dQw4w9WgXcQ', '쿼리 안의 유튜브 URL'],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ', '유사 호스트'],
  ])('거부: %s (%s)', (href) => {
    expect(id(href)).toBe(null);
  });
});

describe('canonicalize', () => {
  test('모든 폼이 watch?v=<id> 로 — 재생 위치·list·si 는 버린다 (같은 영상은 같은 미리보기)', () => {
    const c = (href: string) => youtubeAdapter.canonicalize!(new URL(href));
    expect(c('https://youtu.be/dQw4w9WgXcQ?si=abcDEF123')).toEqual({
      fetchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(c('https://www.youtube.com/shorts/JfbnpYLe3Ms?feature=share').canonicalUrl).toBe(
      'https://www.youtube.com/watch?v=JfbnpYLe3Ms',
    );
    expect(c('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1').canonicalUrl).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  test('id 없는 채널 URL 은 기본 정리(utm 제거) 만', () => {
    const c = youtubeAdapter.canonicalize!(new URL('https://www.youtube.com/@RickAstleyYT?utm_source=x'));
    expect(c.canonicalUrl).toBe('https://www.youtube.com/@RickAstleyYT');
  });

  test('match 는 허용 호스트만', () => {
    expect(youtubeAdapter.match(new URL('https://youtu.be/dQw4w9WgXcQ'))).toBe(true);
    expect(youtubeAdapter.match(new URL('https://www.youtube.com.evil.com/x'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run — 가짜 io
// ---------------------------------------------------------------------------

describe('youtubeAdapter.run — oEmbed 경로', () => {
  test('oEmbed 200 → ready(oembed): 제목·채널·YouTube·maxresdefault, 설명은 의도적으로 null', async () => {
    const { io, calls } = fakeIo({
      json: () => json(200, OEMBED_WATCH),
      head: headOnly(['maxresdefault', 'sddefault', 'hqdefault']),
    });
    const out = await youtubeAdapter.run(makeCtx('https://youtu.be/dQw4w9WgXcQ?si=abcDEF123', io));
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.source).toBe('oembed');
    expect(out.fields).toEqual({
      title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      description: null,
      author: 'Rick Astley',
      siteName: 'YouTube',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      imageCandidates: ['https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg'],
    });
    // oEmbed 엔 원본 URL 이 아니라 canonical watch URL 을 넘긴다 (/embed/·/v/ 는 404)
    const oembedCall = calls.find((c) => c.method === 'fetchJson');
    expect(oembedCall?.url).toBe(youtubeOembedUrl('dQw4w9WgXcQ'));
    expect(oembedCall?.url).toContain(encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    expect(oembedCall?.url).not.toContain('youtu.be');
    // 첫 HEAD 가 200 이면 더 묻지 않는다
    expect(calls.filter((c) => c.method === 'head')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'fetchText')).toBe(false);
  });

  test('/embed/<id> 원본도 oEmbed 엔 watch?v= 로 묻는다', async () => {
    const { io, calls } = fakeIo({ json: () => json(200, OEMBED_WATCH), head: headOnly(['hqdefault']) });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/embed/dQw4w9WgXcQ', io));
    expect(out.kind).toBe('ready');
    expect(calls.find((c) => c.method === 'fetchJson')?.url).toBe(youtubeOembedUrl('dQw4w9WgXcQ'));
  });

  test('썸네일 HEAD: 404 는 image/jpeg 라도 건너뛰고 상태 200 인 첫 번째(maxres → sd → hq) 만', async () => {
    const { io, calls } = fakeIo({ json: () => json(200, OEMBED_WATCH), head: headOnly(['hqdefault']) });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/watch?v=dQw4w9WgXcQ', io));
    if (out.kind !== 'ready') throw new Error(out.kind);
    expect(out.fields.imageCandidates).toEqual([youtubeThumbnailUrl('dQw4w9WgXcQ', 'hqdefault')]);
    expect(calls.filter((c) => c.method === 'head').map((c) => c.url)).toEqual([
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    ]);
  });

  test('전부 404 면 이미지 없이 ready (텍스트 카드)', async () => {
    const { io } = fakeIo({ json: () => json(200, OEMBED_WATCH), head: headOnly([]) });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/watch?v=dQw4w9WgXcQ', io));
    if (out.kind !== 'ready') throw new Error(out.kind);
    expect(out.fields.imageCandidates).toEqual([]);
    expect(out.fields.title).toBe(OEMBED_WATCH.title);
  });

  test('HEAD 가 던져도 다음 후보로 넘어간다', async () => {
    const { io } = fakeIo({
      json: () => json(200, OEMBED_WATCH),
      head: (url) => {
        if (url.includes('maxresdefault')) throw new Error('timed out');
        return { status: 200, contentType: 'image/jpeg' };
      },
    });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/watch?v=dQw4w9WgXcQ', io));
    if (out.kind !== 'ready') throw new Error(out.kind);
    expect(out.fields.imageCandidates).toEqual(['https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg']);
  });

  test('/shorts/ 원본 → siteName "YouTube Shorts", canonical 은 watch?v=', async () => {
    const { io } = fakeIo({ json: () => json(200, OEMBED_SHORTS), head: headOnly(['maxresdefault']) });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/shorts/JfbnpYLe3Ms?si=TESTsi123', io));
    if (out.kind !== 'ready') throw new Error(out.kind);
    expect(out.fields.siteName).toBe('YouTube Shorts');
    expect(out.fields.title).toBe('If Cleaning Was a Timed Sport. Part 2');
    expect(out.fields.author).toBe('Daniel LaBelle');
    expect(out.fields.canonicalUrl).toBe('https://www.youtube.com/watch?v=JfbnpYLe3Ms');
  });

  test('oEmbed 400 "Bad Request" (없는 영상) → unsupported(gone), 페이지는 읽지 않는다', async () => {
    const { io, calls } = fakeIo({
      json: () => json(400, null, 'application/json'),
      head: headOnly([]),
    });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/watch?v=zzzzzzzzzzz', io));
    expect(out).toEqual({ kind: 'unsupported', error: 'gone' });
    expect(calls.some((c) => c.method === 'fetchText')).toBe(false);
  });

  test('oEmbed 404 도 gone', async () => {
    const { io } = fakeIo({ json: () => json(404, null, 'text/html'), head: headOnly([]) });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/watch?v=dQw4w9WgXcQ', io));
    expect(out).toEqual({ kind: 'unsupported', error: 'gone' });
  });
});

describe('youtubeAdapter.run — 폴백', () => {
  test('oEmbed 5xx → watch 페이지 og(1 MiB, *.youtube.com 홉만), 보일러플레이트 설명은 버림, 썸네일은 HEAD 결과가 앞', async () => {
    const { io, calls } = fakeIo({
      json: () => json(503, null, 'text/html'),
      head: headOnly(['maxresdefault']),
      text: (url) => html(200, SHORTS_PAGE_HEAD, url),
    });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/shorts/J-mrNqVPEWM', io));
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.source).toBe('og');
    expect(out.fields.title).toBe('Máy ép hoa quả siêu bền |K2k3 #shorts');
    expect(out.fields.description).toBe(null);
    expect(out.fields.siteName).toBe('YouTube Shorts');
    expect(out.fields.canonicalUrl).toBe('https://www.youtube.com/watch?v=J-mrNqVPEWM');
    expect(out.fields.imageCandidates[0]).toBe('https://i.ytimg.com/vi/J-mrNqVPEWM/maxresdefault.jpg');
    expect(out.fields.imageCandidates[1]).toBe(
      'https://i.ytimg.com/vi/J-mrNqVPEWM/oar2.jpg?sqp=-oaymwEk&rs=AOn4CLBilbbcat6E6TLshi10GPa3PwOZBg',
    );
    const page = calls.find((c) => c.method === 'fetchText');
    expect(page?.url).toBe('https://www.youtube.com/watch?v=J-mrNqVPEWM');
    const opts = page?.opts as { maxBytes: number; stopAtHead?: boolean; hopAllow?: unknown[] };
    expect(opts.maxBytes).toBe(1024 * 1024);
    expect(opts.stopAtHead).toBe(true);
    expect(opts.hopAllow).toContain('*.youtube.com');
  });

  test('oEmbed 가 던지고(네트워크) 페이지도 타임아웃이면 failed(timeout) — catch-up 재시도 대상', async () => {
    const { io } = fakeIo({
      json: () => {
        throw new Error('fetch timed out');
      },
      head: headOnly([]),
      text: () => {
        throw Object.assign(new Error('x'), { code: 'timeout' });
      },
    });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/watch?v=dQw4w9WgXcQ', io));
    expect(out).toEqual({ kind: 'failed', error: 'timeout' });
  });

  test('oEmbed 401 + 페이지 제목 없음 → unsupported(private)', async () => {
    const { io } = fakeIo({
      json: () => json(401, null, 'text/html'),
      head: headOnly([]),
      text: (url) =>
        html(
          200,
          '<html><head><meta property="og:site_name" content="YouTube"><title>YouTube</title></head></html>',
          url,
        ),
    });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/watch?v=dQw4w9WgXcQ', io));
    expect(out.kind).toBe('unsupported');
    if (out.kind === 'unsupported') expect(out.error).toBe('private');
  });

  test('비디오 id 없는 채널 URL 은 generic 에 위임 (fetchText 1회, oEmbed·HEAD 없음)', async () => {
    const { io, calls } = fakeIo({ text: (url) => html(200, CHANNEL_PAGE, url) });
    const out = await youtubeAdapter.run(makeCtx('https://www.youtube.com/@RickAstleyYT', io));
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.source).toBe('og');
    expect(out.fields.title).toBe('Rick Astley');
    expect(out.fields.siteName).toBe('YouTube');
    expect(out.fields.canonicalUrl).toBe('https://www.youtube.com/@RickAstleyYT');
    expect(calls.map((c) => c.method)).toEqual(['fetchText']);
  });

  test('예산이 끝났으면 네트워크 없이 failed(timeout)', async () => {
    const { io, calls } = fakeIo({});
    const out = await youtubeAdapter.run(
      makeCtx('https://www.youtube.com/watch?v=dQw4w9WgXcQ', io, { deadline: Date.now() - 1 }),
    );
    expect(out).toEqual({ kind: 'failed', error: 'timeout' });
    expect(calls).toHaveLength(0);
  });
});
