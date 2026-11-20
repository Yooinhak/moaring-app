// process.ts · sites/index.ts 테스트 — 가짜 service_role 클라이언트 + 가짜 io 로 claim → run → UPDATE 전 경로를 돌린다.
// globalThis.fetch 는 던지는 스텁으로 바꿔 둔다: 어떤 경로도 실제 네트워크에 닿으면 안 된다 (이미지 복사는 imageDeps 로 주입).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  applyAssist,
  applyCaptionPolicy,
  isPermanentFailure,
  isSameSiteUrl,
  mergeDeviceFields,
  processManyWithBudget,
  processPost,
  sanitizeDeviceHints,
  CANONICAL_REUSE_MS,
  DEVICE_HTML_MAX_CHARS,
} from '../process.ts';
import type { ProcessAdminClient, QueryError } from '../process.ts';
import { ADAPTERS, PARSERS, parseSubmittedHtml, resolveAdapter } from '../sites/index.ts';
import { genericAdapter } from '../sites/generic.ts';
import type { ClaimRow, FetchTextResult, PreviewIO, ResultEntry } from '../types.ts';

// ---------------------------------------------------------------------------
// 가짜 클라이언트 — 체인 가능한 빌더 하나가 posts·tombstone 질의를 다 받는다
// ---------------------------------------------------------------------------

interface UpdateCall {
  id: unknown;
  values: Record<string, unknown>;
}

interface FakeDb {
  /** claim_post_preview 결과. null = 0행. */
  claim?: (postId: number, force: boolean) => ClaimRow | null;
  /** id 로 조회되는 행 (skippedEntry 용). */
  rows?: Record<number, Record<string, unknown>>;
  /** canonical 재활용 후보 행. */
  donor?: Record<string, unknown> | null;
  /** UPDATE 가 돌려줄 에러 (첫 n회). */
  updateErrors?: QueryError[];
  rpcError?: QueryError;
}

interface FakeCalls {
  rpc: Array<{ fn: string; args: Record<string, unknown> | undefined }>;
  updates: UpdateCall[];
  selects: Array<{ table: string; filters: Record<string, unknown> }>;
  uploads: string[];
  copies: Array<{ from: string; to: string }>;
  removes: string[][];
}

