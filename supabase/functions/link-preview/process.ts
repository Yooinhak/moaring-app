// 수집 본체 — claim → canonical 재활용 → provider.run → device 힌트 병합 → 이미지 복사 → 단일 UPDATE
//
// 세 수집 경로(앱 가속 fetch · DB 트리거 webhook · sweep) 와 폰 보조(assist) 가 전부 이 모듈로 수렴한다 (설계 §3·§5).
// index.ts 는 인증·라우팅만 하고, posts.preview_* 를 바꾸는 UPDATE 는 모두 claim_post_preview 로 행을 선점한 뒤에만 일어난다
// — 웹훅·앱·catch-up 이 같은 글에 동시에 도착해도 한 워커만 통과하고, 죽은 워커의 선점은 2분 뒤 stale 로 풀린다.
//
// 이 파일은 Deno 전역·URL import 를 쓰지 않는다. supabase-js 클라이언트는 index.ts 가 만들어 넘기고 여기서는 쓰는 메서드만
// 구조적으로 선언한다(ProcessAdminClient) — 그래야 bun 에서 가짜 클라이언트·가짜 io 로 전 경로를 돌릴 수 있다
// (__tests__/process.test.ts; 이 Mac 에 deno 가 없어 배포 전 검증 수단은 bun 뿐이다).
//
// 요청 바디의 URL 은 어디에서도 fetch 하지 않는다. fetch 대상은 claim 이 돌려준 posts.url 과 어댑터가 그로부터 계산한 고정
// 엔드포인트뿐이다. 유일한 예외 device.image_url 은 https 만 받고, 어댑터 imageHosts 허용목록 + SSRF + 매직바이트 재다운로드
// (image.ts) 를 통과한 뒤 Storage 의 https URL 로만 저장된다.

import { canonicalize, parseHttpUrl } from './canonical.ts';
import { normalizeFields, normalizeText } from './html.ts';
import type { PreviewIODeps } from './fetch.ts';
import { copyExistingImage, copyImageToStorage } from './image.ts';
import type { CopyImageResult, PreviewAdminClient } from './image.ts';
import { emptyFields, errorCode as providerErrorCode } from './sites/generic.ts';
import { parseSubmittedHtml, resolveAdapter } from './sites/index.ts';
import { BUDGET, FIELD_LIMITS, PREVIEW_SOURCES, PREVIEW_STATUSES } from './types.ts';
import type {
  ClaimRow,
  ClientTask,
  DeviceHints,
  PreviewFields,
  PreviewIO,
  PreviewLogger,
  PreviewSource,
  PreviewStatus,
  PreviewUpdate,
  ProviderCtx,
  ProviderOutcome,
  ResultEntry,
  SiteAdapter,
  SkipReason,
} from './types.ts';

// ---------------------------------------------------------------------------
// supabase-js 중 쓰는 부분만 (구조적 타입 — 실제 service_role 클라이언트가 그대로 들어온다)
// ---------------------------------------------------------------------------

export interface QueryError {
  message: string;
  code?: string;
}

export interface QueryResult<T = unknown> {
  data: T | null;
  error: QueryError | null;
}

/** PostgrestFilterBuilder 중 posts 테이블에 쓰는 메서드. 체인 끝은 await 가능. */
export interface PostsQueryBuilder extends PromiseLike<QueryResult<Array<Record<string, unknown>>>> {
  select(columns: string): PostsQueryBuilder;
  update(values: Record<string, unknown>): PostsQueryBuilder;
  eq(column: string, value: unknown): PostsQueryBuilder;
  neq(column: string, value: unknown): PostsQueryBuilder;
  gte(column: string, value: unknown): PostsQueryBuilder;
  order(column: string, options: { ascending: boolean }): PostsQueryBuilder;
  limit(count: number): PostsQueryBuilder;
}

/**
 * image.ts 의 PreviewAdminClient(storage + tombstone 테이블) 에 rpc 와 posts 질의를 더한 것.
 * from() 의 반환은 두 모양의 교집합 — posts 체인(select/update/eq …) 과 tombstone 체인(select→order→limit, delete→in/eq) 을
 * 같은 객체(실제 PostgrestQueryBuilder) 가 모두 만족한다.
 */
export interface ProcessAdminClient extends PreviewAdminClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<QueryResult<unknown>>;
  from(table: string): PostsQueryBuilder & ReturnType<PreviewAdminClient['from']>;
}

const POSTS_TABLE = 'posts';

// ---------------------------------------------------------------------------
// 옵션
// ---------------------------------------------------------------------------

