// Supabase Edge Function: link-preview
//
// 목적: 링크 미리보기(제목·설명·작성자·썸네일)를 "저장 시점에 서버가 1회" 수집해 posts.preview_* 에 보관한다.
//   - 지금은 모든 기기가 카드마다 Microlink(무료 5회/일/IP → 429) → 기기 HTML 파싱을 반복해 인스타 링크 절반이 빈 카드로
//     보이고, 인스타 썸네일 CDN URL(oe= 서명) 은 4~5일 뒤 만료된다. 썸네일은 Storage 공개 버킷 link-previews 로 복사해
//     https URL 만 저장한다 (Android cleartext 차단 — memory: kakao-http-avatar-cleartext).
//   - 데이터센터 IP 가 차단되는 사이트(인스타 임베드·무신사·네이버 쇼핑 …) 는 needs_client 로 두고 사용자의 폰이 1회 보조한다.
//
// 처리 순서 (설계 §5):
//   1) OPTIONS → ok. POST 외 405. 바디 JSON ≤ 8 KB (assist 는 device.html 때문에 ≤ 320 KB).
//   2) 인증 — 두 갈래. 둘 다 아니면 401 {step:'auth'}.
//      (B) x-webhook-secret 헤더 == env LINK_PREVIEW_WEBHOOK_SECRET (상수시간 비교, env 없으면 401) → webhook | sweep 만
//      (A) Authorization: Bearer <user JWT> → userClient.auth.getUser() → fetch | assist 만
//   3) 모드별
//      fetch   (user)   : post_id | post_ids(≤8) → userClient 로 select (RLS 가 보여주는 행만, 안 보이면 skipped 'not_found')
//                         → device·force 가 실리면 is_group_member(owner/editor) 아니면 403 'forbidden' (post_ids 와 함께면 400)
//                         → force 는 60 s 쿨다운(429 'cooldown'), 비-force 는 attempts ≥ 5 면 'max_attempts'
//                         → process.ts 가 동시 2 로 처리. 20 s 안에 못 끝난 건은 'in_progress' 로 돌려주고 waitUntil 로 계속
//                         → 단건 + device 가 다른 워커의 선점에 밀렸으면(webhook 이 먼저 claim) ≤10 s 기다려
//                           needs_client|failed 로 끝나면 applyAssist 로 힌트를 적용한다 (rescueDeviceHints)
//      webhook (secret) : DB 트리거(pg_net). 선점 가능성만 확인하고 202 {accepted:true} → EdgeRuntime.waitUntil(processPost)
//      sweep   (secret) : pick_preview_jobs(limit ≤ 20) → 순차 processPost, 60 s 예산 → 200 {processed}
//      assist  (user)   : 폰 파싱 결과 제출. 가시성 → is_group_member(owner/editor) 아니면 403 → 상태 needs_client|failed 만
//                         → process.ts applyAssist (claim 경유, 서버 파서로 재해석, 이미지는 재다운로드)
//      모든 fetch/sweep/assist 응답 직전(webhook 은 백그라운드 끝) tombstone 상위 10건 Storage GC (실패 무시).
//   4) 함수는 요청 바디의 URL 을 절대 fetch 하지 않는다 — 수집 대상은 DB 의 posts.url 만 (바디 URL 을 믿으면 SSRF 프록시가 된다).
//      device.image_url 하나만 예외이며 https + 어댑터 imageHosts + SSRF + 매직바이트 재다운로드 뒤에만 저장된다 (process.ts).
//   5) 어떤 UPDATE 도 claim_post_preview(원자 선점) 없이는 일어나지 않는다 (process.ts). 실패 응답은 {success:false, step, error}.
//
// 배포:
//   supabase functions deploy link-preview --no-verify-jwt
//   (JWT 검증은 함수 내부에서 직접 수행하므로 --no-verify-jwt 사용. 웹훅은 JWT 가 없다)
//   배포 전 검증: bun test supabase/functions/link-preview (순수 모듈 + process.ts; 이 Mac 에 deno 가 없다)
//
// 필요한 환경변수 (Supabase 가 자동 주입):
//   - SUPABASE_URL
//   - SUPABASE_ANON_KEY
//   - SUPABASE_SERVICE_ROLE_KEY
// 선택 (Dashboard → Edge Functions → Secrets):
//   - LINK_PREVIEW_WEBHOOK_SECRET : Vault 의 link_preview_webhook_secret 과 같은 값. 없으면 webhook/sweep 은 전부 401
//   - INSTAGRAM_STORE_CAPTION     : 'full' 이면 인스타 캡션 전체를 설명에 저장 (기본: 첫 줄 제목만)
//   - MICROLINK_API_KEY           : v1 미구현 자리 — 값이 있어도 아직 아무 효과 없다

