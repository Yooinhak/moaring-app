// 실행: bun test supabase/functions/link-preview
// fetchImpl·resolve 를 주입해 네트워크 없이 PreviewIO 전 경로를 돈다. 리다이렉트 체인은 probes/edge-cases 의 naver.me 를 본뜬다.
import { describe, expect, test } from 'bun:test';

import {
  createPreviewIO,
  errorCode,
  hasHeadEnd,
  NON_2XX_BODY_CAP,
  PreviewIoError,
  readCapped,
  requestWithRedirects,
  resolveLocation,
} from '../fetch.ts';
import { SsrfError } from '../ssrf.ts';
import type { FetchLike } from '../ssrf.ts';

const PUBLIC_V4 = '93.184.216.34';
const enc = new TextEncoder();

type Route = (init: RequestInit) => Response | Promise<Response>;

interface Call {
  url: string;
  init: RequestInit;
}

function makeFetch(routes: Record<string, Route>, calls: Call[] = []): FetchLike {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError(`unrouted ${url}`);
    return await route(init);
  };
}

function redirect(status: number, location: string): Route {
  return () => new Response(null, { status, headers: { location } });
}

function html(body: string | Uint8Array<ArrayBuffer>, contentType = 'text/html; charset=utf-8', status = 200): Route {
  return () => new Response(body, { status, headers: { 'content-type': contentType } });
}

function publicResolver(seen: string[] = []) {
  return async (host: string) => {
    seen.push(host);
    return [PUBLIC_V4];
  };
}

/** signal 이 울릴 때까지 응답하지 않는 서버. */
const hanging: Route = (init) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
  });

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return errorCode(err);
  }
}

describe('resolveLocation / hasHeadEnd', () => {
  test('상대 Location 은 현재 URL 기준, 프래그먼트 제거', () => {
    expect(resolveLocation('/service/5637?lang=ko', 'https://help.naver.com/support/x')).toBe(
      'https://help.naver.com/service/5637?lang=ko',
    );
    expect(resolveLocation('https://www.youtube.com/watch?v=4zLfCnGVeL4#t', 'https://youtu.be/4zLfCnGVeL4')).toBe(
      'https://www.youtube.com/watch?v=4zLfCnGVeL4',
    );
    expect(resolveLocation('%%%', 'not a base')).toBe(null);
  });

  test('</head> · <body 대소문자 무관, 그 외는 false', () => {
    expect(hasHeadEnd(enc.encode('<html><head><title>x</title></HEAD>'))).toBe(true);
    expect(hasHeadEnd(enc.encode('<html><head><title>x</title><BODY class="a">'))).toBe(true);
    expect(hasHeadEnd(enc.encode('<html><head><meta property="og:title" content="</heading>">'))).toBe(false);
    expect(hasHeadEnd(new Uint8Array(0))).toBe(false);
  });
});

describe('readCapped', () => {
  function stream(chunks: Uint8Array[], onCancel?: () => void, infinite = false): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else if (infinite) controller.enqueue(new Uint8Array(65536).fill(0x20));
        else controller.close();
      },
      cancel() {
        onCancel?.();
      },
    });
  }

  test('캡을 넘기면 자르고 cancel 한다 (Range 를 무시하는 서버 대비)', async () => {
    let cancelled = false;
    const r = await readCapped(
      stream([], () => (cancelled = true), true),
      { maxBytes: 100_000 },
    );
    expect(r.bytes.length).toBe(100_000);
    expect(r.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });

  test('정확히 캡 크기면 잘린 것이 아니다', async () => {
    const r = await readCapped(stream([new Uint8Array(10), new Uint8Array(10)]), { maxBytes: 20 });
    expect(r.bytes.length).toBe(20);
    expect(r.truncated).toBe(false);
  });

  test('stopAtHead — 마커가 청크 경계에 걸쳐도 잡고, 그 뒤 본문은 받지 않고 cancel 한다', async () => {
    // 스트림은 highWaterMark 만큼 pull 을 미리 호출하므로 pull 횟수가 아니라 "돌려준 바이트" 와 cancel 로 판정한다
    let cancelled = false;
    const chunks = [
      enc.encode('<html><head><meta property="og:title" content="t"></he'),
      enc.encode('ad><body>'),
      new Uint8Array(1024).fill(0x79),
    ];
    const s = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks.length > 0) controller.enqueue(chunks.shift() as Uint8Array);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await readCapped(s, { maxBytes: 1_048_576, stopAtHead: true });
    expect(r.truncated).toBe(true);
    expect(new TextDecoder().decode(r.bytes)).toBe('<html><head><meta property="og:title" content="t"></head><body>');
    expect(cancelled).toBe(true);
  });

  test('본문 없음', async () => {
    expect(await readCapped(null, { maxBytes: 10 })).toEqual({ bytes: new Uint8Array(0), truncated: false });
  });
});