export interface ProcessOptions {
  /** 수동 재시도. claim 이 상태를 무시하고 선점하며 canonical 재활용을 건너뛴다(새로 받아오라는 요청이므로). */
  force?: boolean;
  /** 저장 직후 가속 호출에 실린 폰 파싱 결과. 서버 결과의 빈 필드만 채운다. */
  device?: DeviceHints | null;
  /** claim 의 hint_title 대신 쓸 제목 힌트 (테스트·수동 호출용). 보통 생략. */
  hintTitle?: string | null;
  log?: PreviewLogger;
  /** 테스트용 시계. 기본 Date.now. */
  now?: () => number;
  /** env INSTAGRAM_STORE_CAPTION=full — assist 에서 인스타 임베드 캡션 전체를 설명에 저장. */
  storeCaption?: boolean;
  /** 단건 예산(ms). 기본 BUDGET.postTimeoutMs(25 s). 테스트에서만 줄인다. */
  postTimeoutMs?: number;
  /** 이미지 복사의 fetch·DNS 주입 (bun 테스트용). 운영에서는 생략 — image.ts 가 globalThis.fetch + Deno.resolveDns/DoH 를 쓴다. */
  imageDeps?: Pick<PreviewIODeps, 'fetchImpl' | 'resolve'>;
}

const noopLog: PreviewLogger = () => {};

/** canonical 재활용: 같은 그룹에서 이 기간 안에 ready 가 된 같은 canonical 행의 preview_* 를 복사한다 (설계 §5). */
export const CANONICAL_REUSE_MS = 7 * 24 * 60 * 60 * 1000;

/** assist 의 device.html 상한 (types.ts DeviceHints.html 주석과 동일). 넘치면 앞부분만 쓴다 — 인스타 임베드 이미지는 앞쪽에 있다. */
export const DEVICE_HTML_MAX_CHARS = 256 * 1024;

/** run 이 ctx.deadline 을 지키지 못했을 때(어댑터 버그) 강제로 끊기 전 유예. fetch.ts 의 AbortSignal 이 먼저 끊는 게 정상 경로다. */
const RUN_GRACE_MS = 3_000;

// ---------------------------------------------------------------------------
// 작은 유틸
// ---------------------------------------------------------------------------

function asStatus(value: unknown): PreviewStatus | null {
  return typeof value === 'string' && (PREVIEW_STATUSES as readonly string[]).includes(value)
    ? (value as PreviewStatus)
    : null;
}

function asSource(value: unknown): PreviewSource | null {
  return typeof value === 'string' && (PREVIEW_SOURCES as readonly string[]).includes(value)
    ? (value as PreviewSource)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function clampError(code: string | null | undefined): string | null {
  return normalizeText(code, FIELD_LIMITS.error, { singleLine: true });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 'ssrf:*'·홉 초과·URL 파싱 불가는 다시 시도해도 같은 결과 — failed(재시도 대상) 가 아니라 unsupported(영구) 로 둔다. */
export function isPermanentFailure(code: string): boolean {
  return code.startsWith('ssrf') || code === 'too_many_redirects' || code === 'bad_url';
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/** run 이 deadline + 유예 안에 끝나지 않으면 failed('timeout') 으로 간주한다. 늦게 끝난 결과는 버린다. */
async function withDeadline(run: Promise<ProviderOutcome>, deadline: number): Promise<ProviderOutcome> {
  const remaining = Math.max(0, deadline - Date.now()) + RUN_GRACE_MS;
  const timer = sleep(remaining);
  try {
    return await Promise.race([run, timer.promise.then((): ProviderOutcome => ({ kind: 'failed', error: 'timeout' }))]);
  } finally {
    timer.cancel();
  }
}

// ---------------------------------------------------------------------------
// device 힌트 정제 — 폰이 보낸 값은 신뢰하지 않는다 (악의적 editor 가 보낼 수 있다, 설계 §10)
// ---------------------------------------------------------------------------

export interface SanitizedDevice {
  title: string | null;
  description: string | null;
  author: string | null;
  /** https 만. 복사 단계(imageHosts·SSRF·매직바이트) 를 통과해야 저장된다. */
  imageUrl: string | null;
  /** http(s) 만, 추적 파라미터 제거. 서버 canonical 이 있으면 쓰이지 않고, assist 에서는 posts.url 과 같은 사이트일 때만 믿는다. */
  canonicalUrl: string | null;
  /** ≤ DEVICE_HTML_MAX_CHARS. 서버 파서(parseSubmittedHtml) 입력. */
  html: string | null;
  blocked: boolean;
  httpStatus: number | null;
}

/** 길이·제어문자·NFC·스킴을 정리한다. 객체가 아니면 null. 전부 빈 힌트도 객체로 돌려준다(blocked 판정이 필요). */
export function sanitizeDeviceHints(device: DeviceHints | null | undefined): SanitizedDevice | null {
  if (!device || typeof device !== 'object') return null;
  const image = typeof device.image_url === 'string' ? parseHttpUrl(device.image_url) : null;
  const canonical = typeof device.canonical_url === 'string' ? parseHttpUrl(device.canonical_url) : null;
  const httpStatus =
    typeof device.http_status === 'number' && Number.isInteger(device.http_status) && device.http_status >= 100
      ? device.http_status
      : null;
  let imageUrl: string | null = null;
  if (image && image.protocol === 'https:') {
    image.hash = '';
    imageUrl = image.href;
  }
  return {
    title: normalizeText(typeof device.title === 'string' ? device.title : null, FIELD_LIMITS.title, {
      singleLine: true,
    }),
    description: normalizeText(
      typeof device.description === 'string' ? device.description : null,
      FIELD_LIMITS.description,
    ),
    author: normalizeText(typeof device.author === 'string' ? device.author : null, FIELD_LIMITS.author, {
      singleLine: true,
    }),
    imageUrl,
    canonicalUrl: canonical ? canonicalize(canonical).canonicalUrl : null,
    html:
      typeof device.html === 'string' && device.html.length > 0 ? device.html.slice(0, DEVICE_HTML_MAX_CHARS) : null,
    blocked: device.blocked === true,
    httpStatus,
  };
}

/**
 * 서버 결과가 우선 — 빈 필드만 폰 값으로 채우고, 폰 이미지는 후보 끝에 붙인다(서버 후보가 먼저 시도된다).
 * preferDevice 는 서버가 실제 페이지를 못 읽은 경우(needs_client 의 '쿠팡 상품 <pid>'·슬러그 같은 자리표시 제목) 에만 쓴다 —
 * 그때는 폰이 읽은 제목·설명·작성자가 진짜다. siteName(브랜드 라벨) 과 canonical 은 항상 서버 것.
 */
export function mergeDeviceFields(
  server: PreviewFields,
  device: SanitizedDevice | null,
  preferDevice = false,
): PreviewFields {
  if (!device) return server;
  const imageCandidates =
    device.imageUrl && !server.imageCandidates.includes(device.imageUrl)
      ? [...server.imageCandidates, device.imageUrl]
      : server.imageCandidates;
  const pick = (s: string | null, d: string | null) => (preferDevice ? (d ?? s) : (s ?? d));
  return {
    title: pick(server.title, device.title),
    description: pick(server.description, device.description),
    author: pick(server.author, device.author),
    siteName: server.siteName,
    canonicalUrl: server.canonicalUrl ?? device.canonicalUrl,
    imageCandidates,
  };
}

/**
 * 인스타 캡션 전체(description) 는 env INSTAGRAM_STORE_CAPTION=full 일 때만 저장한다는 결정(설계 §10-2) 은 폰이 보낸 값에도
 * 적용된다 — 폰 파서는 캡션 전체를 description 에 담아 보내므로, 여기서 떨어내지 않으면 빈 서버 필드를 채우는 병합이
 * 플래그를 우회한다. 다른 어댑터(Threads 포함) 는 그대로.
 */
export function applyCaptionPolicy(
  device: SanitizedDevice | null,
  adapter: SiteAdapter,
  storeCaption: boolean,
): SanitizedDevice | null {
  if (!device || storeCaption || adapter.id !== 'instagram' || device.description === null) return device;
  return { ...device, description: null };
}

/** 'www.'·'m.' 접두를 뗀 호스트 (html.ts sameSite 와 같은 규칙). */
function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www|m)\./, '');
}

