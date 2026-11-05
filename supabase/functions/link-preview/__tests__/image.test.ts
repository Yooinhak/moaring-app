// 실행: bun test supabase/functions/link-preview
// Storage·fetch·DNS 전부 가짜. 매직바이트 픽스처는 probes/edge-cases 의 실제 응답 앞부분 (ytimg JPEG, yes24 PNG, namu SVG, w3 PDF).
import { describe, expect, test } from 'bun:test';

import {
  buildStoragePath,
  copyExistingImage,
  copyImageToStorage,
  isStoragePath,
  removeTombstones,
  sha256Hex16,
  sniffImage,
  TOMBSTONE_TABLE,
} from '../image.ts';
import type { PreviewAdminClient, StorageError } from '../image.ts';
import type { FetchLike } from '../ssrf.ts';
import type { PreviewLogger } from '../types.ts';

const PUBLIC_V4 = '93.184.216.34';
const enc = new TextEncoder();
const PUBLIC_BASE = 'https://yvhyjxdxksdddunjmjdo.supabase.co/storage/v1/object/public/link-previews/';

// 실제 응답 앞 16바이트 (probes/edge-cases/*.bin) + 패딩
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 1, 2, 3,
]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 9,
]);
const GIF = enc.encode('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;');
const WEBP = new Uint8Array([...enc.encode('RIFF'), 0x24, 0, 0, 0, ...enc.encode('WEBPVP8 '), 0, 0, 0, 0]);
const AVIF = new Uint8Array([0, 0, 0, 0x1c, ...enc.encode('ftypavif'), 0, 0, 0, 0, ...enc.encode('avifmif1')]);
const SVG = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const PDF = enc.encode('%PDF-1.4\n%äüö some bytes');

interface FakeCalls {
  uploads: Array<{ path: string; size: number; type: string; options: Record<string, unknown> | undefined }>;
  copies: Array<[string, string]>;
  removes: string[][];
  deleteIn: string[][];
  deleteEq: string[];
  /** select(...).in(...) — GC 의 posts.preview_image_path 생존 확인. */
  selectIn: Array<{ table: string; column: string; values: string[] }>;
  tables: string[];
  /** DB·Storage 호출 순서 (GC 는 행 삭제 → 생존 확인 → remove 여야 한다). */
  events: string[];
}

interface FakeClientOptions {
  publicBase?: string;
  uploadError?: StorageError;
  copyError?: StorageError;
  removeError?: StorageError;
  selectError?: StorageError;
  deleteError?: StorageError;
  tombstoneRows?: Array<{ path: unknown }>;
  /** delete … RETURNING 이 돌려줄 행. 생략하면 요청한 경로를 그대로 돌려준다 (경합 없음). */
  deletedRows?: Array<{ path: unknown }>;
  /** posts 생존 확인이 돌려줄 행 (아직 어떤 글이 가리키는 경로). */
  liveRows?: Array<{ preview_image_path: unknown }>;
  liveError?: StorageError;
}

function fakeClient(opts: FakeClientOptions = {}): { client: PreviewAdminClient; calls: FakeCalls } {
  const calls: FakeCalls = {
    uploads: [],
    copies: [],
    removes: [],
    deleteIn: [],
    deleteEq: [],
    selectIn: [],
    tables: [],
    events: [],
  };
  const base = opts.publicBase ?? PUBLIC_BASE;
  const client: PreviewAdminClient = {
    storage: {
      from: (bucket) => {
        expect(bucket).toBe('link-previews');
        return {
          upload: async (path, body, options) => {
            calls.uploads.push({ path, size: body.size, type: body.type, options });
            return { data: { path }, error: opts.uploadError ?? null };
          },
          getPublicUrl: (path) => ({ data: { publicUrl: base + path } }),
          copy: async (from, to) => {
            calls.copies.push([from, to]);
            return { data: null, error: opts.copyError ?? null };
          },
          remove: async (paths) => {
            calls.removes.push(paths);
            calls.events.push('remove');
            return { data: [], error: opts.removeError ?? null };
          },
        };
      },
    },
    from: (table) => {
      calls.tables.push(table);
      return {
        select: () => ({
          order: () => ({
            limit: async () => {
              calls.events.push(`select:${table}`);
              return { data: opts.tombstoneRows ?? [], error: opts.selectError ?? null };
            },
          }),
          in: async (column, values) => {
            calls.selectIn.push({ table, column, values });
            calls.events.push(`select.in:${table}`);
            if (table !== 'posts') return { data: [], error: null };
            return { data: opts.liveRows ?? [], error: opts.liveError ?? null };
          },
        }),
        delete: () => ({
          in: (_col, values) => {
            calls.deleteIn.push(values);
            calls.events.push(`delete:${table}`);
            const error = opts.deleteError ?? null;
            return Object.assign(Promise.resolve({ data: null, error }), {
              select: async () => ({
                data: error ? null : (opts.deletedRows ?? values.map((path) => ({ path }))),
                error,
              }),
            });
          },
          eq: async (_col, value) => {
            calls.deleteEq.push(value);
            return { data: null, error: null };
          },
        }),
      };
    },
  };
  return { client, calls };
}

