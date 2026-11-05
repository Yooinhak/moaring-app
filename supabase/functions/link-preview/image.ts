// 썸네일 복사 — 이미지 후보를 검증해 Storage 공개 버킷(link-previews)에 넣고 https URL 을 돌려준다
//
// 왜 원본 URL 을 그대로 쓰지 않는가: 인스타 CDN 은 oe= 서명이 ~4.4일 뒤 만료되고(쿼리를 떼면 403), daum cfile·kakao
// staticmap 은 http 라 Android cleartext 차단에 조용히 깨진다 (memory: kakao-http-avatar-cleartext). 그래서 수집과 같은
// 호출에서 즉시 복사하고 DB 에는 Storage 의 https URL 만 넣는다 (posts_preview_image_url_https_check).
//
// 저장 규칙 (설계 §7): 후보 순회 → SSRF → (provider imageHosts 가 있으면 필수 매칭) → GET Accept image/* 8 s·3 MiB 스트림 캡
// → 2xx + content-type image/* → 매직바이트(JPEG·PNG·GIF·WEBP·AVIF; SVG 는 RN <Image> 가 못 그려 거부) → 확장자·contentType 은
// 매직바이트 기준 → posts/<post_id>/<sha256 앞 16자>.<ext> (경로에 사용자 입력이 들어갈 자리가 없다) → upload(upsert) → getPublicUrl.
// 이미지 실패는 상태 실패가 아니다 — 호출자는 텍스트만 ready 로 두고 error 'image:<reason>' 과 원본 URL(imageSrc) 만 남긴다.
//
// supabase-js 를 import 하지 않는다 — 호출자(index.ts) 가 만든 adminClient 를 받는다. 그래서 URL import 가 없고 bun 에서
// 가짜 클라이언트로 테스트할 수 있다 (__tests__/image.test.ts). 필요한 메서드만 구조적으로 선언한다 (PreviewAdminClient).

import { mediaType } from './charset.ts';
import { matchesHost } from './canonical.ts';
import { errorCode, readCapped, requestWithRedirects } from './fetch.ts';
import type { PreviewIODeps } from './fetch.ts';
import { BUDGET, STORAGE_BUCKET } from './types.ts';
import type { HostPattern, PreviewLogger } from './types.ts';

// ---------------------------------------------------------------------------
// supabase-js 중 쓰는 부분만 (구조적 타입 — 실제 SupabaseClient 가 그대로 들어온다)
// ---------------------------------------------------------------------------

export interface StorageError {
  message: string;
  statusCode?: string | number;
}

export interface StorageResult<T = unknown> {
  data: T | null;
  error: StorageError | null;
}

export interface StorageBucketLike {
  upload(
    path: string,
    body: Blob,
    options?: { contentType?: string; cacheControl?: string; upsert?: boolean },
  ): Promise<StorageResult>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  copy(fromPath: string, toPath: string): Promise<StorageResult>;
  remove(paths: string[]): Promise<StorageResult>;
}

/**
 * PostgREST 체인 중 이 모듈이 쓰는 것만 — tombstone 테이블(select→order→limit, delete→in/eq) 과 GC 직전
 * posts.preview_image_path 생존 확인(select→in). delete().in().select() 는 RETURNING — 실제로 지운 행만 돌아온다.
 */
export interface TombstoneTableLike {
  select(columns: string): {
    order(
      column: string,
      options: { ascending: boolean },
    ): {
      limit(count: number): PromiseLike<StorageResult<Array<{ path: unknown }>>>;
    };
    in(column: string, values: string[]): PromiseLike<StorageResult<Array<Record<string, unknown>>>>;
  };
  delete(): {
    in(
      column: string,
      values: string[],
    ): PromiseLike<StorageResult> & {
      select(columns: string): PromiseLike<StorageResult<Array<{ path: unknown }>>>;
    };
    eq(column: string, value: string): PromiseLike<StorageResult>;
  };
}

export interface PreviewAdminClient {
  storage: { from(bucket: string): StorageBucketLike };
  from(table: string): TombstoneTableLike;
}

export const TOMBSTONE_TABLE = 'preview_image_tombstones';
const POSTS_TABLE = 'posts';

// ---------------------------------------------------------------------------
// 매직바이트·경로 (순수 함수)
// ---------------------------------------------------------------------------