// @ts-nocheck — 이 파일은 Deno 런타임에서 실행된다. Node/Expo용 TypeScript
// 서버는 URL import와 Deno 전역을 이해하지 못하므로 편집기 진단만 꺼둔다.
// 실제 타입 체크와 린팅은 `supabase/functions/deno.json` + Deno 확장이 담당.
// (process.ts·sites/*.ts 등 순수 모듈은 URL import 가 없어 bun 테스트와 scratch tsc 로 따로 검증된다.)
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders } from '../_shared/cors.ts';
import { createPreviewIO, readCapped } from './fetch.ts';
import { removeTombstones } from './image.ts';
import { applyAssist, processManyWithBudget, processPost, sanitizeDeviceHints } from './process.ts';
import { BUDGET } from './types.ts';
import type { DeviceHints, PreviewLogger, PreviewStatus, Res, ResultEntry } from './types.ts';

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

const BODY_MAX_BYTES = 8 * 1024; // fetch/webhook/sweep
const ASSIST_BODY_MAX_BYTES = 320 * 1024; // device.html ≤ 256 KB + 나머지 필드
const FETCH_BUDGET_MS = 20_000; // 이 안에 끝난 건만 동기 결과, 나머지는 waitUntil
const SWEEP_BUDGET_MS = 60_000;
const MAX_POST_ID = 999_999_999_999; // image.ts 의 경로 규칙(posts/<id ≤ 12자리>) 과 동일
const TOMBSTONE_GC_LIMIT = 10;
// 단건 fetch 가 선점 경합에 밀렸을 때(rescueDeviceHints) 다른 워커를 기다리는 폴링
const RACE_POLL_MS = 750;
const RACE_WAIT_MAX_MS = 10_000; // FETCH_BUDGET 잔여와 min
const RACE_ASSIST_RESERVE_MS = 4_000; // 기다린 뒤 applyAssist(이미지 재다운로드) 에 남겨둘 최소 예산

// ---------------------------------------------------------------------------
// 공용 헬퍼
// ---------------------------------------------------------------------------

function jsonResponse(body: Res, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

/** 로그는 post_id·host·status·error 코드만 — URL·제목·본문은 어댑터와 process.ts 가 이미 넣지 않는다. */
const log: PreviewLogger = (event, extra) => {
  console.log('[link-preview]', event, extra ? JSON.stringify(extra) : '');
};

/**
 * 상수시간 비교 — 길이가 다르면 즉시 false(길이는 비밀이 아니다), 같으면 끝까지 XOR 을 누적해 어느 자리에서 틀렸는지가
 * 응답 시간에 드러나지 않게 한다. `===` 는 첫 불일치에서 멈춘다.
 */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** 202 뒤에도 isolate 를 살려 두는 Edge Runtime API. 로컬 deno 처럼 없으면 그냥 띄워 둔다(응답 뒤 종료될 수 있음). */
function runInBackground(work: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const guarded = work.catch((err) => log('background_failed', { error: String(err).slice(0, 120) }));
  if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(guarded);
}

async function gcTombstones(adminClient): Promise<void> {
  // 절대 던지지 않는다 (image.ts). 응답을 막지 않도록 실패는 로그만
  await removeTombstones(adminClient, TOMBSTONE_GC_LIMIT, log);
}

function isPostId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_POST_ID;
}

function ageMs(iso: unknown, now: number): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