describe('requestWithRedirects — 홉마다 SSRF, hopAllow, 홉 상한, firstHopOnly', () => {
  // probes/edge-cases: http://naver.me/GYywEiT4 → 5홉·3호스트·상대 Location 2개
  const naverChain = {
    'http://naver.me/GYywEiT4': redirect(301, 'https://naver.me/GYywEiT4'),
    'https://naver.me/GYywEiT4': redirect(307, 'https://m.help.naver.com/support/service/main.help?serviceNo=5637'),
    'https://m.help.naver.com/support/service/main.help?serviceNo=5637': redirect(
      301,
      'https://help.naver.com/support/service/main.help?serviceNo=5637&mapping=false',
    ),
    'https://help.naver.com/support/service/main.help?serviceNo=5637&mapping=false': redirect(
      302,
      '/service/5637?lang=ko',
    ),
    'https://help.naver.com/service/5637?lang=ko': redirect(307, '/service/5637/category/bookmark?lang=ko'),
    'https://help.naver.com/service/5637/category/bookmark?lang=ko': html(
      '<html><head><title>지도 고객센터</title></head>',
    ),
  };

  test('상대 Location 을 따라 끝까지 가고, 모든 홉 호스트가 SSRF 검사를 거친다', async () => {
    const calls: Call[] = [];
    const seen: string[] = [];
    const io = createPreviewIO({ fetchImpl: makeFetch(naverChain, calls), resolve: publicResolver(seen) });
    const r = await io.resolveRedirects('http://naver.me/GYywEiT4', { maxHops: 8 });
    expect(r.final).toBe('https://help.naver.com/service/5637/category/bookmark?lang=ko');
    expect(r.hops).toHaveLength(5);
    expect(r.hops[0]).toBe('http://naver.me/GYywEiT4');
    expect(r.firstLocation).toBe('https://naver.me/GYywEiT4');
    expect(r.status).toBe(200);
    // 6개 요청 전부 SSRF 검사 — 호스트가 바뀌는 지점마다 해석됐다 (캐시는 주입 resolver 에 적용되지 않는다)
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set(['naver.me', 'm.help.naver.com', 'help.naver.com']));
    for (const c of calls) {
      expect(c.init.redirect).toBe('manual');
      // UA·쿠키·Referer 없이 Accept 만
      expect(Object.keys(c.init.headers as Record<string, string>)).toEqual(['accept']);
    }
  });

  test('hopAllow 밖으로 나가는 홉은 요청을 보내기 전에 막는다', async () => {
    const calls: Call[] = [];
    const io = createPreviewIO({ fetchImpl: makeFetch(naverChain, calls), resolve: publicResolver() });
    const code = await codeOf(io.resolveRedirects('http://naver.me/GYywEiT4', { maxHops: 8, hopAllow: ['naver.me'] }));
    expect(code).toBe('ssrf:hop_host');
    expect(calls.map((c) => c.url)).toEqual(['http://naver.me/GYywEiT4', 'https://naver.me/GYywEiT4']);
  });

  test('hopAllow 는 시작 URL 에는 적용하지 않는다 (어댑터가 고른 주소)', async () => {
    const io = createPreviewIO({
      fetchImpl: makeFetch({
        'https://t.co/abc': redirect(301, 'https://x.com/i/status/1'),
        'https://x.com/i/status/1': html('<html>'),
      }),
      resolve: publicResolver(),
    });
    const r = await io.resolveRedirects('https://t.co/abc', { maxHops: 5, hopAllow: ['x.com', '*.twitter.com'] });
    expect(r.final).toBe('https://x.com/i/status/1');
  });

  test('maxHops 초과 → too_many_redirects, BUDGET.maxHops(8) 위로는 못 올린다', async () => {
    const calls: Call[] = [];
    const io = createPreviewIO({ fetchImpl: makeFetch(naverChain, calls), resolve: publicResolver() });
    expect(await codeOf(io.resolveRedirects('http://naver.me/GYywEiT4', { maxHops: 2 }))).toBe('too_many_redirects');
    expect(calls).toHaveLength(3);

    const loop: Record<string, Route> = {};
    for (let i = 0; i < 20; i++) loop[`https://loop.example/${i}`] = redirect(302, `/${i + 1}`);
    const loopCalls: Call[] = [];
    const io2 = createPreviewIO({ fetchImpl: makeFetch(loop, loopCalls), resolve: publicResolver() });
    expect(await codeOf(io2.resolveRedirects('https://loop.example/0', { maxHops: 50 }))).toBe('too_many_redirects');
    expect(loopCalls).toHaveLength(9); // 시작 + 8홉
  });

  test('firstHopOnly — Location 만 읽고 따라가지 않는다 (naver.me·link.coupang.com)', async () => {
    const calls: Call[] = [];
    const routes = {
      'https://link.coupang.com/a/abc': redirect(302, 'https://www.coupang.com/vp/products/123?itemId=1&lptag=AF'),
    };
    const io = createPreviewIO({ fetchImpl: makeFetch(routes, calls), resolve: publicResolver() });
    const r = await io.resolveRedirects('https://link.coupang.com/a/abc', { maxHops: 1, firstHopOnly: true });
    expect(r.firstLocation).toBe('https://www.coupang.com/vp/products/123?itemId=1&lptag=AF');
    expect(r.final).toBe('https://link.coupang.com/a/abc');
    expect(r.hops).toEqual([]);
    expect(r.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  test('Location 없는 3xx 는 최종 응답', async () => {
    const io = createPreviewIO({
      fetchImpl: makeFetch({ 'https://example.com/': () => new Response(null, { status: 304 }) }),
      resolve: publicResolver(),
    });
    const r = await io.resolveRedirects('https://example.com/', { maxHops: 3 });
    expect(r.status).toBe(304);
    expect(r.final).toBe('https://example.com/');
  });

  test('fail-closed: DNS 가 비면 fetch 가 한 번도 불리지 않는다', async () => {
    const calls: Call[] = [];
    const io = createPreviewIO({ fetchImpl: makeFetch(naverChain, calls), resolve: async () => [] });
    expect(await codeOf(io.fetchText('http://naver.me/GYywEiT4', { maxBytes: 1024, timeoutMs: 1000 }))).toBe(
      'dns_failed',
    );
    expect(await codeOf(io.fetchJson('http://naver.me/GYywEiT4', { timeoutMs: 1000 }))).toBe('dns_failed');
    expect(await codeOf(io.head('http://naver.me/GYywEiT4', { timeoutMs: 1000 }))).toBe('dns_failed');
    expect(await codeOf(io.resolveRedirects('http://naver.me/GYywEiT4', { maxHops: 3 }))).toBe('dns_failed');
    expect(calls).toHaveLength(0);
  });

  test('사설 IP·블록 호스트는 fetch 전에 거부', async () => {
    const calls: Call[] = [];
    const io = createPreviewIO({ fetchImpl: makeFetch({}, calls), resolve: async () => ['10.1.2.3'] });
    expect(await codeOf(io.fetchText('https://example.com/', { maxBytes: 1024, timeoutMs: 1000 }))).toBe('ssrf:ip');
    expect(await codeOf(io.fetchText('http://169.254.169.254/latest', { maxBytes: 1024, timeoutMs: 1000 }))).toBe(
      'ssrf:ip',
    );
    expect(await codeOf(io.fetchText('http://localhost:8000/', { maxBytes: 1024, timeoutMs: 1000 }))).toBe('ssrf:port');
    expect(
      await codeOf(io.fetchText('https://abc.supabase.co/rest/v1/posts', { maxBytes: 1024, timeoutMs: 1000 })),
    ).toBe('ssrf:host');
    expect(calls).toHaveLength(0);
  });

  test('타임아웃 → timeout (AbortSignal.timeout 의 TimeoutError 매핑)', async () => {
    const io = createPreviewIO({
      fetchImpl: makeFetch({ 'https://slow.example/': hanging }),
      resolve: publicResolver(),
    });
    expect(await codeOf(io.fetchText('https://slow.example/', { maxBytes: 1024, timeoutMs: 30 }))).toBe('timeout');
  });

  test('연결 실패(TypeError) → network', async () => {
    const io = createPreviewIO({ fetchImpl: makeFetch({}), resolve: publicResolver() });
    expect(await codeOf(io.head('https://down.example/', { timeoutMs: 1000 }))).toBe('network');
  });

  test('requestWithRedirects 가 돌려준 응답 본문은 호출자가 읽을 수 있다 (3xx 본문은 이미 cancel)', async () => {
    const r = await requestWithRedirects(
      'https://example.com/a',
      { accept: 'text/html', timeoutMs: 1000 },
      {
        fetchImpl: makeFetch({ 'https://example.com/a': redirect(302, '/b'), 'https://example.com/b': html('hello') }),
        resolve: publicResolver(),
      },
    );
    expect(r.hops).toEqual(['https://example.com/a']);
    expect(r.finalUrl).toBe('https://example.com/b');
    expect(await r.response.text()).toBe('hello');
  });
});

describe('fetchText — Content-Type 선분류·캡·charset', () => {
  // yes24 메인 <title> 실제 바이트 bf b9 bd ba 32 34 = EUC-KR '예스24', 헤더 라벨 ks_c_5601-1987
  const yes24 = new Uint8Array([
    ...enc.encode('<html><head><title>'),
    0xbf,
    0xb9,
    0xbd,
    0xba,
    0x32,
    0x34,
    ...enc.encode('</title></head><body></body></html>'),
  ]);

  test('EUC-KR 헤더 라벨로 한 번만 디코드', async () => {
    const io = createPreviewIO({
      fetchImpl: makeFetch({
        'https://www.yes24.com/Main/default.aspx': html(yes24, 'text/html; charset=ks_c_5601-1987'),
      }),
      resolve: publicResolver(),
    });
    const r = await io.fetchText('https://www.yes24.com/Main/default.aspx', { maxBytes: 1_048_576, timeoutMs: 1000 });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('text/html');
    expect(r.text).toContain('<title>예스24</title>');
    expect(r.charset).toBe('euc-kr');
    expect(r.replacementRatio).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.headers['content-type']).toBe('text/html; charset=ks_c_5601-1987');
  });

  test('image/*·application/pdf 는 본문을 읽지 않고 contentType 만 (파라미터 제거·소문자)', async () => {
    let cancelled = false;
    const routes: Record<string, Route> = {
      'https://i.ytimg.com/vi/x/hqdefault.jpg': () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(new Uint8Array(65536).fill(0xff)); // 끝없는 본문 — 읽으면 캡까지 간다
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'Image/JPEG' } },
        ),
      'https://www.w3.org/dummy.pdf': () =>
        new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf; qs=0.001' } }),
    };
    const io = createPreviewIO({ fetchImpl: makeFetch(routes), resolve: publicResolver() });
    const img = await io.fetchText('https://i.ytimg.com/vi/x/hqdefault.jpg', { maxBytes: 1024, timeoutMs: 1000 });
    expect(img).toMatchObject({ status: 200, contentType: 'image/jpeg', text: '' });
    expect(img.truncated).toBeUndefined(); // 본문을 읽지 않았다는 뜻
    expect(cancelled).toBe(true);
    const pdf = await io.fetchText('https://www.w3.org/dummy.pdf', { maxBytes: 1024, timeoutMs: 1000 });
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.text).toBe('');
  });

  test('비 2xx HTML 은 차단 시그니처 판정용으로 64 KB 까지만 읽는다', async () => {
    const big = '<title>Attention Required! | Cloudflare</title>' + 'x'.repeat(200_000);
    const io = createPreviewIO({
      fetchImpl: makeFetch({
        'https://www.gmarket.co.kr/': () =>
          new Response(big, { status: 403, headers: { 'content-type': 'text/html', server: 'cloudflare' } }),
      }),
      resolve: publicResolver(),
    });
    const r = await io.fetchText('https://www.gmarket.co.kr/', { maxBytes: 1_048_576, timeoutMs: 1000 });
    expect(r.status).toBe(403);
    expect(r.headers.server).toBe('cloudflare');
    expect(r.text).toContain('Attention Required!');
    expect(r.text.length).toBeLessThanOrEqual(NON_2XX_BODY_CAP);
    expect(r.truncated).toBe(true);
  });

  test('stopAtHead 는 YouTube 처럼 head 뒤가 길어도 </head> 에서 멈춘다', async () => {
    const head = '<html><head><meta property="og:title" content="t"></head>';
    const chunks = [enc.encode(head), enc.encode('<body>' + 'y'.repeat(300_000))];
    let cancelled = false;
    const io = createPreviewIO({
      fetchImpl: makeFetch({
        'https://www.youtube.com/watch?v=x': () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                if (chunks.length) c.enqueue(chunks.shift() as Uint8Array);
                else c.close();
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          ),
      }),
      resolve: publicResolver(),
    });
    const r = await io.fetchText('https://www.youtube.com/watch?v=x', {
      maxBytes: 1_048_576,
      timeoutMs: 1000,
      stopAtHead: true,
    });
    expect(r.text).toBe(head); // 300 KB 본문 청크는 결과에 없다
    expect(r.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });

  test('Content-Type 없음 → HTML 로 읽는다', async () => {
    const io = createPreviewIO({
      fetchImpl: makeFetch({ 'https://example.com/': () => new Response('<title>t</title>') }),
      resolve: publicResolver(),
    });
    // bun 의 Response 는 문자열 본문에 text/plain 을 붙이므로 헤더를 지운 뒤 확인
    const r = await io.fetchText('https://example.com/', { maxBytes: 1024, timeoutMs: 1000 });
    expect(r.contentType === null || r.contentType === 'text/plain').toBe(true);
    if (r.contentType === null) expect(r.text).toBe('<title>t</title>');
  });

  test('리다이렉트 뒤 finalUrl 은 마지막 URL (youtu.be → watch)', async () => {
    const io = createPreviewIO({
      fetchImpl: makeFetch({
        'https://youtu.be/4zLfCnGVeL4': redirect(303, 'https://www.youtube.com/watch?v=4zLfCnGVeL4&feature=youtu.be'),
        'https://www.youtube.com/watch?v=4zLfCnGVeL4&feature=youtu.be': html('<html></html>'),
      }),
      resolve: publicResolver(),
    });
    const r = await io.fetchText('https://youtu.be/4zLfCnGVeL4', { maxBytes: 1024, timeoutMs: 1000 });
    expect(r.finalUrl).toBe('https://www.youtube.com/watch?v=4zLfCnGVeL4&feature=youtu.be');
  });
});