export type ImageExt = 'jpg' | 'png' | 'gif' | 'webp' | 'avif';
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif';

export interface SniffedImage {
  mime: ImageMime;
  ext: ImageExt;
}

function ascii(bytes: Uint8Array, from: number, len: number): string {
  let s = '';
  for (let i = from; i < from + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * 앞 바이트로 포맷을 판정한다. Content-Type 헤더는 CDN 이 틀리게 보내는 경우가 있어(octet-stream·text/html 404 페이지) 믿지 않는다.
 * 버킷 allowed_mime_types(jpeg·png·webp·gif·avif) 와 같은 집합. SVG(<svg·<?xml) 는 여기서 null → 거부.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (ascii(bytes, 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    // HEIC(heic·mif1 단독) 는 버킷이 거부하므로 AVIF 브랜드만
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}

/**
 * Uint8Array → 정확히 그 바이트만 담은 ArrayBuffer. crypto.subtle.digest·Blob 은 SharedArrayBuffer 뒤의 뷰를 타입상 거부하므로
 * (TS 5.7+ 의 Uint8Array<ArrayBufferLike>) 뷰가 버퍼 전체를 덮으면 그대로, 아니면 복사한다. readCapped 결과는 항상 전체 뷰라 복사가 없다.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) return buffer;
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** sha256 앞 8바이트 = 16 hex. 같은 바이트는 같은 경로 → upsert 로 자연 중복 제거. */
export async function sha256Hex16(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest).subarray(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const STORAGE_PATH_RE = /^posts\/(\d{1,12})\/([0-9a-f]{16})\.(jpg|png|gif|webp|avif)$/;

/** 서버가 만든 경로 형식인가. tombstone·copy 입력도 이 형식이어야만 Storage API 에 넘긴다. */
export function isStoragePath(path: string): boolean {
  return STORAGE_PATH_RE.test(path);
}

function assertPostId(postId: number): number {
  if (!Number.isInteger(postId) || postId <= 0 || postId > 999_999_999_999) {
    throw new Error(`invalid post id: ${String(postId)}`);
  }
  return postId;
}

/** posts/<postId>/<sha16>.<ext> — 사용자 입력이 들어갈 자리가 없다. */
export function buildStoragePath(postId: number, sha16: string, ext: ImageExt): string {
  if (!/^[0-9a-f]{16}$/.test(sha16)) throw new Error('invalid sha16');
  return `posts/${assertPostId(postId)}/${sha16}.${ext}`;
}

function publicUrlOf(client: PreviewAdminClient, path: string): string | null {
  const url = client.storage.from(STORAGE_BUCKET).getPublicUrl(path).data?.publicUrl;
  // DB CHECK 가 https 만 받는다 — SUPABASE_URL 이 http 인 로컬 환경에서는 이미지 없이 저장되는 편이 안전하다
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

/**
 * 같은 경로의 tombstone 이 남아 있으면 지운다. 시나리오: force 재수집으로 X→Y(X tombstone) 뒤 다시 Y→X 로 돌아오면
 * 새로 올린 X 를 GC 가 지워버린다. 업로드·복제 성공 직후 "되살린" 경로의 tombstone 을 걷어내 그 경합을 끊는다.
 * GC(removeTombstones) 도 행 삭제를 선점으로 쓰므로 둘 중 먼저 행을 지운 쪽이 이긴다. 실패해도 무시
 * (005 미적용으로 테이블이 없을 수도 있다).
 */
async function clearTombstone(client: PreviewAdminClient, path: string, log?: PreviewLogger): Promise<void> {
  try {
    const { error } = await client.from(TOMBSTONE_TABLE).delete().eq('path', path);
    if (error) log?.('tombstone_clear_failed', { error: error.message.slice(0, 120) });
  } catch (err) {
    log?.('tombstone_clear_failed', { error: errorCode(err) });
  }
}

// ---------------------------------------------------------------------------
// 후보 복사
// ---------------------------------------------------------------------------

export interface CopyImageOptions extends PreviewIODeps {
  /** SiteAdapter.imageHosts. 정의돼 있으면(비어 있지 않으면) 후보·홉 호스트가 전부 여기 맞아야 한다. */
  imageHosts?: readonly HostPattern[];
  /** epoch ms. 이 시각이 1 s 미만 남으면 남은 후보를 건너뛴다 (단건 25 s 예산 — ProviderCtx.deadline). */
  deadline?: number;
  /** 시도할 후보 수 상한. 후보가 6개여도 8 s × 6 은 예산을 넘는다. 기본 4. */
  maxAttempts?: number;
  /** 기본 BUDGET.imageTimeoutMs (8 s). */
  timeoutMs?: number;
  /** 기본 BUDGET.imageMaxBytes (3 MiB = 버킷 file_size_limit). */
  maxBytes?: number;
}

export interface CopyImageResult {
  /** Storage 공개 URL (https). 실패면 null. */
  imageUrl: string | null;
  /** 버킷 내 경로 posts/<id>/<sha16>.<ext>. 실패면 null. */
  imagePath: string | null;
  /** 저장한 원본 URL, 전부 실패면 첫 후보 (preview_image_src — 디버깅·재시도용, 렌더 금지). */
  imageSrc: string | null;
  /** 전부 실패면 'image:<reason>' (첫 후보의 사유). 성공 또는 후보 없음이면 null. */
  error: string | null;
  /** 성공 시 매직바이트로 판정한 MIME. */
  contentType?: ImageMime;
}

const IMAGE_MAX_HOPS = 4; // CDN 리다이렉트는 보통 1~2홉

interface AttemptSuccess {
  ok: true;
  path: string;
  mime: ImageMime;
}

interface AttemptFailure {
  ok: false;
  reason: string;
}

async function attemptCopy(
  client: PreviewAdminClient,
  postId: number,
  candidate: string,
  opts: CopyImageOptions,
): Promise<AttemptSuccess | AttemptFailure> {
  const timeoutMs = opts.timeoutMs ?? BUDGET.imageTimeoutMs;
  const maxBytes = opts.maxBytes ?? BUDGET.imageMaxBytes;
  const hostAllow = opts.imageHosts && opts.imageHosts.length > 0 ? opts.imageHosts : undefined;

  let hostname: string;
  try {
    hostname = new URL(candidate).hostname;
  } catch {
    return { ok: false, reason: 'url' };
  }
  // provider 가 이미지 호스트를 정해 뒀으면 그 밖의 후보는 요청조차 보내지 않는다 (device.image_url 조작 방어)
  if (hostAllow && !matchesHost(hostname, hostAllow)) return { ok: false, reason: 'host' };

  let r;
  try {
    r = await requestWithRedirects(
      candidate,
      {
        method: 'GET',
        accept: 'image/*',
        timeoutMs,
        maxHops: IMAGE_MAX_HOPS,
        startAllow: hostAllow,
        hopAllow: hostAllow,
      },
      { fetchImpl: opts.fetchImpl, resolve: opts.resolve, log: opts.log },
    );
  } catch (err) {
    return { ok: false, reason: errorCode(err) };
  }

  const res = r.response;
  const status = res.status;
  if (status < 200 || status >= 300) {
    // nts.go.kr 의 og:image 처럼 "해석은 되지만 404 text/html" 인 후보 — 다음 후보로
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `http_${status}` };
  }
  const contentType = mediaType(res.headers.get('content-type'));
  if (!contentType || !contentType.startsWith('image/')) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'not_image' };
  }
  if (contentType === 'image/svg+xml') {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'svg' };
  }
  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }

  let bytes: Uint8Array;
  try {
    const read = await readCapped(res.body, { maxBytes });
    if (read.truncated) return { ok: false, reason: 'too_large' };
    bytes = read.bytes;
  } catch (err) {
    return { ok: false, reason: errorCode(err) };
  }
  if (bytes.length === 0) return { ok: false, reason: 'empty' };

  const sniffed = sniffImage(bytes);
  if (!sniffed) return { ok: false, reason: 'bad_magic' };

  const path = buildStoragePath(postId, await sha256Hex16(bytes), sniffed.ext);
  const blob = new Blob([toArrayBuffer(bytes)], { type: sniffed.mime });
  const { error } = await client.storage.from(STORAGE_BUCKET).upload(path, blob, {
    contentType: sniffed.mime,
    cacheControl: '31536000', // 경로에 해시가 있어 내용이 바뀌면 경로도 바뀐다 → 1년 캐시
    upsert: true,
  });
  if (error) {
    opts.log?.('image_upload_failed', { post_id: postId, error: error.message.slice(0, 120) });
    return { ok: false, reason: 'upload' };
  }
  return { ok: true, path, mime: sniffed.mime };
}