/**
 * 두 URL 이 같은 사이트인지 — 접두(www./m.) 를 뗀 호스트가 같거나 한쪽이 다른 쪽의 하위 도메인(점 경계) 이면 참.
 * 폰이 보낸 canonical 을 posts.url 과 대조하는 데 쓴다: 다른 사이트 URL 을 canonical 로 저장하게 두면 그 값이
 * findDonor 의 키가 되어 같은 그룹의 다음 글에 조작된 미리보기가 복사된다.
 */
export function isSameSiteUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const ua = parseHttpUrl(a);
  const ub = parseHttpUrl(b);
  if (!ua || !ub) return false;
  const ha = siteKey(ua.hostname);
  const hb = siteKey(ub.hostname);
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
}

function deviceHasContent(device: SanitizedDevice | null): boolean {
  return !!device && !!(device.title || device.description || device.imageUrl);
}

function hasAnyField(fields: PreviewFields): boolean {
  return !!(fields.title || fields.description || fields.author || fields.imageCandidates.length > 0);
}

// ---------------------------------------------------------------------------
// claim · UPDATE
// ---------------------------------------------------------------------------

function toClaimRow(value: unknown): ClaimRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isInteger(id) || id <= 0 || typeof r.url !== 'string' || typeof r.group_id !== 'string') return null;
  return {
    id,
    url: r.url,
    folder_id: Number(r.folder_id),
    group_id: r.group_id,
    attempts: Number.isFinite(Number(r.attempts)) ? Number(r.attempts) : 1,
    prev_image_path: asText(r.prev_image_path),
    hint_title: asText(r.hint_title),
  };
}

/**
 * claim_post_preview — 한 행을 원자적으로 fetching 으로 바꾸며 선점한다. 0행이면 null(다른 워커가 쥐고 있거나·끝났거나·상한).
 * RPC 자체가 실패(005 미적용 등)하면 던진다 — 선점 없이는 어떤 UPDATE 도 하지 않기 위해 호출자가 바로 끝낸다.
 */
export async function claimPost(admin: ProcessAdminClient, postId: number, force = false): Promise<ClaimRow | null> {
  const { data, error } = await admin.rpc('claim_post_preview', { p_post_id: postId, p_force: force });
  if (error) throw new Error(`claim_failed: ${error.message}`);
  return toClaimRow(data);
}