type Route = (init: RequestInit) => Response | Promise<Response>;

function makeFetch(routes: Record<string, Route>, calls: string[] = []): FetchLike {
  return async (url, init = {}) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new TypeError(`unrouted ${url}`);
    return await route(init);
  };
}

function image(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Route {
  return () => new Response(bytes, { status, headers: { 'content-type': contentType, ...extraHeaders } });
}

const resolve = async () => [PUBLIC_V4];

describe('sniffImage / 경로 규칙', () => {
  test('JPEG·PNG·GIF·WEBP·AVIF 는 매직바이트로, SVG·PDF·HTML·짧은 바이트는 null', () => {
    expect(sniffImage(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(sniffImage(GIF)).toEqual({ mime: 'image/gif', ext: 'gif' });
    expect(sniffImage(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' });
    expect(sniffImage(AVIF)).toEqual({ mime: 'image/avif', ext: 'avif' });
    expect(sniffImage(SVG)).toBe(null);
    expect(sniffImage(PDF)).toBe(null);
    expect(sniffImage(enc.encode('<!DOCTYPE html><html></html>'))).toBe(null);
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(null);
    // HEIC 브랜드는 AVIF 가 아니다 (버킷 allowed_mime_types 밖)
    expect(sniffImage(new Uint8Array([0, 0, 0, 0x18, ...enc.encode('ftypheic'), 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(null);
  });

  test('sha256 앞 16 hex 는 결정적', async () => {
    expect(await sha256Hex16(new Uint8Array(0))).toBe('e3b0c44298fc1c14');
    expect(await sha256Hex16(JPEG)).toBe(await sha256Hex16(new Uint8Array(JPEG)));
  });

  test('isStoragePath / buildStoragePath — 서버 형식만, 사용자 입력 자리 없음', () => {
    expect(isStoragePath('posts/42/e3b0c44298fc1c14.jpg')).toBe(true);
    expect(isStoragePath('posts/42/e3b0c44298fc1c14.svg')).toBe(false);
    expect(isStoragePath('posts/../42/e3b0c44298fc1c14.jpg')).toBe(false);
    expect(isStoragePath('posts/42/E3B0C44298FC1C14.jpg')).toBe(false);
    expect(isStoragePath('avatars/42/e3b0c44298fc1c14.jpg')).toBe(false);
    expect(buildStoragePath(42, 'e3b0c44298fc1c14', 'png')).toBe('posts/42/e3b0c44298fc1c14.png');
    expect(() => buildStoragePath(0, 'e3b0c44298fc1c14', 'png')).toThrow();
    expect(() => buildStoragePath(1.5, 'e3b0c44298fc1c14', 'png')).toThrow();
    expect(() => buildStoragePath(42, 'zz', 'png')).toThrow();
  });
});

describe('copyImageToStorage', () => {
  test('첫 후보 성공 — 경로·contentType·cacheControl·upsert·https URL·tombstone 되살림', async () => {
    const { client, calls } = fakeClient();
    const fetchCalls: string[] = [];
    const src = 'https://i.ytimg.com/vi/4zLfCnGVeL4/hqdefault.jpg';
    const r = await copyImageToStorage(client, 42, [src, 'https://other.example/b.png'], {
      fetchImpl: makeFetch({ [src]: image(JPEG, 'image/jpeg') }, fetchCalls),
      resolve,
    });
    const sha = await sha256Hex16(JPEG);
    const path = `posts/42/${sha}.jpg`;
    expect(r).toEqual({
      imageUrl: PUBLIC_BASE + path,
      imagePath: path,
      imageSrc: src,
      error: null,
      contentType: 'image/jpeg',
    });
    expect(calls.uploads).toEqual([
      {
        path,
        size: JPEG.length,
        type: 'image/jpeg',
        options: { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true },
      },
    ]);
    expect(fetchCalls).toEqual([src]); // 두 번째 후보는 시도하지 않는다
    expect(calls.deleteEq).toEqual([path]);
    expect(calls.tables).toEqual([TOMBSTONE_TABLE]);
  });

  test('nts.go.kr 처럼 404 text/html 인 og:image 는 건너뛰고 다음 후보 (PNG) 를 쓴다', async () => {
    const { client } = fakeClient();
    const dead = 'https://www.nts.go.kr/images/nts/layout/logo.png';
    const alive = 'https://image.yes24.com/sysimage/renew/og_YES24.png';
    const r = await copyImageToStorage(client, 7, [dead, alive], {
      fetchImpl: makeFetch({
        [dead]: image(enc.encode('<!DOCTYPE html><html>not found</html>'), 'text/html', 404),
        [alive]: image(PNG, 'image/png'),
      }),
      resolve,
    });
    expect(r.error).toBe(null);
    expect(r.imageSrc).toBe(alive);
    expect(r.imagePath).toMatch(/^posts\/7\/[0-9a-f]{16}\.png$/);
  });

  test('전부 실패 → null 들 + 첫 후보 + image:<첫 사유>', async () => {
    const { client, calls } = fakeClient();
    const svg = 'https://i.namu.wiki/i/x.svg';
    const htmlAsPng = 'https://cdn.example/fake.png';
    const r = await copyImageToStorage(client, 7, [svg, htmlAsPng], {
      fetchImpl: makeFetch({
        [svg]: image(SVG, 'image/svg+xml'),
        [htmlAsPng]: image(enc.encode('<!DOCTYPE html><html>x</html>'), 'image/png'),
      }),
      resolve,
    });
    expect(r).toEqual({ imageUrl: null, imagePath: null, imageSrc: svg, error: 'image:svg' });
    expect(calls.uploads).toHaveLength(0);
  });

  test('매직바이트 불일치는 bad_magic, 빈 본문은 empty, content-type 비이미지는 not_image', async () => {
    const { client } = fakeClient();
    const run = (url: string, route: Route) =>
      copyImageToStorage(client, 7, [url], { fetchImpl: makeFetch({ [url]: route }), resolve });
    expect((await run('https://a.example/1', image(enc.encode('<!DOCTYPE html>xxxxxxx'), 'image/png'))).error).toBe(
      'image:bad_magic',
    );
    expect((await run('https://a.example/2', image(new Uint8Array(0), 'image/png'))).error).toBe('image:empty');
    expect((await run('https://a.example/3', image(JPEG, 'application/octet-stream'))).error).toBe('image:not_image');
    expect((await run('https://a.example/4', image(JPEG, 'image/jpeg', 500))).error).toBe('image:http_500');
  });

  test('크기 — content-length 선검사와 스트림 캡 둘 다 too_large', async () => {
    const { client, calls } = fakeClient();
    const declared = 'https://a.example/declared.jpg';
    const streamed = 'https://a.example/streamed.jpg';
    let cancelled = false;
    const routes: Record<string, Route> = {
      [declared]: image(JPEG, 'image/jpeg', 200, { 'content-length': String(4 * 1024 * 1024) }),
      [streamed]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(new Uint8Array(65536).fill(0xff));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'image/jpeg' } },
        ),
    };
    const a = await copyImageToStorage(client, 7, [declared], { fetchImpl: makeFetch(routes), resolve });
    expect(a.error).toBe('image:too_large');
    const b = await copyImageToStorage(client, 7, [streamed], {
      fetchImpl: makeFetch(routes),
      resolve,
      maxBytes: 200_000,
    });
    expect(b.error).toBe('image:too_large');
    expect(cancelled).toBe(true);
    expect(calls.uploads).toHaveLength(0);
  });

  test('imageHosts 가 있으면 밖의 후보는 요청조차 보내지 않는다 (device.image_url 조작 방어)', async () => {
    const { client } = fakeClient();
    const fetchCalls: string[] = [];
    const evil = 'https://evil.example/x.jpg';
    const ok = 'https://scontent-ssn1-1.cdninstagram.com/v/t51.jpg?oe=abc';
    const r = await copyImageToStorage(client, 7, [evil, ok], {
      imageHosts: [/(^|\.)cdninstagram\.com$/, /(^|\.)fbcdn\.net$/],
      fetchImpl: makeFetch({ [ok]: image(JPEG, 'image/jpeg') }, fetchCalls),
      resolve,
    });
    expect(fetchCalls).toEqual([ok]);
    expect(r.imageSrc).toBe(ok);
    expect(r.error).toBe(null);

    const only = await copyImageToStorage(client, 7, [evil], {
      imageHosts: ['*.cdninstagram.com'],
      fetchImpl: makeFetch({}),
      resolve,
    });
    expect(only.error).toBe('image:host');
  });

  test('imageHosts 는 리다이렉트 홉에도 적용된다', async () => {
    const { client } = fakeClient();
    const start = 'https://img.example.com/a.jpg';
    const r = await copyImageToStorage(client, 7, [start], {
      imageHosts: ['*.example.com'],
      fetchImpl: makeFetch({
        [start]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/a.jpg' } }),
      }),
      resolve,
    });
    expect(r.error).toBe('image:ssrf:hop_host');
  });

  test('http 후보는 허용한다 (서버가 받아 https Storage 로 — daum cfile·kakao staticmap)', async () => {
    const { client } = fakeClient();
    const src = 'http://cfile1.uf.tistory.com/image/abc';
    const r = await copyImageToStorage(client, 7, [src], {
      fetchImpl: makeFetch({ [src]: image(GIF, 'image/gif') }),
      resolve,
    });
    expect(r.imageUrl?.startsWith('https://')).toBe(true);
    expect(r.imagePath?.endsWith('.gif')).toBe(true);
  });

  test('SSRF — 사설 IP·DNS 실패 후보는 fetch 없이 사유만 남긴다', async () => {
    const { client } = fakeClient();
    const fetchCalls: string[] = [];
    const a = await copyImageToStorage(client, 7, ['https://cdn.example/a.jpg'], {
      fetchImpl: makeFetch({}, fetchCalls),
      resolve: async () => ['192.168.0.10'],
    });
    expect(a.error).toBe('image:ssrf:ip');
    const b = await copyImageToStorage(client, 7, ['https://cdn.example/a.jpg'], {
      fetchImpl: makeFetch({}, fetchCalls),
      resolve: async () => [],
    });
    expect(b.error).toBe('image:dns_failed');
    const c = await copyImageToStorage(client, 7, ['http://127.0.0.1/a.jpg'], {
      fetchImpl: makeFetch({}, fetchCalls),
      resolve,
    });
    expect(c.error).toBe('image:ssrf:ip');
    expect(fetchCalls).toHaveLength(0);
  });

  test('후보 없음은 정상 (error null), 잘못된 postId 는 throw', async () => {
    const { client } = fakeClient();
    expect(await copyImageToStorage(client, 7, [], { fetchImpl: makeFetch({}), resolve })).toEqual({
      imageUrl: null,
      imagePath: null,
      imageSrc: null,
      error: null,
    });
    await expect(copyImageToStorage(client, 0, ['https://a.example/x.jpg'], { resolve })).rejects.toThrow(
      'invalid post id',
    );
    await expect(copyImageToStorage(client, Number.NaN, ['https://a.example/x.jpg'], { resolve })).rejects.toThrow(
      'invalid post id',
    );
  });

  test('공개 URL 이 https 가 아니면(로컬 Supabase) 저장하지 않는다 — DB CHECK 와 같은 규칙', async () => {
    const { client } = fakeClient({ publicBase: 'http://127.0.0.1:54321/storage/v1/object/public/link-previews/' });
    const src = 'https://a.example/x.jpg';
    const r = await copyImageToStorage(client, 7, [src], {
      fetchImpl: makeFetch({ [src]: image(JPEG, 'image/jpeg') }),
      resolve,
    });
    expect(r.error).toBe('image:public_url');
    expect(r.imageUrl).toBe(null);
  });

  test('업로드 오류 → upload', async () => {
    const { client } = fakeClient({ uploadError: { message: 'Payload too large', statusCode: '413' } });
    const src = 'https://a.example/x.jpg';
    const r = await copyImageToStorage(client, 7, [src], {
      fetchImpl: makeFetch({ [src]: image(JPEG, 'image/jpeg') }),
      resolve,
    });
    expect(r.error).toBe('image:upload');
  });

  test('deadline 이 지났으면 시도하지 않고, maxAttempts 로 시도 수를 자른다', async () => {
    const { client } = fakeClient();
    const fetchCalls: string[] = [];
    const past = await copyImageToStorage(client, 7, ['https://a.example/x.jpg'], {
      fetchImpl: makeFetch({}, fetchCalls),
      resolve,
      deadline: Date.now() - 1,
    });
    expect(past.error).toBe('image:deadline');
    expect(fetchCalls).toHaveLength(0);

    const urls = [1, 2, 3, 4, 5].map((i) => `https://a.example/${i}.jpg`);
    const routes = Object.fromEntries(urls.map((u) => [u, image(SVG, 'image/svg+xml')]));
    const r = await copyImageToStorage(client, 7, urls, {
      fetchImpl: makeFetch(routes, fetchCalls),
      resolve,
      maxAttempts: 2,
    });
    expect(fetchCalls).toHaveLength(2);
    expect(r.error).toBe('image:svg');
    expect(r.imageSrc).toBe(urls[0]);
  });
});

describe('copyExistingImage — canonical 재활용', () => {
  test('다른 post 의 경로를 이 post 경로로 복제하고 tombstone 을 되살린다', async () => {
    const { client, calls } = fakeClient();
    const r = await copyExistingImage(client, 'posts/7/e3b0c44298fc1c14.jpg', 42);
    expect(r).toEqual({
      imageUrl: PUBLIC_BASE + 'posts/42/e3b0c44298fc1c14.jpg',
      imagePath: 'posts/42/e3b0c44298fc1c14.jpg',
    });
    expect(calls.copies).toEqual([['posts/7/e3b0c44298fc1c14.jpg', 'posts/42/e3b0c44298fc1c14.jpg']]);
    expect(calls.deleteEq).toEqual(['posts/42/e3b0c44298fc1c14.jpg']);
  });

  test('같은 post 면 복제 없이 URL 만, 형식 밖 경로는 null', async () => {
    const { client, calls } = fakeClient();
    const same = await copyExistingImage(client, 'posts/42/e3b0c44298fc1c14.jpg', 42);
    expect(same?.imagePath).toBe('posts/42/e3b0c44298fc1c14.jpg');
    expect(calls.copies).toHaveLength(0);
    expect(await copyExistingImage(client, '../etc/passwd', 42)).toBe(null);
    expect(await copyExistingImage(client, 'posts/7/e3b0c44298fc1c14.svg', 42)).toBe(null);
  });

  test('이미 존재(409) 는 성공, 다른 오류는 null', async () => {
    const dup = fakeClient({ copyError: { message: 'The resource already exists', statusCode: '409' } });
    expect(await copyExistingImage(dup.client, 'posts/7/e3b0c44298fc1c14.jpg', 42)).not.toBe(null);
    const fail = fakeClient({ copyError: { message: 'Object not found', statusCode: '404' } });
    expect(await copyExistingImage(fail.client, 'posts/7/e3b0c44298fc1c14.jpg', 42)).toBe(null);
  });
});

describe('removeTombstones — 크론 없는 GC', () => {
  const v1 = 'posts/1/aaaaaaaaaaaaaaaa.jpg';
  const v2 = 'posts/2/bbbbbbbbbbbbbbbb.png';
  const capture = () => {
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: PreviewLogger = (event, extra) => {
      logs.push([event, extra]);
    };
    return { logs, log };
  };

  test('행 삭제(RETURNING) → posts 생존 확인 → Storage remove 순서. 형식 밖 행은 행만 지운다', async () => {
    const { client, calls } = fakeClient({
      tombstoneRows: [{ path: v1 }, { path: v2 }, { path: 'garbage' }, { path: null }],
    });
    const r = await removeTombstones(client, 10);
    expect(calls.deleteIn).toEqual([[v1, v2, 'garbage']]);
    expect(calls.selectIn).toEqual([{ table: 'posts', column: 'preview_image_path', values: [v1, v2] }]);
    expect(calls.removes).toEqual([[v1, v2]]);
    expect(calls.events).toEqual([
      `select:${TOMBSTONE_TABLE}`,
      `delete:${TOMBSTONE_TABLE}`,
      'select.in:posts',
      'remove',
    ]);
    expect(r).toEqual({ removed: 2, failed: 0 });
  });

  test('RETURNING 에 안 돌아온 경로(다른 호출의 clearTombstone 이 먼저 지움) 는 Storage 에서 지우지 않는다', async () => {
    const { client, calls } = fakeClient({
      tombstoneRows: [{ path: v1 }, { path: v2 }],
      deletedRows: [{ path: v2 }],
    });
    const r = await removeTombstones(client, 10);
    expect(calls.selectIn[0]?.values).toEqual([v2]);
    expect(calls.removes).toEqual([[v2]]);
    expect(r).toEqual({ removed: 1, failed: 0 });
  });

  test('아직 posts.preview_image_path 가 가리키는 경로는 건너뛴다 (되살아난 객체 — 행만 지워진 채 객체는 남는다)', async () => {
    const { logs, log } = capture();
    const { client, calls } = fakeClient({
      tombstoneRows: [{ path: v1 }, { path: v2 }],
      liveRows: [{ preview_image_path: v1 }],
    });
    const r = await removeTombstones(client, 10, log);
    expect(calls.deleteIn).toEqual([[v1, v2]]);
    expect(calls.removes).toEqual([[v2]]);
    expect(r).toEqual({ removed: 1, failed: 0 });
    expect(logs).toEqual([['tombstone_kept_live', { count: 1 }]]);

    const all = fakeClient({ tombstoneRows: [{ path: v1 }], liveRows: [{ preview_image_path: v1 }] });
    expect(await removeTombstones(all.client, 10)).toEqual({ removed: 0, failed: 0 });
    expect(all.calls.removes).toHaveLength(0);
  });

  test('생존 확인 실패면 지우지 않는다 (살아 있는 썸네일 삭제보다 고아가 낫다)', async () => {
    const { logs, log } = capture();
    const { client, calls } = fakeClient({
      tombstoneRows: [{ path: v1 }, { path: v2 }],
      liveError: { message: 'boom' },
    });
    const r = await removeTombstones(client, 10, log);
    expect(calls.removes).toHaveLength(0);
    expect(r).toEqual({ removed: 0, failed: 2 });
    expect(logs[0]?.[0]).toBe('tombstone_live_check_failed');
  });

  test('행 삭제 실패면 아무것도 건드리지 않는다 — 다음 호출이 그대로 다시 본다', async () => {
    const { logs, log } = capture();
    const { client, calls } = fakeClient({
      tombstoneRows: [{ path: v1 }],
      deleteError: { message: 'boom' },
    });
    const r = await removeTombstones(client, 10, log);
    expect(calls.selectIn).toHaveLength(0);
    expect(calls.removes).toHaveLength(0);
    expect(r).toEqual({ removed: 0, failed: 0 });
    expect(logs[0]?.[0]).toBe('tombstone_delete_failed');
  });

  test('remove 실패는 failed 로 보고한다 (행은 이미 지워져 재시도되지 않는다)', async () => {
    const { logs, log } = capture();
    const { client, calls } = fakeClient({
      tombstoneRows: [{ path: v1 }, { path: 'garbage' }],
      removeError: { message: 'boom' },
    });
    const r = await removeTombstones(client, 10, log);
    expect(calls.deleteIn).toEqual([[v1, 'garbage']]);
    expect(calls.removes).toEqual([[v1]]);
    expect(r).toEqual({ removed: 0, failed: 1 });
    expect(logs).toEqual([['tombstone_remove_failed', { count: 1, error: 'boom' }]]);
  });

  test('형식 밖 경로만 있으면 행만 지우고 posts·Storage 는 부르지 않는다', async () => {
    const { client, calls } = fakeClient({ tombstoneRows: [{ path: 'garbage' }, { path: '../etc/passwd' }] });
    expect(await removeTombstones(client, 10)).toEqual({ removed: 0, failed: 0 });
    expect(calls.deleteIn).toEqual([['garbage', '../etc/passwd']]);
    expect(calls.selectIn).toHaveLength(0);
    expect(calls.removes).toHaveLength(0);
  });

  test('select 실패·빈 테이블은 조용히 0 (응답을 막지 않는다)', async () => {
    const failed = fakeClient({ selectError: { message: 'relation does not exist' } });
    expect(await removeTombstones(failed.client)).toEqual({ removed: 0, failed: 0 });
    expect(failed.calls.deleteIn).toHaveLength(0);
    const empty = fakeClient();
    expect(await removeTombstones(empty.client)).toEqual({ removed: 0, failed: 0 });
    expect(empty.calls.deleteIn).toHaveLength(0);
    expect(empty.calls.removes).toHaveLength(0);
  });
});