/**
 * 후보를 순서대로 시도해 첫 성공만 저장한다. 어떤 후보도 안 되면 imageUrl/imagePath 는 null 이고 error 에 첫 후보의 사유를 남긴다.
 * 후보가 없으면 error 도 null 이다 — "이미지 없음" 은 정상 결과다.
 */
export async function copyImageToStorage(
  adminClient: PreviewAdminClient,
  postId: number,
  candidates: readonly string[],
  opts: CopyImageOptions = {},
): Promise<CopyImageResult> {
  assertPostId(postId);
  const list = candidates.filter((c) => typeof c === 'string' && c.length > 0);
  const empty: CopyImageResult = { imageUrl: null, imagePath: null, imageSrc: list[0] ?? null, error: null };
  if (list.length === 0) return empty;

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  let firstReason: string | null = null;

  for (let i = 0; i < list.length && i < maxAttempts; i++) {
    if (opts.deadline !== undefined && opts.deadline - Date.now() < 1_000) {
      firstReason ??= 'deadline';
      break;
    }
    const candidate = list[i];
    const result = await attemptCopy(adminClient, postId, candidate, opts);
    if (result.ok) {
      const imageUrl = publicUrlOf(adminClient, result.path);
      if (!imageUrl) {
        firstReason ??= 'public_url';
        break;
      }
      await clearTombstone(adminClient, result.path, opts.log);
      opts.log?.('image_copied', {
        post_id: postId,
        host: new URL(candidate).hostname,
        mime: result.mime,
        attempt: i + 1,
      });
      return { imageUrl, imagePath: result.path, imageSrc: candidate, error: null, contentType: result.mime };
    }
    opts.log?.('image_skipped', { post_id: postId, host: hostOf(candidate), reason: result.reason, attempt: i + 1 });
    firstReason ??= result.reason;
  }

  return { ...empty, error: `image:${firstReason ?? 'unknown'}` };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// canonical 재활용 복제
// ---------------------------------------------------------------------------

export interface CopiedImage {
  imageUrl: string;
  imagePath: string;
}

/**
 * 같은 그룹의 ready 행(canonical 일치) 이 가진 썸네일을 이 post 의 경로로 복제한다 — 네트워크 0회.
 * post 별 경로를 유지해야 한 쪽이 삭제돼도 다른 쪽 이미지가 남는다 (tombstone 은 경로 단위). 실패면 null (호출자는 텍스트만 복사).
 */
export async function copyExistingImage(
  adminClient: PreviewAdminClient,
  srcPath: string,
  postId: number,
  log?: PreviewLogger,
): Promise<CopiedImage | null> {
  assertPostId(postId);
  if (!isStoragePath(srcPath)) return null;
  const fileName = srcPath.slice(srcPath.lastIndexOf('/') + 1);
  const destPath = `posts/${postId}/${fileName}`;

  if (destPath !== srcPath) {
    try {
      const { error } = await adminClient.storage.from(STORAGE_BUCKET).copy(srcPath, destPath);
      // 같은 해시가 이미 있으면 Storage 가 409(Duplicate / already exists) 를 준다 — 내용이 같으니 성공으로 본다
      if (error && !/exist|duplicate/i.test(error.message) && String(error.statusCode ?? '') !== '409') {
        log?.('image_copy_existing_failed', { post_id: postId, error: error.message.slice(0, 120) });
        return null;
      }
    } catch (err) {
      log?.('image_copy_existing_failed', { post_id: postId, error: errorCode(err) });
      return null;
    }
  }

  const imageUrl = publicUrlOf(adminClient, destPath);
  if (!imageUrl) return null;
  await clearTombstone(adminClient, destPath, log);
  return { imageUrl, imagePath: destPath };
}

// ---------------------------------------------------------------------------
// tombstone GC — 크론 없이 매 fetch/sweep 호출 끝에 소량씩
// ---------------------------------------------------------------------------

export interface RemoveTombstonesResult {
  /** Storage 에서 지운(또는 이미 없어서 지운 것으로 처리한) 객체 수. */
  removed: number;
  /** 행은 선점(삭제)했지만 Storage 에서 못 지운 수. 행이 이미 없으므로 재시도되지 않는다 — 고아로 남고 로그에만 찍힌다. */
  failed: number;
}

function pathsOf(rows: Array<{ path: unknown }> | null): string[] {
  return (rows ?? []).map((row) => row.path).filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * tombstone 상위 N 건의 행을 먼저 지우고(RETURNING), 실제로 지워진 경로만 Storage 에서 지운다. 어떤 실패도 던지지 않는다
 * (호출자의 응답을 막지 않기 위해).
 *
 * 행을 먼저 지우는 이유: GC 는 매 호출 끝에 다른 호출과 동시에 돈다. "select → remove → delete" 순이면 select 와 remove 사이에
 * 다른 호출이 같은 경로를 다시 올리고(upsert) clearTombstone 까지 마쳐도 remove 가 살아 있는 객체를 지운다. 행 삭제가 선점이면
 * 그 경합은 한쪽만 이긴다 — 저쪽 clearTombstone 이 먼저면 여기 RETURNING 에 안 돌아오고, 여기가 먼저면 저쪽이 빈손이다.
 * 후자(저쪽 UPDATE 가 그 뒤 들어오는 경우) 와 clearTombstone 자체가 실패해 살아 있는 경로의 tombstone 이 남은 경우를 위해
 * remove 직전에 posts.preview_image_path 를 한 번 더 보고, 아직 어떤 글이 가리키는 경로는 건너뛴다.
 * 우리 경로 형식이 아닌 행은 Storage 에 있을 수 없으므로 행만 지운다.
 */
export async function removeTombstones(
  adminClient: PreviewAdminClient,
  limit = 10,
  log?: PreviewLogger,
): Promise<RemoveTombstonesResult> {
  const n = Math.max(1, Math.min(Math.floor(limit), 100));
  const nothing: RemoveTombstonesResult = { removed: 0, failed: 0 };
  try {
    const { data, error } = await adminClient
      .from(TOMBSTONE_TABLE)
      .select('path')
      .order('created_at', { ascending: true })
      .limit(n);
    if (error) {
      log?.('tombstone_select_failed', { error: error.message.slice(0, 120) });
      return nothing;
    }
    const paths = pathsOf(data);
    if (paths.length === 0) return nothing;

    // 1) 행 삭제 = 선점. 돌아온 경로만 이 호출의 것이다. 실패면 아무것도 안 건드렸으니 다음 호출이 그대로 다시 본다
    const { data: deletedRows, error: deleteError } = await adminClient
      .from(TOMBSTONE_TABLE)
      .delete()
      .in('path', paths)
      .select('path');
    if (deleteError) {
      log?.('tombstone_delete_failed', { error: deleteError.message.slice(0, 120) });
      return nothing;
    }
    const claimed = pathsOf(deletedRows).filter(isStoragePath);
    if (claimed.length === 0) return nothing;

    // 2) remove 직전 생존 확인 — 아직 어떤 글이 가리키면 되살아난 객체다
    const { data: liveRows, error: liveError } = await adminClient
      .from(POSTS_TABLE)
      .select('preview_image_path')
      .in('preview_image_path', claimed);
    if (liveError) {
      // 확인을 못 하면 지우지 않는다 — 고아(저장 비용) 가 살아 있는 썸네일 삭제(깨진 카드) 보다 낫다
      log?.('tombstone_live_check_failed', { count: claimed.length, error: liveError.message.slice(0, 120) });
      return { removed: 0, failed: claimed.length };
    }
    const live = new Set(
      (liveRows ?? []).map((row) => row.preview_image_path).filter((p): p is string => typeof p === 'string'),
    );
    const targets = claimed.filter((p) => !live.has(p));
    if (targets.length < claimed.length) log?.('tombstone_kept_live', { count: claimed.length - targets.length });
    if (targets.length === 0) return nothing;

    // 3) Storage. 실패하면 행은 이미 없다 — 고아로 남는다 (살아 있는 객체를 지울 위험과 맞바꾼 비용)
    const { error: removeError } = await adminClient.storage.from(STORAGE_BUCKET).remove(targets);
    if (removeError) {
      log?.('tombstone_remove_failed', { count: targets.length, error: removeError.message.slice(0, 120) });
      return { removed: 0, failed: targets.length };
    }
    return { removed: targets.length, failed: 0 };
  } catch (err) {
    log?.('tombstone_gc_failed', { error: errorCode(err) });
    return nothing;
  }
}