/** claim 이 0행일 때의 결과 — 현재 상태를 한 번 읽어 in_progress / max_attempts / not_found 를 가른다. */
async function skippedEntry(admin: ProcessAdminClient, postId: number): Promise<ResultEntry> {
  const { data } = await admin.from(POSTS_TABLE).select('preview_status, preview_attempts').eq('id', postId).limit(1);
  const row = data?.[0];
  if (!row) return { post_id: postId, status: 'failed', skipped: 'not_found' };
  const status = asStatus(row.preview_status) ?? 'pending';
  const attempts = Number(row.preview_attempts) || 0;
  // failed 인데 선점이 안 됐으면 attempts ≥ 3 뿐이다. 그 외(ready·unsupported·살아있는 fetching) 는 "지금 할 일 없음"
  const skipped: SkipReason = status === 'failed' || attempts >= BUDGET.maxAttempts ? 'max_attempts' : 'in_progress';
  return { post_id: postId, status, skipped };
}

async function updatePost(
  admin: ProcessAdminClient,
  postId: number,
  values: Partial<PreviewUpdate>,
): Promise<QueryError | null> {
  const { error } = await admin.from(POSTS_TABLE).update(values).eq('id', postId);
  return error;
}

/**
 * 어떤 예외에도 행을 fetching 에 남겨두지 않는다 — 그러면 2분 동안 아무도 못 건드린다. 상태·에러·시각만 쓰는 최소 UPDATE.
 * 이것까지 실패하면 로그만 남긴다 (stale 2분 뒤 재선점).
 */
async function writeFailure(
  admin: ProcessAdminClient,
  postId: number,
  code: string,
  now: () => number,
  log: PreviewLogger,
  extra: Partial<PreviewUpdate> = {},
): Promise<void> {
  const error = await updatePost(admin, postId, {
    ...extra,
    preview_status: 'failed',
    preview_error: clampError(code),
    preview_fetched_at: new Date(now()).toISOString(),
    preview_claimed_at: null,
  });
  if (error) log('update_failed', { post_id: postId, error: error.message.slice(0, 120) });
}

// ---------------------------------------------------------------------------
// outcome → 저장 모양
// ---------------------------------------------------------------------------

interface Resolved {
  status: PreviewStatus;
  fields: PreviewFields;
  source: PreviewSource | null;
  error: string | null;
  task: ClientTask | null;
}

function resolveOutcome(outcome: ProviderOutcome, canonicalUrl: string): Resolved {
  switch (outcome.kind) {
    case 'ready':
      return { status: 'ready', fields: outcome.fields, source: outcome.source, error: null, task: null };
    case 'needs_client':
      return {
        status: 'needs_client',
        fields: outcome.fields ?? emptyFields({ canonicalUrl }),
        source: null,
        error: outcome.error,
        task: outcome.task,
      };
    case 'unsupported':
      return {
        status: 'unsupported',
        fields: outcome.fields ?? emptyFields({ canonicalUrl }),
        source: null,
        error: outcome.error,
        task: null,
      };
    case 'failed':
      return {
        status: isPermanentFailure(outcome.error) ? 'unsupported' : 'failed',
        fields: emptyFields({ canonicalUrl }),
        source: null,
        error: outcome.error,
        task: null,
      };
  }
}

const NO_IMAGE: CopyImageResult = { imageUrl: null, imagePath: null, imageSrc: null, error: null };

function buildUpdate(
  adapterId: string,
  fields: PreviewFields,
  canonicalUrl: string,
  image: CopyImageResult,
  status: PreviewStatus,
  source: PreviewSource | null,
  error: string | null,
  nowMs: number,
): PreviewUpdate {
  const n = normalizeFields(fields);
  return {
    preview_title: n.title,
    preview_description: n.description,
    preview_author: n.author,
    preview_site_name: n.siteName,
    preview_image_url: image.imageUrl,
    preview_image_path: image.imagePath,
    preview_image_src: image.imageSrc,
    preview_canonical_url: n.canonicalUrl ?? canonicalUrl,
    preview_provider: adapterId,
    preview_source: source,
    preview_status: status,
    preview_error: clampError(error),
    preview_fetched_at: new Date(nowMs).toISOString(),
    preview_claimed_at: null,
    preview_assisted_by: null, // 서버가 새로 수집했으니 이전 보조 기록은 지운다
  };
}

function resultOf(claim: ClaimRow, update: PreviewUpdate, task: ClientTask | null): ResultEntry {
  const entry: ResultEntry = {
    post_id: claim.id,
    status: update.preview_status,
    source: update.preview_source,
    error: update.preview_error,
  };
  if (update.preview_status === 'needs_client' && task) {
    entry.client_task = { post_id: claim.id, folder_id: claim.folder_id, ...task };
  }
  return entry;
}

// ---------------------------------------------------------------------------
// canonical 재활용 — 같은 그룹에 같은 canonical 의 ready 행이 있으면 네트워크 0회
// ---------------------------------------------------------------------------

interface Donor {
  title: string | null;
  description: string | null;
  author: string | null;
  siteName: string | null;
  imagePath: string | null;
  imageSrc: string | null;
  provider: string | null;
  source: PreviewSource | null;
}