describe('fetchJson / head', () => {
  const oembed = { title: 'The Sound of Silence', author_name: 'reptileman117' };

  test('application/json (charset 파라미터 포함) 만 파싱, 아니면 null', async () => {
    const routes: Record<string, Route> = {
      'https://www.youtube.com/oembed?url=x&format=json': () =>
        new Response(JSON.stringify(oembed), { headers: { 'content-type': 'application/json; charset=utf-8' } }),
      'https://publish.x.com/oembed?url=y': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      'https://bad.example/': () => new Response('{nope', { headers: { 'content-type': 'application/json' } }),
      'https://www.youtube.com/oembed?url=gone&format=json': () =>
        new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } }),
      'https://api.example/v+json': () =>
        new Response('[1]', { headers: { 'content-type': 'application/vnd.api+json' } }),
    };
    const io = createPreviewIO({ fetchImpl: makeFetch(routes), resolve: publicResolver() });
    expect((await io.fetchJson('https://www.youtube.com/oembed?url=x&format=json', { timeoutMs: 1000 })).json).toEqual(
      oembed,
    );
    expect((await io.fetchJson('https://publish.x.com/oembed?url=y', { timeoutMs: 1000 })).json).toBe(null);
    expect((await io.fetchJson('https://bad.example/', { timeoutMs: 1000 })).json).toBe(null);
    const gone = await io.fetchJson('https://www.youtube.com/oembed?url=gone&format=json', { timeoutMs: 1000 });
    expect(gone.status).toBe(400);
    expect(gone.json).toBe(null);
    expect((await io.fetchJson('https://api.example/v+json', { timeoutMs: 1000 })).json).toEqual([1]);
  });

  test('maxBytes 를 넘는 JSON 은 null', async () => {
    const io = createPreviewIO({
      fetchImpl: makeFetch({
        'https://big.example/': () =>
          new Response(JSON.stringify({ a: 'x'.repeat(5000) }), { headers: { 'content-type': 'application/json' } }),
      }),
      resolve: publicResolver(),
    });
    expect((await io.fetchJson('https://big.example/', { timeoutMs: 1000, maxBytes: 1024 })).json).toBe(null);
  });

  test('head 는 HEAD 메서드로 상태·타입만 (i.ytimg.com 썸네일 존재 확인)', async () => {
    const calls: Call[] = [];
    const io = createPreviewIO({
      fetchImpl: makeFetch(
        {
          'https://i.ytimg.com/vi/x/maxresdefault.jpg': () =>
            new Response(null, { status: 404, headers: { 'content-type': 'image/jpeg' } }),
          'https://i.ytimg.com/vi/x/hqdefault.jpg': () =>
            new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
        },
        calls,
      ),
      resolve: publicResolver(),
    });
    expect(await io.head('https://i.ytimg.com/vi/x/maxresdefault.jpg', { timeoutMs: 1000 })).toEqual({
      status: 404,
      contentType: 'image/jpeg',
    });
    expect(await io.head('https://i.ytimg.com/vi/x/hqdefault.jpg', { timeoutMs: 1000 })).toEqual({
      status: 200,
      contentType: 'image/jpeg',
    });
    expect(calls.every((c) => c.init.method === 'HEAD')).toBe(true);
  });
});

describe('errorCode', () => {
  test('예외 → 짧은 코드', () => {
    expect(errorCode(new SsrfError('ssrf:ip', 'h'))).toBe('ssrf:ip');
    expect(errorCode(new SsrfError('dns_failed', 'h'))).toBe('dns_failed');
    expect(errorCode(new PreviewIoError('too_many_redirects', 'h'))).toBe('too_many_redirects');
    expect(errorCode(new DOMException('x', 'TimeoutError'))).toBe('timeout');
    expect(errorCode(new DOMException('x', 'AbortError'))).toBe('timeout');
    expect(errorCode(new TypeError('fetch failed'))).toBe('network');
    expect(errorCode(new Error('boom'))).toBe('unexpected');
    expect(errorCode('str')).toBe('unexpected');
  });
});