function fakeAdmin(db: FakeDb = {}): { client: ProcessAdminClient; calls: FakeCalls } {
  const calls: FakeCalls = { rpc: [], updates: [], selects: [], uploads: [], copies: [], removes: [] };
  const updateErrors = [...(db.updateErrors ?? [])];

  function builder(table: string) {
    const state = { op: 'select', values: {} as Record<string, unknown>, filters: {} as Record<string, unknown> };
    const b: Record<string, unknown> = {};
    const chain =
      (fn: () => void) =>
      (...args: unknown[]) => {
        void args;
        fn();
        return b;
      };
    b.select = (columns: string) => {
      state.op = 'select';
      state.values = { columns };
      return b;
    };
    b.update = (values: Record<string, unknown>) => {
      state.op = 'update';
      state.values = values;
      return b;
    };
    b.delete = chain(() => {
      state.op = 'delete';
    });
    b.eq = (column: string, value: unknown) => {
      state.filters[column] = value;
      return b;
    };
    b.neq = (column: string, value: unknown) => {
      state.filters[`neq:${column}`] = value;
      return b;
    };
    b.in = (column: string, values: unknown[]) => {
      state.filters[`in:${column}`] = values;
      return b;
    };
    b.gte = (column: string, value: unknown) => {
      state.filters[`gte:${column}`] = value;
      return b;
    };
    b.order = chain(() => undefined);
    b.limit = chain(() => undefined);
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: QueryError | null } = { data: null, error: null };
      if (table === 'posts') {
        if (state.op === 'update') {
          calls.updates.push({ id: state.filters.id, values: state.values });
          result = { data: null, error: updateErrors.shift() ?? null };
        } else if (state.op === 'select') {
          calls.selects.push({ table, filters: { ...state.filters } });
          if ('preview_canonical_url' in state.filters) {
            result = { data: db.donor ? [db.donor] : [], error: null };
          } else {
            const row = db.rows?.[Number(state.filters.id)];
            result = { data: row ? [row] : [], error: null };
          }
        }
      } else if (table === 'preview_image_tombstones') {
        result = { data: state.op === 'select' ? [] : null, error: null };
      }
      return Promise.resolve(result).then(resolve, reject);
    };
    return b;
  }

  const bucket = {
    async upload(path: string) {
      calls.uploads.push(path);
      return { data: { path }, error: null };
    },
    getPublicUrl(path: string) {
      return { data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/link-previews/${path}` } };
    },
    async copy(from: string, to: string) {
      calls.copies.push({ from, to });
      return { data: { path: to }, error: null };
    },
    async remove(paths: string[]) {
      calls.removes.push(paths);
      return { data: [], error: null };
    },
  };

  const client = {
    storage: { from: () => bucket },
    from: (table: string) => builder(table),
    async rpc(fn: string, args?: Record<string, unknown>) {
      calls.rpc.push({ fn, args });
      if (db.rpcError) return { data: null, error: db.rpcError };
      if (fn === 'claim_post_preview') {
        const row = db.claim?.(Number(args?.p_post_id), args?.p_force === true) ?? null;
        return { data: row ? [row] : [], error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  } as unknown as ProcessAdminClient;

  return { client, calls };
}

function claimRow(url: string, extra: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 42,
    url,
    folder_id: 7,
    group_id: 'g-1',
    attempts: 1,
    prev_image_path: null,
    hint_title: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 가짜 io
// ---------------------------------------------------------------------------

interface IoCall {
  method: string;
  url: string;
}

function fakeIo(text?: (url: string) => FetchTextResult): { io: PreviewIO; calls: IoCall[] } {
  const calls: IoCall[] = [];
  const io: PreviewIO = {
    async fetchText(url) {
      calls.push({ method: 'fetchText', url });
      if (!text) throw new Error(`unexpected fetchText ${url}`);
      return text(url);
    },
    async fetchJson(url) {
      calls.push({ method: 'fetchJson', url });
      throw new Error(`unexpected fetchJson ${url}`);
    },
    async head(url) {
      calls.push({ method: 'head', url });
      throw new Error(`unexpected head ${url}`);
    },
    async resolveRedirects(url) {
      calls.push({ method: 'resolveRedirects', url });
      throw new Error(`unexpected resolveRedirects ${url}`);
    },
  };
  return { io, calls };
}

const html = (status: number, body: string, finalUrl: string): FetchTextResult => ({
  status,
  finalUrl,
  contentType: 'text/html',
  text: body,
  headers: { server: 'nginx' },
  charset: 'utf-8',
  replacementRatio: 0,
});

const GITHUB_HTML = `<html><head><title>GitHub - expo/expo</title>
<meta property="og:title" content="GitHub - expo/expo: An open-source framework" />
<meta property="og:description" content="An open-source framework for making universal native apps with React." />
<meta property="og:site_name" content="GitHub" />
<meta property="og:url" content="https://github.com/expo/expo" />
</head><body>…</body></html>`;

const GITHUB_HTML_WITH_IMAGE = GITHUB_HTML.replace(
  '</head>',
  '<meta property="og:image" content="https://img.example.com/expo.jpg" /></head>',
);

/** 12바이트 이상의 JPEG 매직바이트 — image.ts sniffImage 가 받는 최소 조건. Response 본문으로 쓰려고 ArrayBuffer 로 준다. */
function jpegBytes(): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
    .buffer as ArrayBuffer;
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error('network access is forbidden in process.test.ts');
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// 레지스트리
// ---------------------------------------------------------------------------

describe('sites/index registry', () => {
  test('generic is last and every adapter has a provider id', () => {
    expect(ADAPTERS[ADAPTERS.length - 1]).toBe(genericAdapter);
    for (const a of ADAPTERS) {
      expect(typeof a.id).toBe('string');
      expect(a.id.length).toBeGreaterThan(0);
      expect(typeof a.serverFetch).toBe('boolean');
    }
  });

  const cases: Array<[string, string]> = [
    ['https://link.coupang.com/a/cXYZ', 'coupang'],
    ['https://www.coupang.com/vp/products/123?itemId=1&vendorItemId=2', 'coupang'],
    ['https://blog.naver.com/naverofficial/224464411656', 'naver_blog'],
    ['https://n.news.naver.com/mnews/article/001/0015000000', 'naver_news'],
    ['https://map.naver.com/p/entry/place/1234567', 'naver_map'],
    ['https://smartstore.naver.com/storeid/products/1234', 'naver_shop'],
    ['https://cafe.naver.com/joonggonara/1119896688', 'naver_cafe'],
    ['https://naver.me/GYywEiT4', 'naver_me'],
    ['https://www.instagram.com/reel/DI3R5NfBWn_/?igsh=abc', 'instagram'],
    ['https://www.threads.com/@zuck/post/C8abc', 'threads'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube'],
    ['https://x.com/jack/status/20', 'x'],
    ['https://www.tiktok.com/@khaby.lame/video/6961405079870115077', 'tiktok'],
    ['https://place.map.kakao.com/18722401', 'kakao_place'],
    ['https://brunch.co.kr/@author/12', 'brunch'],
    ['https://www.musinsa.com/products/2705776', 'blocked'],
    ['https://medium.com/@user/some-title-1a2b3c4d5e6f', 'slug'],
    ['https://www.reddit.com/r/korea/comments/abc/title/', 'reddit'],
    ['https://www.pinterest.com/pin/1234567890/', 'pinterest'],
    ['https://www.facebook.com/somepage/posts/123', 'facebook'],
    ['https://www.linkedin.com/posts/someone_activity-123', 'linkedin'],
    ['https://vimeo.com/76979871', 'oembed'],
    ['https://github.com/expo/expo', 'generic'],
    ['https://www.yes24.com/Product/Goods/197808669', 'generic'],
  ];
  for (const [url, id] of cases) {
    test(`resolveAdapter(${new URL(url).hostname}) → ${id}`, () => {
      expect(resolveAdapter(new URL(url)).id).toBe(id);
    });
  }

  test('PARSERS covers every ClientParser key and tolerates garbage', () => {
    expect(Object.keys(PARSERS).sort()).toEqual(['generic', 'instagram_embed', 'tiktok_ssr']);
    expect(PARSERS.generic('', 'https://example.com/')).toBe(null);
    expect(PARSERS.instagram_embed('<html></html>', 'https://www.instagram.com/p/x/')).toBe(null);
    expect(PARSERS.tiktok_ssr('<html></html>', 'https://www.tiktok.com/')).toBe(null);
    expect(PARSERS.generic(GITHUB_HTML, 'https://github.com/expo/expo')?.title).toBe(
      'GitHub - expo/expo: An open-source framework',
    );
  });

  test('parseSubmittedHtml never throws and falls back to generic when the adapter has no parser', () => {
    const noParser = { ...genericAdapter, parseSubmitted: undefined };
    expect(parseSubmittedHtml(noParser, GITHUB_HTML, 'https://github.com/expo/expo')?.siteName).toBe('GitHub');
    const throwing = {
      ...genericAdapter,
      parseSubmitted: () => {
        throw new Error('boom');
      },
    };
    expect(parseSubmittedHtml(throwing, GITHUB_HTML, 'https://github.com/expo/expo')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// device 힌트 정제
// ---------------------------------------------------------------------------

describe('sanitizeDeviceHints', () => {
  test('drops http image, strips hash, caps html, removes control chars', () => {
    const d = sanitizeDeviceHints({
      title: ' Hello\u0000 World ',
      description: 'line1\r\n\r\nline2',
      author: 'a',
      image_url: 'http://insecure.example.com/a.jpg',
      canonical_url: 'https://example.com/post?utm_source=x&id=1#frag',
      html: 'x'.repeat(DEVICE_HTML_MAX_CHARS + 10),
      blocked: false,
      http_status: 200,
    });
    expect(d?.title).toBe('Hello World');
    expect(d?.description).toBe('line1\nline2');
    expect(d?.imageUrl).toBe(null);
    expect(d?.canonicalUrl).toBe('https://example.com/post?id=1');
    expect(d?.html?.length).toBe(DEVICE_HTML_MAX_CHARS);
    expect(d?.blocked).toBe(false);
    expect(d?.httpStatus).toBe(200);
  });

  test('keeps https image without fragment; non-object → null', () => {
    const d = sanitizeDeviceHints({ image_url: 'https://cdn.example.com/a.jpg#x', blocked: true, http_status: 403 });
    expect(d?.imageUrl).toBe('https://cdn.example.com/a.jpg');
    expect(d?.blocked).toBe(true);
    expect(sanitizeDeviceHints(null)).toBe(null);
    expect(sanitizeDeviceHints('nope' as never)).toBe(null);
  });

  test('mergeDeviceFields fills blanks only and appends the device image last', () => {
    const merged = mergeDeviceFields(
      {
        title: 'server',
        description: null,
        author: null,
        siteName: 'S',
        canonicalUrl: 'https://s/',
        imageCandidates: ['https://a/1.jpg'],
      },
      sanitizeDeviceHints({ title: 'device', description: 'd', image_url: 'https://b/2.jpg' }),
    );
    expect(merged.title).toBe('server');
    expect(merged.description).toBe('d');
    expect(merged.imageCandidates).toEqual(['https://a/1.jpg', 'https://b/2.jpg']);
  });

  test('isPermanentFailure', () => {
    expect(isPermanentFailure('ssrf:ip')).toBe(true);
    expect(isPermanentFailure('too_many_redirects')).toBe(true);
    expect(isPermanentFailure('timeout')).toBe(false);
    expect(isPermanentFailure('http_5xx')).toBe(false);
  });

  test('applyCaptionPolicy drops description only for instagram without storeCaption', () => {
    const instagram = resolveAdapter(new URL('https://www.instagram.com/reel/DI3R5NfBWn_/'));
    const d = sanitizeDeviceHints({
      title: 't',
      description: '캡션 전체',
      image_url: 'https://cdn.example.com/a.jpg',
    })!;
    expect(applyCaptionPolicy(d, instagram, false)).toMatchObject({
      title: 't',
      description: null,
      imageUrl: d.imageUrl,
    });
    expect(applyCaptionPolicy(d, instagram, true)).toBe(d);
    expect(applyCaptionPolicy(d, genericAdapter, false)).toBe(d);
    expect(applyCaptionPolicy(null, instagram, false)).toBe(null);
  });

  test('isSameSiteUrl ignores www./m. and accepts subdomains at a dot boundary only', () => {
    expect(isSameSiteUrl('https://www.example.com/a', 'https://example.com/b')).toBe(true);
    expect(isSameSiteUrl('https://m.blog.naver.com/x/1', 'https://blog.naver.com/x/1')).toBe(true);
    expect(isSameSiteUrl('https://shop.example.com/p', 'https://example.com/p')).toBe(true);
    expect(isSameSiteUrl('https://notexample.com/p', 'https://example.com/p')).toBe(false);
    expect(isSameSiteUrl('https://www.youtube.com/watch?v=x', 'https://youtu.be/x')).toBe(false);
    expect(isSameSiteUrl('javascript:alert(1)', 'https://example.com/')).toBe(false);
    expect(isSameSiteUrl(null, 'https://example.com/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processPost
// ---------------------------------------------------------------------------

describe('processPost', () => {
  test('claim 0 rows → skipped, no UPDATE, no io', async () => {
    const { client, calls } = fakeAdmin({
      claim: () => null,
      rows: { 42: { preview_status: 'fetching', preview_attempts: 1 } },
    });
    const { io, calls: ioCalls } = fakeIo();
    const r = await processPost(client, io, 42);
    expect(r).toEqual({ post_id: 42, status: 'fetching', skipped: 'in_progress' });
    expect(calls.updates).toHaveLength(0);
    expect(ioCalls).toHaveLength(0);
    expect(calls.rpc[0]).toEqual({ fn: 'claim_post_preview', args: { p_post_id: 42, p_force: false } });
  });

  test('claim 0 rows on failed row → max_attempts; missing row → not_found', async () => {
    const a = fakeAdmin({ claim: () => null, rows: { 42: { preview_status: 'failed', preview_attempts: 3 } } });
    expect((await processPost(a.client, fakeIo().io, 42)).skipped).toBe('max_attempts');
    const b = fakeAdmin({ claim: () => null });
    expect(await processPost(b.client, fakeIo().io, 42)).toEqual({
      post_id: 42,
      status: 'failed',
      skipped: 'not_found',
    });
  });

  test('claim RPC error → failed claim_failed without touching the row', async () => {
    const { client, calls } = fakeAdmin({ rpcError: { message: 'function does not exist' } });
    const r = await processPost(client, fakeIo().io, 42);
    expect(r).toEqual({ post_id: 42, status: 'failed', error: 'claim_failed' });
    expect(calls.updates).toHaveLength(0);
  });

  test('generic og page → single UPDATE ready/og with provider, canonical, fetched_at, claimed_at null', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://github.com/expo/expo?utm_source=share') });
    const { io, calls: ioCalls } = fakeIo((url) => html(200, GITHUB_HTML, url));
    const now = Date.parse('2026-11-04T10:00:00.000Z');
    const r = await processPost(client, io, 42, { now: () => now });

    expect(r.status).toBe('ready');
    expect(r.source).toBe('og');
    expect(r.error).toBe(null);
    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0].url).toBe('https://github.com/expo/expo'); // utm 제거된 fetchUrl
    expect(calls.updates).toHaveLength(1);
    const u = calls.updates[0];
    expect(u.id).toBe(42);
    expect(u.values).toMatchObject({
      preview_title: 'GitHub - expo/expo: An open-source framework',
      preview_description: 'An open-source framework for making universal native apps with React.',
      preview_site_name: 'GitHub',
      preview_canonical_url: 'https://github.com/expo/expo',
      preview_provider: 'generic',
      preview_source: 'og',
      preview_status: 'ready',
      preview_error: null,
      preview_image_url: null,
      preview_image_path: null,
      preview_fetched_at: '2026-11-04T10:00:00.000Z',
      preview_claimed_at: null,
      preview_assisted_by: null,
    });
    // canonical 재활용 조회가 먼저 있었다 (비-force)
    expect(calls.selects.some((s) => 'preview_canonical_url' in s.filters)).toBe(true);
  });

  test('image candidates are copied through image.ts (fake fetch) and stored as https Storage URL', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://github.com/expo/expo') });
    const { io } = fakeIo((url) => html(200, GITHUB_HTML_WITH_IMAGE, url));
    const fetched: string[] = [];
    const r = await processPost(client, io, 42, {
      imageDeps: {
        resolve: async () => ['93.184.216.34'],
        fetchImpl: async (input) => {
          fetched.push(input);
          return new Response(jpegBytes(), { status: 200, headers: { 'content-type': 'image/jpeg' } });
        },
      },
    });
    expect(r.status).toBe('ready');
    expect(fetched).toEqual(['https://img.example.com/expo.jpg']);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]).toMatch(/^posts\/42\/[0-9a-f]{16}\.jpg$/);
    const v = calls.updates[0].values;
    expect(String(v.preview_image_url)).toMatch(/^https:\/\/example\.supabase\.co\/.*\/posts\/42\//);
    expect(v.preview_image_path).toBe(calls.uploads[0]);
    expect(v.preview_image_src).toBe('https://img.example.com/expo.jpg');
    expect(v.preview_error).toBe(null);
  });

  test('image failure is not a status failure: ready + image:<reason> + image_src kept', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://github.com/expo/expo') });
    const { io } = fakeIo((url) => html(200, GITHUB_HTML_WITH_IMAGE, url));
    const r = await processPost(client, io, 42, {
      imageDeps: {
        resolve: async () => ['93.184.216.34'],
        fetchImpl: async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
      },
    });
    expect(r.status).toBe('ready');
    expect(r.error).toBe('image:http_404');
    const v = calls.updates[0].values;
    expect(v.preview_image_url).toBe(null);
    expect(v.preview_image_src).toBe('https://img.example.com/expo.jpg');
    expect(calls.uploads).toHaveLength(0);
  });

  test('serverFetch:false adapter (musinsa) → needs_client with brand fields, hint title, client_task, zero io', async () => {
    const { client, calls } = fakeAdmin({
      claim: () => claimRow('https://www.musinsa.com/products/2705776', { hint_title: '  나이키  에어포스 ' }),
    });
    const { io, calls: ioCalls } = fakeIo();
    const r = await processPost(client, io, 42);
    expect(ioCalls).toHaveLength(0);
    expect(r.status).toBe('needs_client');
    expect(r.error).toBe('blocked:cloudflare');
    expect(r.client_task).toEqual({
      post_id: 42,
      folder_id: 7,
      runner: 'fetch',
      parser: 'generic',
      url: 'https://www.musinsa.com/products/2705776',
    });
    expect(calls.updates[0].values).toMatchObject({
      preview_status: 'needs_client',
      preview_provider: 'blocked',
      preview_site_name: '무신사',
      preview_title: '나이키 에어포스',
      preview_source: 'hint', // 어댑터가 ctx.hintTitle 을 직접 썼어도 출처는 hint
      preview_error: 'blocked:cloudflare',
      preview_claimed_at: null,
    });
  });

  test('device hints promote a blocked server result to ready/device; without content it stays needs_client', async () => {
    const a = fakeAdmin({ claim: () => claimRow('https://www.musinsa.com/products/2705776') });
    const r1 = await processPost(a.client, fakeIo().io, 42, {
      device: { title: '폰이 받은 상품명', description: '설명' },
    });
    expect(r1.status).toBe('ready');
    expect(r1.source).toBe('device');
    expect(r1.client_task).toBeUndefined();
    expect(a.calls.updates[0].values).toMatchObject({
      preview_status: 'ready',
      preview_source: 'device',
      preview_title: '폰이 받은 상품명',
      preview_site_name: '무신사', // 서버 브랜드 라벨은 유지
      preview_error: null,
    });

    const b = fakeAdmin({ claim: () => claimRow('https://www.musinsa.com/products/2705776') });
    const r2 = await processPost(b.client, fakeIo().io, 42, { device: { author: 'only-author', blocked: false } });
    expect(r2.status).toBe('needs_client');
    expect(b.calls.updates[0].values.preview_author).toBe('only-author');
  });

  test('instagram: device description is dropped unless storeCaption (§10-2 holds regardless of client)', async () => {
    const timeoutIo = (): PreviewIO => ({
      ...fakeIo().io,
      async fetchText() {
        const e = new Error('t') as Error & { name: string };
        e.name = 'TimeoutError';
        throw e;
      },
    });
    const device = { title: '폰 제목', description: '캡션 전체 문장입니다' };

    const a = fakeAdmin({ claim: () => claimRow('https://www.instagram.com/reel/DI3R5NfBWn_/?igsh=abc') });
    const r1 = await processPost(a.client, timeoutIo(), 42, { device });
    expect(r1.status).toBe('ready');
    expect(r1.source).toBe('device');
    expect(a.calls.updates[0].values).toMatchObject({
      preview_provider: 'instagram',
      preview_title: '폰 제목',
      preview_description: null,
    });

    const b = fakeAdmin({ claim: () => claimRow('https://www.instagram.com/reel/DI3R5NfBWn_/?igsh=abc') });
    await processPost(b.client, timeoutIo(), 42, { device, storeCaption: true });
    expect(b.calls.updates[0].values.preview_description).toBe('캡션 전체 문장입니다');

    // 다른 어댑터는 그대로 — 무신사(serverFetch:false) 는 폰 설명을 저장한다
    const c = fakeAdmin({ claim: () => claimRow('https://www.musinsa.com/products/2705776') });
    await processPost(c.client, fakeIo().io, 42, { device });
    expect(c.calls.updates[0].values.preview_description).toBe('캡션 전체 문장입니다');
  });

  test('blocked device hints never promote nor override the placeholder title', async () => {
    const a = fakeAdmin({ claim: () => claimRow('https://www.musinsa.com/products/2705776') });
    const r = await processPost(a.client, fakeIo().io, 42, { device: { title: 'x', blocked: true, http_status: 403 } });
    expect(r.status).toBe('needs_client');
    expect(a.calls.updates[0].values.preview_title).toBe('무신사 상품 2705776');
  });

  test('ready server result keeps its own title; device only fills blanks', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://github.com/expo/expo') });
    const { io } = fakeIo((url) => html(200, GITHUB_HTML, url));
    await processPost(client, io, 42, { device: { title: 'phone title', author: 'phone author' } });
    expect(calls.updates[0].values).toMatchObject({
      preview_title: 'GitHub - expo/expo: An open-source framework',
      preview_author: 'phone author',
      preview_source: 'og',
    });
  });

  test('hint title fills a missing server title with source hint', async () => {
    const shell =
      '<html><head><title>Example</title></head><body><div id="root"></div><noscript>enable js</noscript></body></html>';
    const { client, calls } = fakeAdmin({
      claim: () => claimRow('https://example.com/app/123', { hint_title: '공유 텍스트 제목' }),
    });
    const { io } = fakeIo((url) => html(200, shell, url));
    const r = await processPost(client, io, 42);
    expect(r.status).toBe('needs_client');
    expect(r.error).toBe('needs:webview');
    expect(r.client_task?.runner).toBe('webview');
    expect(calls.updates[0].values).toMatchObject({ preview_title: '공유 텍스트 제목', preview_source: 'hint' });
  });

  test('404 → unsupported gone; 5xx → failed http_5xx; ssrf code → unsupported', async () => {
    const run = async (res: (url: string) => FetchTextResult) => {
      const a = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
      const r = await processPost(a.client, fakeIo(res).io, 42);
      return { r, values: a.calls.updates[0].values };
    };
    const gone = await run((url) => html(404, '<html><head><title>Not Found</title></head></html>', url));
    expect(gone.r.status).toBe('unsupported');
    expect(gone.r.error).toBe('gone');
    expect(gone.values.preview_title).toBe(null); // 비 2xx 본문은 저장되지 않는다

    const five = await run((url) => html(503, '', url));
    expect(five.r.status).toBe('failed');
    expect(five.r.error).toBe('http_5xx');

    const a = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
    const io: PreviewIO = {
      ...fakeIo().io,
      async fetchText() {
        const e = new Error('blocked') as Error & { code: string };
        e.code = 'ssrf:ip';
        throw e;
      },
    };
    const r = await processPost(a.client, io, 42);
    expect(r.status).toBe('unsupported');
    expect(r.error).toBe('ssrf:ip');
  });

  test('invalid posts.url → unsupported bad_url, still through claim and a single UPDATE', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('vnd.youtube://watch?v=x', { hint_title: 'hint' }) });
    const r = await processPost(client, fakeIo().io, 42);
    expect(r.status).toBe('unsupported');
    expect(r.error).toBe('bad_url');
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].values).toMatchObject({
      preview_title: 'hint',
      preview_source: 'hint',
      preview_claimed_at: null,
    });
  });

  test('canonical reuse: donor in the same group → ready without io, storage.copy to the post path', async () => {
    const { client, calls } = fakeAdmin({
      claim: () => claimRow('https://github.com/expo/expo?utm_source=a'),
      donor: {
        id: 41,
        preview_title: 'Donor title',
        preview_description: 'Donor desc',
        preview_author: null,
        preview_site_name: 'GitHub',
        preview_image_path: 'posts/41/0123456789abcdef.jpg',
        preview_image_src: 'https://img.example.com/expo.jpg',
        preview_provider: 'generic',
        preview_source: 'og',
      },
    });
    const { io, calls: ioCalls } = fakeIo();
    const now = Date.now();
    const r = await processPost(client, io, 42, { now: () => now });
    expect(ioCalls).toHaveLength(0);
    expect(r.status).toBe('ready');
    expect(calls.copies).toEqual([{ from: 'posts/41/0123456789abcdef.jpg', to: 'posts/42/0123456789abcdef.jpg' }]);
    expect(calls.updates[0].values).toMatchObject({
      preview_title: 'Donor title',
      preview_image_path: 'posts/42/0123456789abcdef.jpg',
      preview_image_src: 'https://img.example.com/expo.jpg',
      preview_canonical_url: 'https://github.com/expo/expo',
      preview_status: 'ready',
      preview_source: 'og',
    });
    const donorQuery = calls.selects.find((s) => 'preview_canonical_url' in s.filters)!;
    expect(donorQuery.filters.group_id).toBe('g-1');
    expect(donorQuery.filters['neq:id']).toBe(42);
    expect(Date.parse(String(donorQuery.filters['gte:preview_fetched_at']))).toBeGreaterThan(
      now - CANONICAL_REUSE_MS - 1000,
    );
  });

  test('force skips canonical reuse and claims with p_force', async () => {
    const { client, calls } = fakeAdmin({
      claim: () => claimRow('https://github.com/expo/expo'),
      donor: { id: 41, preview_title: 'Donor', preview_source: 'og' },
    });
    const { io, calls: ioCalls } = fakeIo((url) => html(200, GITHUB_HTML, url));
    await processPost(client, io, 42, { force: true });
    expect(calls.rpc[0].args).toEqual({ p_post_id: 42, p_force: true });
    expect(calls.selects.some((s) => 'preview_canonical_url' in s.filters)).toBe(false);
    expect(ioCalls).toHaveLength(1);
  });

  test('adapter.run throwing → failed with the error code', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
    const io: PreviewIO = {
      ...fakeIo().io,
      async fetchText() {
        const e = new Error('t') as Error & { name: string };
        e.name = 'TimeoutError';
        throw e;
      },
    };
    const r = await processPost(client, io, 42);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('timeout');
    expect(calls.updates[0].values.preview_status).toBe('failed');
  });

  test('UPDATE failure → fallback minimal failed UPDATE with unexpected: code', async () => {
    const { client, calls } = fakeAdmin({
      claim: () => claimRow('https://github.com/expo/expo'),
      updateErrors: [{ message: 'check constraint violated' }],
    });
    const { io } = fakeIo((url) => html(200, GITHUB_HTML, url));
    const r = await processPost(client, io, 42);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^unexpected:update: check constraint/);
    expect(calls.updates).toHaveLength(2);
    expect(calls.updates[1].values).toMatchObject({ preview_status: 'failed', preview_claimed_at: null });
    expect(Object.keys(calls.updates[1].values).sort()).toEqual(
      ['preview_claimed_at', 'preview_error', 'preview_fetched_at', 'preview_status'].sort(),
    );
  });

  test('ProviderCtx gets hintTitle and attempts from the claim', async () => {
    // LinkedIn /in/ 프로필은 네트워크 없이 hintTitle 을 제목으로 쓰는 unsupported — ctx 전달을 보여주는 가장 싼 경로
    const { client, calls } = fakeAdmin({
      claim: () => claimRow('https://www.linkedin.com/in/someone/', { hint_title: 'Some One', attempts: 2 }),
    });
    const r = await processPost(client, fakeIo().io, 42);
    expect(r.status).toBe('unsupported');
    expect(calls.updates[0].values).toMatchObject({ preview_title: 'Some One', preview_site_name: 'LinkedIn' });
  });
});

// ---------------------------------------------------------------------------
// processManyWithBudget
// ---------------------------------------------------------------------------

describe('processManyWithBudget', () => {
  test('returns finished entries, marks the rest in_progress and hands back the pending promise', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, calls } = fakeAdmin({
      claim: (id) => claimRow(id === 2 ? 'https://slow.example.com/x' : 'https://github.com/expo/expo', { id }),
    });
    const { io } = fakeIo((url) => html(200, GITHUB_HTML, url));
    const slowIo: PreviewIO = {
      ...io,
      async fetchText(url, opts) {
        if (url.startsWith('https://slow.')) await gate;
        return io.fetchText(url, opts);
      },
    };
    const budgeted = await processManyWithBudget(client, slowIo, [1, 2, 3], 200, { concurrency: 2 });
    const byId = new Map(budgeted.results.map((r) => [r.post_id, r]));
    expect(byId.get(1)?.status).toBe('ready');
    expect(byId.get(3)?.status).toBe('ready');
    expect(byId.get(2)).toEqual({ post_id: 2, status: 'fetching', skipped: 'in_progress' });
    expect(budgeted.pending).not.toBe(null);
    release();
    await budgeted.pending;
    expect(calls.updates.map((u) => u.id).sort()).toEqual([1, 2, 3]);
  });

  test('all done within budget → pending null and input order kept', async () => {
    const { client } = fakeAdmin({ claim: (id) => claimRow('https://github.com/expo/expo', { id }) });
    const { io } = fakeIo((url) => html(200, GITHUB_HTML, url));
    const budgeted = await processManyWithBudget(client, io, [5, 4, 5], 5_000);
    expect(budgeted.pending).toBe(null);
    expect(budgeted.results.map((r: ResultEntry) => r.post_id)).toEqual([5, 4]);
  });
});

// ---------------------------------------------------------------------------
// applyAssist
// ---------------------------------------------------------------------------

const IG_EMBED = `<html><body><div class="Embed">
<img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/v/t51.2885-15/a.jpg?oe=6900&amp;sig=1" />
<span class="UsernameText">jewvely_home</span>
<div class="Caption"><a class="CaptionUsername">jewvely_home</a><br />첫 줄 캡션입니다<br />둘째 줄<div class="CaptionComments">x</div></div>
</div></body></html>`;

describe('applyAssist', () => {
  test('blocked phone (http status) → failed needs:webview, partial UPDATE keeps brand fields', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://www.musinsa.com/products/2705776') });
    const r = await applyAssist(client, 42, { blocked: true, http_status: 403 }, 'user-1');
    expect(r).toEqual({ post_id: 42, status: 'failed', error: 'needs:webview' });
    expect(calls.rpc[0].args).toEqual({ p_post_id: 42, p_force: false });
    const v = calls.updates[0].values;
    expect(v).toMatchObject({
      preview_status: 'failed',
      preview_error: 'needs:webview',
      preview_assisted_by: 'user-1',
      preview_claimed_at: null,
    });
    expect('preview_title' in v).toBe(false);
    expect('preview_site_name' in v).toBe(false);
  });

  test('blocked phone without status on a generic site → device_blocked', async () => {
    const { client } = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
    const r = await applyAssist(client, 42, { blocked: true }, 'user-1');
    expect(r.error).toBe('device_blocked');
  });

  test('empty submission → failed device_empty (closes the loop)', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
    const r = await applyAssist(client, 42, { title: null, description: null, image_url: null }, 'user-1');
    expect(r).toEqual({ post_id: 42, status: 'failed', error: 'device_empty' });
    expect(calls.updates[0].values.preview_assisted_by).toBe('user-1');
  });

  test('instagram embed html is parsed by the adapter parser; device image is re-downloaded through imageHosts', async () => {
    const { client, calls } = fakeAdmin({
      claim: () => claimRow('https://www.instagram.com/reel/DI3R5NfBWn_/?igsh=abc'),
    });
    const fetched: string[] = [];
    const r = await applyAssist(
      client,
      42,
      { html: IG_EMBED, image_url: 'https://evil.example.com/tracker.gif' },
      'user-1',
      {
        imageDeps: {
          resolve: async () => ['157.240.1.1'],
          fetchImpl: async (input) => {
            fetched.push(input);
            return new Response(jpegBytes(), { status: 200, headers: { 'content-type': 'image/jpeg' } });
          },
        },
      },
    );
    expect(r.status).toBe('ready');
    expect(r.source).toBe('device');
    // evil.example.com 은 imageHosts(cdninstagram/fbcdn) 밖 — 요청조차 가지 않는다
    expect(fetched).toEqual(['https://scontent.cdninstagram.com/v/t51.2885-15/a.jpg?oe=6900&sig=1']);
    const v = calls.updates[0].values;
    expect(v).toMatchObject({
      preview_status: 'ready',
      preview_source: 'device',
      preview_provider: 'instagram',
      preview_title: '첫 줄 캡션입니다',
      preview_author: '@jewvely_home',
      preview_site_name: 'Instagram',
      preview_assisted_by: 'user-1',
      preview_claimed_at: null,
    });
    expect(String(v.preview_image_url)).toMatch(/^https:\/\//);
    expect(v.preview_description).toBeUndefined(); // storeCaption 기본 false → 설명은 건드리지 않는다
  });

  test('instagram assist: device description is ignored unless storeCaption', async () => {
    const hints = { html: IG_EMBED, description: '폰이 보낸 캡션 전체' };
    const a = fakeAdmin({ claim: () => claimRow('https://www.instagram.com/reel/DI3R5NfBWn_/') });
    const r = await applyAssist(a.client, 42, hints, 'user-1');
    expect(r.status).toBe('ready');
    expect(a.calls.updates[0].values.preview_title).toBe('첫 줄 캡션입니다');
    expect('preview_description' in a.calls.updates[0].values).toBe(false);

    const b = fakeAdmin({ claim: () => claimRow('https://www.instagram.com/reel/DI3R5NfBWn_/') });
    await applyAssist(b.client, 42, { description: '폰이 보낸 캡션 전체' }, 'user-1', { storeCaption: true });
    expect(b.calls.updates[0].values.preview_description).toBe('폰이 보낸 캡션 전체');
  });

  test('assist canonical: off-site device canonical/og:url is never written; same-site one is', async () => {
    // 공격: posts.url 은 example.com 인데 폰이 유튜브 canonical + 그 og:url 을 가진 HTML 을 제출 — findDonor 오염 시도
    const attack = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
    const r = await applyAssist(
      attack.client,
      42,
      {
        canonical_url: 'https://www.youtube.com/watch?v=REAL',
        html: `<html><head><meta property="og:url" content="https://www.youtube.com/watch?v=REAL" />
<meta property="og:title" content="fake title" /></head></html>`,
      },
      'user-1',
    );
    expect(r.status).toBe('ready');
    const v = attack.calls.updates[0].values;
    expect(v.preview_title).toBe('fake title'); // 제목은 editor 책임 — 그룹 전체로 전파되는 canonical 만 막는다
    expect('preview_canonical_url' in v).toBe(false);

    // 정상: www./m. 접두·추적 파라미터만 다른 같은 사이트 → 파서가 고른 canonical 을 저장
    const ok = fakeAdmin({ claim: () => claimRow('https://example.com/x?utm_source=share') });
    await applyAssist(
      ok.client,
      42,
      {
        canonical_url: 'https://m.example.com/x',
        html: `<html><head><meta property="og:url" content="https://www.example.com/x" />
<meta property="og:title" content="Real title" /></head></html>`,
      },
      'user-1',
    );
    expect(ok.calls.updates[0].values.preview_canonical_url).toBe('https://www.example.com/x');

    // 폰 canonical 만 다른 사이트인 경우: 파서 기준 URL 은 서버 canonical 로 돌아가고 og:url(같은 사이트) 은 그대로 인정
    const mixed = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
    await applyAssist(
      mixed.client,
      42,
      {
        canonical_url: 'https://attacker.example/x',
        html: `<html><head><meta property="og:url" content="https://example.com/x/" />
<meta property="og:title" content="T" /></head></html>`,
      },
      'user-1',
    );
    expect(mixed.calls.updates[0].values).toMatchObject({
      preview_status: 'ready',
      preview_canonical_url: 'https://example.com/x/',
    });
  });

  test('device fields only (no html): text stored, http image ignored, nothing else overwritten', async () => {
    const { client, calls } = fakeAdmin({ claim: () => claimRow('https://example.com/x') });
    const r = await applyAssist(client, 42, { title: 'Phone title', image_url: 'http://example.com/a.jpg' }, 'user-1');
    expect(r.status).toBe('ready');
    const v = calls.updates[0].values;
    expect(v.preview_title).toBe('Phone title');
    expect('preview_image_url' in v).toBe(false);
    expect('preview_site_name' in v).toBe(false);
    expect(v.preview_error).toBe(null);
  });

  test('claim 0 rows → skipped without UPDATE', async () => {
    const { client, calls } = fakeAdmin({
      claim: () => null,
      rows: { 42: { preview_status: 'ready', preview_attempts: 1 } },
    });
    const r = await applyAssist(client, 42, { title: 'x' }, 'user-1');
    expect(r.skipped).toBe('in_progress');
    expect(calls.updates).toHaveLength(0);
  });
});