async function findDonor(
  admin: ProcessAdminClient,
  claim: ClaimRow,
  canonicalUrl: string,
  nowMs: number,
  log: PreviewLogger,
): Promise<Donor | null> {
  try {
    const since = new Date(nowMs - CANONICAL_REUSE_MS).toISOString();
    const { data, error } = await admin
      .from(POSTS_TABLE)
      .select(
        'id, preview_title, preview_description, preview_author, preview_site_name, preview_image_path, preview_image_src, preview_provider, preview_source',
      )
      .eq('group_id', claim.group_id)
      .eq('preview_canonical_url', canonicalUrl)
      .eq('preview_status', 'ready')
      .neq('id', claim.id)
      .gte('preview_fetched_at', since)
      .order('preview_fetched_at', { ascending: false })
      .limit(1);
    if (error) {
      log('reuse_lookup_failed', { post_id: claim.id, error: error.message.slice(0, 120) });
      return null;
    }
    const row = data?.[0];
    if (!row) return null;
    const donor: Donor = {
      title: asText(row.preview_title),
      description: asText(row.preview_description),
      author: asText(row.preview_author),
      siteName: asText(row.preview_site_name),
      imagePath: asText(row.preview_image_path),
      imageSrc: asText(row.preview_image_src),
      provider: asText(row.preview_provider),
      source: asSource(row.preview_source),
    };
    // 도메인 카드(제목·이미지 둘 다 없음) 를 복사하는 건 의미가 없다 — 새로 받아오는 쪽이 나을 수 있다
    return donor.title || donor.imagePath ? donor : null;
  } catch (err) {
    log('reuse_lookup_failed', { post_id: claim.id, error: errorMessage(err).slice(0, 120) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// processPost — 세 수집 경로의 공통 본체
// ---------------------------------------------------------------------------

interface Target {
  url: URL;
  adapter: SiteAdapter;
  fetchUrl: string;
  canonicalUrl: string;
}

/** posts.url → 어댑터 + fetch/canonical URL. 파싱 불가(http(s) 아님) 면 null. canonicalize 가 던지면 기본 구현으로. */
function resolveTarget(postUrl: string): Target | null {
  const url = parseHttpUrl(postUrl);
  if (!url) return null;
  const adapter = resolveAdapter(url);
  let canon = canonicalize(url);
  if (adapter.canonicalize) {
    try {
      canon = adapter.canonicalize(url);
    } catch {
      // 어댑터 canonicalize 버그가 수집 전체를 막지 않게 — 기본 canonical 로 진행
    }
  }
  return { url, adapter, fetchUrl: canon.fetchUrl, canonicalUrl: canon.canonicalUrl };
}

/**
 * 한 글을 끝까지 처리하고 결과 한 줄을 돌려준다. 어떤 경우에도 던지지 않는다.
 *   claim 0행 → skipped · URL 불량 → unsupported('bad_url') · canonical 재활용(비-force) → ready · 아니면 adapter.run →
 *   device 힌트로 빈 필드 보충(서버가 못 받았는데 폰이 받았으면 ready/'device') → 제목 없으면 hint_title('hint') →
 *   이미지 후보 복사(어댑터 imageHosts) → 단일 UPDATE. 예외는 failed + 'unexpected:<msg>'.
 */
export async function processPost(
  admin: ProcessAdminClient,
  io: PreviewIO,
  postId: number,
  opts: ProcessOptions = {},
): Promise<ResultEntry> {
  const log = opts.log ?? noopLog;
  const now = opts.now ?? Date.now;
  const started = now();

  let claim: ClaimRow | null;
  try {
    claim = await claimPost(admin, postId, opts.force === true);
  } catch (err) {
    log('claim_failed', { post_id: postId, error: errorMessage(err).slice(0, 120) });
    return { post_id: postId, status: 'failed', error: 'claim_failed' };
  }
  if (!claim) {
    try {
      return await skippedEntry(admin, postId);
    } catch {
      return { post_id: postId, status: 'failed', skipped: 'in_progress' };
    }
  }

  const hintTitle = normalizeText(opts.hintTitle ?? claim.hint_title, FIELD_LIMITS.title, { singleLine: true });

  try {
    const target = resolveTarget(claim.url);
    if (!target) {
      const update = buildUpdate(
        'generic',
        emptyFields({ title: hintTitle }),
        claim.url,
        NO_IMAGE,
        'unsupported',
        hintTitle ? 'hint' : null,
        'bad_url',
        now(),
      );
      const error = await updatePost(admin, claim.id, update);
      if (error) throw new Error(`update: ${error.message}`);
      log('process.done', { post_id: claim.id, provider: 'generic', status: 'unsupported', error: 'bad_url' });
      return resultOf(claim, update, null);
    }
    const { adapter, fetchUrl, canonicalUrl } = target;
    const host = target.url.hostname;
    // 폰 힌트는 어댑터를 알고 나서 정제한다 — 인스타 캡션 저장 정책(applyCaptionPolicy) 이 어댑터에 달려 있다
    const device = applyCaptionPolicy(sanitizeDeviceHints(opts.device), adapter, opts.storeCaption === true);
    // 어댑터는 remainingMs(ctx) 로 Date.now() 와 비교하므로 deadline 은 실제 시계 기준이어야 한다 (opts.now 는 기록 시각 전용)
    const deadline = Date.now() + (opts.postTimeoutMs ?? BUDGET.postTimeoutMs);

    // 1) canonical 재활용 — 같은 그룹이 같은 글을 이미 받아뒀으면 복사만 (force 는 "다시 받아와라" 이므로 건너뛴다)
    if (!opts.force) {
      const donor = await findDonor(admin, claim, canonicalUrl, now(), log);
      if (donor) {
        const copied = donor.imagePath ? await copyExistingImage(admin, donor.imagePath, claim.id, log) : null;
        let fields = mergeDeviceFields(
          {
            title: donor.title,
            description: donor.description,
            author: donor.author,
            siteName: donor.siteName,
            canonicalUrl,
            imageCandidates: [],
          },
          device && !device.blocked ? device : null,
        );
        let source: PreviewSource | null = donor.source ?? 'og';
        if (!fields.title && hintTitle) {
          fields = { ...fields, title: hintTitle };
          source = 'hint';
        }
        const image: CopyImageResult = copied
          ? { imageUrl: copied.imageUrl, imagePath: copied.imagePath, imageSrc: donor.imageSrc, error: null }
          : { ...NO_IMAGE, imageSrc: donor.imageSrc, error: donor.imagePath ? 'image:copy_existing' : null };
        const update = buildUpdate(
          donor.provider ?? adapter.id,
          fields,
          canonicalUrl,
          image,
          'ready',
          source,
          image.error,
          now(),
        );
        const error = await updatePost(admin, claim.id, update);
        if (error) throw new Error(`update: ${error.message}`);
        log('process.done', {
          post_id: claim.id,
          provider: update.preview_provider,
          status: 'ready',
          reused: true,
          host,
          ms: now() - started,
        });
        return resultOf(claim, update, null);
      }
    }

    // 2) provider 실행 — serverFetch:false 어댑터는 네트워크 없이 바로 outcome 을 준다
    const ctx: ProviderCtx = {
      postUrl: claim.url,
      fetchUrl,
      canonicalUrl,
      io,
      deadline,
      log,
      hintTitle,
      attempts: claim.attempts,
      device: opts.device ?? null,
    };
    let outcome: ProviderOutcome;
    try {
      outcome = await withDeadline(adapter.run(ctx), deadline);
    } catch (err) {
      outcome = { kind: 'failed', error: providerErrorCode(err) };
    }
    let { status, fields, source, error, task } = resolveOutcome(outcome, canonicalUrl);

    // 3) 폰 힌트 — ready 면 빈 필드만 채운다. 서버가 못 받았는데(차단·일시 실패) 폰은 제목/이미지를 받았으면 그게 곧 결과다:
    //    서버의 자리표시 제목보다 폰이 읽은 제목이 우선이고 상태는 ready/'device' 가 된다. unsupported(삭제·404) 는 그대로
    if (device && !device.blocked) {
      fields = mergeDeviceFields(fields, device, status !== 'ready');
      if (status !== 'ready' && status !== 'unsupported' && deviceHasContent(device)) {
        status = 'ready';
        source = 'device';
        error = null;
        task = null;
      }
    }

    // 4) 공유 텍스트 제목 힌트 — 서버 제목이 없을 때만, 출처는 'hint'. 어댑터가 ctx.hintTitle 을 직접 제목으로 쓴 경우
    //    (쿠팡·스마트스토어·무신사 자리표시 제목) 도 출처는 같다
    if (!fields.title && hintTitle) {
      fields = { ...fields, title: hintTitle };
      source = 'hint';
    } else if (hintTitle && source === null && fields.title === hintTitle) {
      source = 'hint';
    }

    // 5) 이미지 — 후보가 있으면 상태와 무관하게 복사한다 (needs_client 의 브랜드 카드 이미지도 여기서). 실패는 상태 실패가 아니다
    let image: CopyImageResult = NO_IMAGE;
    if (fields.imageCandidates.length > 0) {
      image = await copyImageToStorage(admin, claim.id, fields.imageCandidates, {
        ...opts.imageDeps,
        imageHosts: adapter.imageHosts,
        deadline,
        log,
      });
    }

    // 6) 단일 UPDATE — 이전 이미지 경로의 tombstone 은 DB 트리거(on_post_preview_image_replaced) 가 쌓는다
    const update = buildUpdate(adapter.id, fields, canonicalUrl, image, status, source, error ?? image.error, now());
    const updateError = await updatePost(admin, claim.id, update);
    if (updateError) throw new Error(`update: ${updateError.message}`);
    log('process.done', {
      post_id: claim.id,
      provider: adapter.id,
      status,
      source,
      error: update.preview_error,
      host,
      image: image.imageUrl ? 'copied' : (image.error ?? 'none'),
      ms: now() - started,
    });
    return resultOf(claim, update, task);
  } catch (err) {
    const code = `unexpected:${errorMessage(err).slice(0, 80)}`;
    log('process.unexpected', { post_id: claim.id, error: code });
    await writeFailure(admin, claim.id, code, now, log);
    return { post_id: claim.id, status: 'failed', error: clampError(code) };
  }
}

// ---------------------------------------------------------------------------
// 배치 — 동시 2 (CPU 2 s/요청 예산: 인스타 512 KB·틱톡 1 MiB 정규식이 겹치지 않게)
// ---------------------------------------------------------------------------

export interface ProcessManyOptions extends ProcessOptions {
  /** 기본 BUDGET.concurrency(2). */
  concurrency?: number;
  /** 한 건이 끝날 때마다. 예산 초과 시 부분 결과를 돌려주는 데 쓴다. */
  onResult?: (entry: ResultEntry) => void;
}

/** 입력 순서대로 결과를 돌려준다. 각 건은 processPost 가 자체 try/catch 를 가지므로 전체가 reject 되는 일은 없다. */
export async function processMany(
  admin: ProcessAdminClient,
  io: PreviewIO,
  postIds: readonly number[],
  opts: ProcessManyOptions = {},
): Promise<ResultEntry[]> {
  const ids = Array.from(new Set(postIds));
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? BUDGET.concurrency, ids.length || 1));
  const results = new Array<ResultEntry>(ids.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const entry = await processPost(admin, io, ids[i], opts);
      results[i] = entry;
      opts.onResult?.(entry);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export interface BudgetedResult {
  /** 입력 순서. 예산 안에 못 끝난 건은 { status:'fetching', skipped:'in_progress' } — 백그라운드에서 계속된다. */
  results: ResultEntry[];
  /** 남은 작업. null 이면 전부 끝났다. 호출자는 EdgeRuntime.waitUntil 에 넘긴다. */
  pending: Promise<void> | null;
}

/**
 * 응답 예산(ms) 안에 끝난 것만 결과로 돌려주고 나머지는 계속 돌린다. 단건 저장 직후 호출은 동기 결과가 UI 에 바로 유용하지만,
 * 배치 8건이 25 s 씩 걸리면 클라이언트 요청이 먼저 끊긴다 — 그래서 20 s 에서 끊고 waitUntil 로 넘긴다.
 */
export async function processManyWithBudget(
  admin: ProcessAdminClient,
  io: PreviewIO,
  postIds: readonly number[],
  budgetMs: number,
  opts: ProcessManyOptions = {},
): Promise<BudgetedResult> {
  const ids = Array.from(new Set(postIds));
  const done = new Map<number, ResultEntry>();
  const all = processMany(admin, io, ids, {
    ...opts,
    onResult: (entry) => {
      done.set(entry.post_id, entry);
      opts.onResult?.(entry);
    },
  }).then((): void => undefined);
  const timer = sleep(Math.max(0, budgetMs));
  const finished = await Promise.race([all.then(() => true), timer.promise.then(() => false)]);
  timer.cancel();
  const results = ids.map(
    (id): ResultEntry => done.get(id) ?? { post_id: id, status: 'fetching', skipped: 'in_progress' },
  );
  return { results, pending: finished ? null : all };
}

// ---------------------------------------------------------------------------
// assist — 폰(주거용 IP) 이 받아온 결과를 서버 규칙으로 해석해 저장
// ---------------------------------------------------------------------------

export interface AssistOptions {
  log?: PreviewLogger;
  now?: () => number;
  /** env INSTAGRAM_STORE_CAPTION=full. */
  storeCaption?: boolean;
  /** 이미지 복사 예산(ms). 기본 BUDGET.postTimeoutMs. */
  timeoutMs?: number;
  /** 이미지 복사의 fetch·DNS 주입 (bun 테스트용). */
  imageDeps?: Pick<PreviewIODeps, 'fetchImpl' | 'resolve'>;
}

/**
 * 가시성·owner/editor·상태(needs_client|failed) 검사는 index.ts 가 userClient 로 끝낸 뒤 들어온다. 여기서도 claim 을 거친다 —
 * sweep 과 경합하지 않기 위해. 기존 preview_* 는 지우지 않고(브랜드 카드 라벨·힌트 제목 유지) 폰이 가져온 값만 덧쓴다.
 *   blocked → failed('needs:webview' | 'device_blocked')  ·  빈 결과 → failed('device_empty')  ·  아니면 ready('device').
 * 폰 canonical(device.canonical_url·제출 HTML 의 og:url) 은 posts.url 과 같은 사이트일 때만 저장한다 (isSameSiteUrl).
 * 인스타 description 은 storeCaption 일 때만 (applyCaptionPolicy).
 */
export async function applyAssist(
  admin: ProcessAdminClient,
  postId: number,
  device: DeviceHints,
  assistedBy: string,
  opts: AssistOptions = {},
): Promise<ResultEntry> {
  const log = opts.log ?? noopLog;
  const now = opts.now ?? Date.now;
  const started = now();

  let claim: ClaimRow | null;
  try {
    claim = await claimPost(admin, postId, false);
  } catch (err) {
    log('claim_failed', { post_id: postId, error: errorMessage(err).slice(0, 120) });
    return { post_id: postId, status: 'failed', error: 'claim_failed' };
  }
  if (!claim) {
    try {
      return await skippedEntry(admin, postId);
    } catch {
      return { post_id: postId, status: 'failed', skipped: 'in_progress' };
    }
  }

  const base: Partial<PreviewUpdate> = { preview_assisted_by: assistedBy };
  try {
    const target = resolveTarget(claim.url);
    if (!target) {
      await writeFailure(admin, claim.id, 'bad_url', now, log, base);
      return { post_id: claim.id, status: 'failed', error: 'bad_url' };
    }
    const { adapter, canonicalUrl } = target;
    const host = target.url.hostname;
    const hints = applyCaptionPolicy(sanitizeDeviceHints(device), adapter, opts.storeCaption === true);

    // 폰도 막혔다 — 다음 단계는 WebView(v2) 뿐이다. 코드가 'needs:webview' 면 catch-up 이 폰 fetch 를 다시 시키지 않는다
    if (hints?.blocked) {
      const code = adapter.serverFetch === false || hints.httpStatus !== null ? 'needs:webview' : 'device_blocked';
      await writeFailure(admin, claim.id, code, now, log, base);
      log('assist.done', {
        post_id: claim.id,
        provider: adapter.id,
        status: 'failed',
        error: code,
        host,
        http_status: hints.httpStatus,
      });
      return { post_id: claim.id, status: 'failed', error: code };
    }

    // 폰 canonical 은 posts.url(또는 서버가 그로부터 계산한 canonical) 과 같은 사이트일 때만 믿는다 — 파서의 기준 URL 로도,
    // 저장값으로도. 아니면 서버 canonical 로 돌아가고 preview_canonical_url 은 폰 값으로 쓰지 않는다 (findDonor 오염 방지)
    const trustedCanonical = (u: string | null): string | null =>
      u && (isSameSiteUrl(u, claim.url) || isSameSiteUrl(u, canonicalUrl)) ? u : null;
    const safeHints = hints ? { ...hints, canonicalUrl: trustedCanonical(hints.canonicalUrl) } : null;
    const finalUrl = safeHints?.canonicalUrl ?? canonicalUrl;
    const submitted = safeHints?.html
      ? parseSubmittedHtml(adapter, safeHints.html, finalUrl, { storeCaption: opts.storeCaption })
      : null;
    const parsed = submitted ? { ...submitted, canonicalUrl: trustedCanonical(submitted.canonicalUrl) } : null;
    const merged = parsed ? mergeDeviceFields(parsed, safeHints) : mergeDeviceFields(emptyFields(), safeHints);
    const fields = normalizeFields({ ...merged, canonicalUrl: merged.canonicalUrl ?? canonicalUrl });

    if (!hasAnyField(fields)) {
      // 빈 결과도 종결해야 catch-up 이 같은 글을 무한히 다시 돌리지 않는다 (설계 §8-4)
      await writeFailure(admin, claim.id, 'device_empty', now, log, base);
      log('assist.done', { post_id: claim.id, provider: adapter.id, status: 'failed', error: 'device_empty', host });
      return { post_id: claim.id, status: 'failed', error: 'device_empty' };
    }

    let image: CopyImageResult = NO_IMAGE;
    if (fields.imageCandidates.length > 0) {
      image = await copyImageToStorage(admin, claim.id, fields.imageCandidates, {
        ...opts.imageDeps,
        imageHosts: adapter.imageHosts,
        deadline: Date.now() + (opts.timeoutMs ?? BUDGET.postTimeoutMs),
        log,
      });
    }

    // 부분 UPDATE — 폰이 못 채운 컬럼은 건드리지 않는다 (needs_client 때 저장된 '쿠팡'·'네이버 지도' 라벨과 힌트 제목이 살아야 한다)
    const update: Partial<PreviewUpdate> = {
      ...base,
      preview_status: 'ready',
      preview_source: 'device',
      preview_provider: adapter.id,
      preview_error: clampError(image.error),
      preview_fetched_at: new Date(now()).toISOString(),
      preview_claimed_at: null,
    };
    if (fields.title) update.preview_title = fields.title;
    if (fields.description) update.preview_description = fields.description;
    if (fields.author) update.preview_author = fields.author;
    if (fields.siteName) update.preview_site_name = fields.siteName;
    if (parsed?.canonicalUrl) update.preview_canonical_url = fields.canonicalUrl;
    if (image.imageUrl) {
      update.preview_image_url = image.imageUrl;
      update.preview_image_path = image.imagePath;
      update.preview_image_src = image.imageSrc;
    } else if (image.imageSrc) {
      update.preview_image_src = image.imageSrc;
    }
    const error = await updatePost(admin, claim.id, update);
    if (error) throw new Error(`update: ${error.message}`);
    log('assist.done', {
      post_id: claim.id,
      provider: adapter.id,
      status: 'ready',
      parsed: parsed !== null,
      image: image.imageUrl ? 'copied' : (image.error ?? 'none'),
      host,
      ms: now() - started,
    });
    return { post_id: claim.id, status: 'ready', source: 'device', error: update.preview_error ?? null };
  } catch (err) {
    const code = `unexpected:${errorMessage(err).slice(0, 80)}`;
    log('assist.unexpected', { post_id: claim.id, error: code });
    await writeFailure(admin, claim.id, code, now, log, base);
    return { post_id: claim.id, status: 'failed', error: clampError(code) };
  }
}