function asStatus(value: unknown): PreviewStatus {
  return typeof value === 'string' ? (value as PreviewStatus) : 'pending';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * owner/editor 가 아니면 거절 사유(문자열), 맞으면 null. 반드시 userClient 로 — is_group_member 는 auth.uid() 기반이라
 * service_role 로는 항상 false 다. RPC 오류도 거절이다(권한을 확인하지 못했으면 허용하지 않는다).
 */
async function editorDenial(c: Clients, groupId: unknown): Promise<string | null> {
  const { data: allowed, error } = await c.userClient.rpc('is_group_member', {
    p_group: groupId,
    p_roles: ['owner', 'editor'],
  });
  if (error) return error.message;
  return allowed === true ? null : 'owner or editor only';
}

/** 바디를 바이트 캡까지만 읽어 JSON 으로. 캡 초과·JSON 아님·객체 아님 → null. */
async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const { bytes, truncated } = await readCapped(req.body, { maxBytes: maxBytes + 1 });
  if (truncated || bytes.length > maxBytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 모드별 핸들러 — 인증은 serve() 에서 끝났고, 여기서는 입력 검증 + process.ts 호출만
// ---------------------------------------------------------------------------

interface Clients {
  userClient: ReturnType<typeof createClient> | null;
  adminClient: ReturnType<typeof createClient>;
  userId: string | null;
  storeCaption: boolean;
}

/**
 * 단건 fetch 가 선점 경합에 밀렸을 때(다른 워커가 fetching 을 쥐고 있다) 폰 힌트를 버리지 않기 위한 보정.
 * 그 워커가 끝나길 폴링(RACE_POLL_MS 간격, ≤RACE_WAIT_MAX_MS·응답 예산 안) 하고:
 *   needs_client|failed 로 끝남 → applyAssist 로 힌트 적용, 그 결과를 돌려준다 (호출자가 owner/editor 게이트를 이미 지났다)
 *   ready|unsupported 로 끝남   → 관측한 상태만 돌려준다 (힌트 불필요)
 *   아직 fetching · 힌트 없음·blocked · 조회 실패 → null (호출자는 in_progress 를 그대로 — 다음 폴링·폴더 재진입이 가져간다)
 */
async function rescueDeviceHints(
  c: Clients,
  postId: number,
  device: DeviceHints,
  started: number,
): Promise<ResultEntry | null> {
  const hints = sanitizeDeviceHints(device);
  if (!hints || hints.blocked || !(hints.title || hints.description || hints.author || hints.imageUrl)) return null;

  const pollUntil = Math.min(started + FETCH_BUDGET_MS - RACE_ASSIST_RESERVE_MS, Date.now() + RACE_WAIT_MAX_MS);
  let status: PreviewStatus = 'fetching';
  while (status === 'fetching' && Date.now() < pollUntil) {
    await delay(Math.min(RACE_POLL_MS, pollUntil - Date.now()));
    const { data, error } = await c.adminClient.from('posts').select('preview_status').eq('id', postId).limit(1);
    if (error) {
      log('fetch.race_poll_failed', { post_id: postId, error: error.message.slice(0, 120) });
      return null;
    }
    const row = data?.[0];
    if (!row) return null; // 그 사이 삭제됨
    status = asStatus(row.preview_status);
  }
  if (status === 'fetching') return null;
  if (status !== 'needs_client' && status !== 'failed') return { post_id: postId, status };

  // html 은 fetch 바디(≤8 KB) 에 실릴 수 없는 필드 — 텍스트·이미지 힌트만. 이미지 재다운로드는 남은 응답 예산 안에서
  const result = await applyAssist(c.adminClient, postId, { ...device, html: null }, c.userId!, {
    log,
    storeCaption: c.storeCaption,
    timeoutMs: Math.max(1_000, started + FETCH_BUDGET_MS - Date.now()),
  });
  log('fetch.race_assist', { post_id: postId, status: result.status, error: result.error ?? null });
  return result;
}

/** fetch — 저장 직후 가속(post_id + device) · 수동 재시도(force) · 폴더 catch-up(post_ids ≤ 8). */
async function handleFetch(body: Record<string, unknown>, c: Clients): Promise<Response> {
  const started = Date.now();
  let ids: number[];
  let force = false;
  let device: DeviceHints | null = null;

  const hasDevice = body.device !== undefined && body.device !== null;
  if (Array.isArray(body.post_ids)) {
    if (body.post_ids.length === 0 || body.post_ids.length > BUDGET.batchSize) {
      return jsonResponse(
        { success: false, step: 'body', error: `post_ids must have 1..${BUDGET.batchSize} items` },
        400,
      );
    }
    if (!body.post_ids.every(isPostId))
      return jsonResponse({ success: false, step: 'body', error: 'invalid post_ids' }, 400);
    // 배치는 힌트·force 를 받지 않는다 — 조용히 버리면 호출자가 적용된 줄 알 수 있어 거절한다
    if (hasDevice || body.force === true) {
      return jsonResponse({ success: false, step: 'body', error: 'device/force require post_id' }, 400);
    }
    ids = Array.from(new Set(body.post_ids as number[]));
  } else if (isPostId(body.post_id)) {
    ids = [body.post_id];
    force = body.force === true;
    if (hasDevice) {
      if (typeof body.device !== 'object' || Array.isArray(body.device)) {
        return jsonResponse({ success: false, step: 'body', error: 'device must be an object' }, 400);
      }
      device = body.device as DeviceHints;
    }
  } else {
    return jsonResponse({ success: false, step: 'body', error: 'post_id or post_ids required' }, 400);
  }

  // RLS 가 보여주는 행만 — adminClient 로 is_group_member 를 부르면 auth.uid() 가 null 이라 쓸 수 없다
  const { data, error } = await c.userClient
    .from('posts')
    .select('id, group_id, preview_status, preview_attempts, preview_claimed_at, preview_fetched_at')
    .in('id', ids);
  if (error) return jsonResponse({ success: false, step: 'posts', error: error.message }, 500);

  const now = Date.now();
  const visible = new Map<number, Record<string, unknown>>();
  for (const row of data ?? []) visible.set(Number(row.id), row);

  // device·force 는 저장 내용을 바꾼다 — 폰 제목·이미지가 그대로 결과가 되고(process.ts 3단계) force 는 멀쩡한 ready 도
  // 덮어쓴다. 그래서 assist 와 같은 owner/editor 게이트(viewer 는 403). 힌트 없는 fetch 는 서버가 받아오는 것뿐이라 viewer 도 된다
  if (device !== null || force) {
    const row = visible.get(ids[0]);
    if (row) {
      const denied = await editorDenial(c, row.group_id);
      if (denied) {
        return jsonResponse(
          {
            success: false,
            step: 'forbidden',
            error: denied,
            results: [{ post_id: ids[0], status: asStatus(row.preview_status), skipped: 'forbidden' }],
          },
          403,
        );
      }
    }
  }

  const decided = new Map<number, ResultEntry>();
  const toProcess: number[] = [];
  for (const id of ids) {
    const row = visible.get(id);
    if (!row) {
      decided.set(id, { post_id: id, status: 'failed', skipped: 'not_found' });
      continue;
    }
    const status = asStatus(row.preview_status);
    if (force) {
      // 살아있는 선점을 force 로 가로채면 두 워커가 같은 행을 쓴다 — stale(2분) 전에는 기다리게 한다
      const claimedAge = ageMs(row.preview_claimed_at, now);
      if (status === 'fetching' && claimedAge !== null && claimedAge < BUDGET.staleClaimMs) {
        decided.set(id, { post_id: id, status, skipped: 'in_progress' });
        continue;
      }
      const touched = Math.min(
        ageMs(row.preview_claimed_at, now) ?? Number.POSITIVE_INFINITY,
        ageMs(row.preview_fetched_at, now) ?? Number.POSITIVE_INFINITY,
      );
      if (touched < BUDGET.forceCooldownMs) {
        return jsonResponse(
          {
            success: false,
            step: 'cooldown',
            error: 'retry later',
            results: [{ post_id: id, status, skipped: 'cooldown' }],
          },
          429,
        );
      }
    } else {
      if (status === 'ready' || status === 'unsupported') {
        decided.set(id, { post_id: id, status }); // 이미 끝난 행 — 그대로 알려준다
        continue;
      }
      if (Number(row.preview_attempts) >= BUDGET.maxAttempts) {
        decided.set(id, { post_id: id, status, skipped: 'max_attempts' });
        continue;
      }
    }
    toProcess.push(id);
  }

  let pending: Promise<void> | null = null;
  if (toProcess.length > 0) {
    const io = createPreviewIO({ log });
    const budgeted = await processManyWithBudget(c.adminClient, io, toProcess, FETCH_BUDGET_MS, {
      force,
      device: ids.length === 1 ? device : null,
      log,
      storeCaption: c.storeCaption,
    });
    for (const entry of budgeted.results) decided.set(entry.post_id, entry);
    pending = budgeted.pending;
  }

  // 저장 직후 가속 호출은 DB 트리거 webhook 과 거의 동시에 도착해 보통 선점에 진다 — 그러면 processPost 가 opts.device 를 읽지
  // 못한 채 in_progress 로 끝나 폰 힌트가 사라진다. device 는 post_id 경로에만 있고(단건), pending 이 있으면 우리 워커가 아직
  // 돌고 있는 것(힌트는 그 안에 있다) 이라 기다리지 않는다
  if (device !== null && ids.length === 1 && pending === null) {
    const entry = decided.get(ids[0])!;
    if (entry.skipped === 'in_progress' && entry.status === 'fetching') {
      const rescued = await rescueDeviceHints(c, ids[0], device, started);
      if (rescued) decided.set(ids[0], rescued);
    }
  }

  if (pending) {
    runInBackground(pending.then(() => gcTombstones(c.adminClient)));
  } else {
    await gcTombstones(c.adminClient);
  }
  return jsonResponse({ success: true, results: ids.map((id) => decided.get(id)!) });
}

/** webhook — DB 트리거(pg_net, 5 s 타임아웃) 가 부르므로 바로 202 를 주고 백그라운드에서 처리한다. */
async function handleWebhook(body: Record<string, unknown>, c: Clients): Promise<Response> {
  if (!isPostId(body.post_id)) return jsonResponse({ success: false, step: 'body', error: 'post_id required' }, 400);
  const postId = body.post_id;

  const { data, error } = await c.adminClient
    .from('posts')
    .select('id, group_id, preview_status, preview_attempts, preview_claimed_at')
    .eq('id', postId)
    .limit(1);
  if (error) return jsonResponse({ success: false, step: 'posts', error: error.message }, 500);
  const row = data?.[0];
  if (!row) return jsonResponse({ success: false, step: 'post', error: 'not found' }, 404);

  const status = asStatus(row.preview_status);
  const claimedAge = ageMs(row.preview_claimed_at, Date.now());
  const claimable =
    row.group_id !== null &&
    (status === 'pending' ||
      status === 'needs_client' ||
      (status === 'failed' && Number(row.preview_attempts) < 3) ||
      (status === 'fetching' && (claimedAge === null || claimedAge >= BUDGET.staleClaimMs)));
  if (!claimable) {
    return jsonResponse({ success: true, accepted: false, results: [{ post_id: postId, status }] });
  }

  const io = createPreviewIO({ log });
  runInBackground(
    processPost(c.adminClient, io, postId, { log, storeCaption: c.storeCaption }).then(() =>
      gcTombstones(c.adminClient),
    ),
  );
  return jsonResponse({ success: true, accepted: true }, 202);
}

/** sweep — 큐 후보(pick_preview_jobs) 를 순차 처리. 60 s 예산 안에서만 다음 건을 시작한다. */
async function handleSweep(body: Record<string, unknown>, c: Clients): Promise<Response> {
  const requested = typeof body.limit === 'number' && Number.isInteger(body.limit) ? body.limit : BUDGET.batchSize;
  const limit = Math.max(1, Math.min(requested, 20));

  const { data, error } = await c.adminClient.rpc('pick_preview_jobs', { p_limit: limit });
  if (error) return jsonResponse({ success: false, step: 'pick_jobs', error: error.message }, 500);
  const ids = (Array.isArray(data) ? data : []).map((v) => Number(v)).filter(isPostId);

  const started = Date.now();
  const io = createPreviewIO({ log });
  const results: ResultEntry[] = [];
  for (const id of ids) {
    if (Date.now() - started > SWEEP_BUDGET_MS) break;
    results.push(await processPost(c.adminClient, io, id, { log, storeCaption: c.storeCaption }));
  }
  await gcTombstones(c.adminClient);
  log('sweep.done', { picked: ids.length, processed: results.length, ms: Date.now() - started });
  return jsonResponse({ success: true, processed: results.length, results });
}

/** assist — 폰이 받아온 결과 제출. owner/editor 만, 대상 상태 needs_client|failed 만 (ready 덮어쓰기 금지). */
async function handleAssist(body: Record<string, unknown>, c: Clients): Promise<Response> {
  if (!isPostId(body.post_id)) return jsonResponse({ success: false, step: 'body', error: 'post_id required' }, 400);
  if (!body.device || typeof body.device !== 'object' || Array.isArray(body.device)) {
    return jsonResponse({ success: false, step: 'body', error: 'device required' }, 400);
  }
  const postId = body.post_id;
  const device = body.device as DeviceHints;

  const { data, error } = await c.userClient
    .from('posts')
    .select('id, group_id, preview_status')
    .eq('id', postId)
    .limit(1);
  if (error) return jsonResponse({ success: false, step: 'posts', error: error.message }, 500);
  const row = data?.[0];
  if (!row) {
    return jsonResponse({ success: true, results: [{ post_id: postId, status: 'failed', skipped: 'not_found' }] });
  }
  const status = asStatus(row.preview_status);

  const denied = await editorDenial(c, row.group_id);
  if (denied) {
    return jsonResponse(
      {
        success: false,
        step: 'forbidden',
        error: denied,
        results: [{ post_id: postId, status, skipped: 'forbidden' }],
      },
      403,
    );
  }

  if (status !== 'needs_client' && status !== 'failed') {
    return jsonResponse({ success: true, results: [{ post_id: postId, status, skipped: 'in_progress' }] });
  }

  const result = await applyAssist(c.adminClient, postId, device, c.userId!, { log, storeCaption: c.storeCaption });
  await gcTombstones(c.adminClient);
  return jsonResponse({ success: true, results: [result] });
}

// ---------------------------------------------------------------------------
// 진입점 — 라우팅 + 인증
// ---------------------------------------------------------------------------

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse({ success: false, step: 'env', error: 'Missing required environment variables' }, 500);
    }

    // 1) 인증 — 비밀 헤더(서버 간) 가 있으면 그 갈래만 본다. 두 갈래 모두 실패하면 401 {step:'auth'}
    const secretHeader = req.headers.get('x-webhook-secret');
    const authHeader = req.headers.get('Authorization');
    let trusted = false;
    let userClient: ReturnType<typeof createClient> | null = null;
    let userId: string | null = null;

    if (secretHeader !== null) {
      const expected = Deno.env.get('LINK_PREVIEW_WEBHOOK_SECRET');
      // env 미설정 = 웹훅 경로 비활성. 비밀 없이 열어 두면 공개 URL 로 누구나 sweep 을 돌릴 수 있다
      if (!expected || !safeEqual(secretHeader, expected)) {
        return jsonResponse({ success: false, step: 'auth', error: 'Invalid webhook secret' }, 401);
      }
      trusted = true;
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const {
        data: { user },
        error: userError,
      } = await userClient.auth.getUser();
      if (userError || !user) {
        return jsonResponse(
          { success: false, step: 'auth', error: userError?.message ?? 'Invalid or expired token' },
          401,
        );
      }
      userId = user.id;
    } else {
      return jsonResponse({ success: false, step: 'auth', error: 'Missing credentials' }, 401);
    }

    // 2) 바디 — 모드를 알기 전엔 큰 쪽 캡으로 읽고, assist 가 아니면 8 KB 를 넘는 바디는 거절한다
    const body = await readJsonBody(req, ASSIST_BODY_MAX_BYTES);
    if (!body) return jsonResponse({ success: false, step: 'body', error: 'Invalid or oversized JSON body' }, 400);
    const mode = body.mode;
    if (mode !== 'assist' && JSON.stringify(body).length > BODY_MAX_BYTES) {
      return jsonResponse({ success: false, step: 'body', error: 'Body too large' }, 413);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const clients: Clients = {
      userClient,
      adminClient,
      userId,
      storeCaption: Deno.env.get('INSTAGRAM_STORE_CAPTION') === 'full',
    };

    // 3) 모드 — 비밀은 서버 간 모드만, 사용자 토큰은 사용자 모드만
    if (trusted) {
      if (mode === 'webhook') return await handleWebhook(body, clients);
      if (mode === 'sweep') return await handleSweep(body, clients);
      return jsonResponse({ success: false, step: 'mode', error: 'secret allows webhook | sweep only' }, 400);
    }
    if (mode === 'fetch') return await handleFetch(body, clients);
    if (mode === 'assist') return await handleAssist(body, clients);
    if (mode === 'webhook' || mode === 'sweep') {
      return jsonResponse({ success: false, step: 'auth', error: 'mode requires webhook secret' }, 403);
    }
    return jsonResponse({ success: false, step: 'mode', error: 'unknown mode' }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, step: 'unexpected', error: message }, 500);
  }
});
