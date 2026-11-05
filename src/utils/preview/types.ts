/**
 * 링크 미리보기(posts.preview_*) 의 클라이언트 공용 타입·상태 헬퍼.
 *
 * 카드는 더 이상 기기에서 메타를 긁지 않고 DB 컬럼을 그대로 그린다 — 수집은 Edge Function
 * `link-preview` 가 저장 시점에 1회 하고, 여기엔 그 결과를 해석하는 규칙만 둔다.
 *
 * ⚠️ PREVIEW_STATUSES 는 DB CHECK posts_preview_status_check(005_link_previews.sql) 와 1:1 이다.
 *    generated types(supabase gen types) 에 CHECK 값은 안 보인다 (memory: supabase-check-constraints)
 *    → 005 의 상태 목록을 바꾸면 반드시 여기도 같이 고친다.
 * ⚠️ 005 ③ 컬럼 단위 GRANT: 클라이언트 insert 는 url / description / folder_id / preview_title 만,
 *    update 는 description / folder_id 만 허용된다. 나머지 preview_* 는 서버(service_role) 전용이라
 *    클라이언트가 쓰면 42501 로 저장 자체가 실패한다. 새 컬럼을 앱이 쓰게 되면 005 grant 목록을 먼저 갱신할 것.
 */

/** 005 posts_preview_status_check 와 동일한 6개 (순서도 SQL 과 같게 유지) */
export const PREVIEW_STATUSES = ['pending', 'fetching', 'ready', 'needs_client', 'failed', 'unsupported'] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/**
 * 폰이 저장 전에(또는 assist 보조로) 직접 파싱한 메타. 서버는 자기 결과가 빈 필드만 이 값으로 채우고,
 * image_url 은 믿지 않고 재다운로드(https·SSRF·매직바이트) 한 뒤에만 저장한다.
 * blocked/http_status 는 "폰에서도 막혔다" 를 서버에 알려 needs_client 를 종결시키는 용도.
 */
export type DeviceHints = {
  title?: string | null;
  description?: string | null;
  image_url?: string | null;
  author?: string | null;
  /** 폰이 리다이렉트를 따라가 확정한 최종 URL(단축 링크 → 영상 페이지 등). 서버는 http(s) 만 받고 preview_canonical_url 후보로 쓴다 */
  canonical_url?: string | null;
  blocked?: boolean;
  http_status?: number;
};

/** assist 모드 전용 — 인스타 임베드·틱톡 SSR 처럼 서버가 폰이 받은 원문을 다시 파싱해야 하는 경우 html 동봉(≤256 KB) */
export type DeviceAssistHints = DeviceHints & { html?: string };

/** 서버가 폰에 넘기는 보조 작업. runner 'webview' 는 v2 자리 — v1 클라이언트는 'fetch' 만 수행한다 */
export type PreviewClientTask = {
  post_id: number;
  folder_id: number;
  url: string;
  runner: 'fetch' | 'webview';
  parser: 'generic' | 'instagram_embed' | 'tiktok_ssr';
};

/**
 * results[] 한 건. status/skipped 는 서버가 코드를 늘려도 클라이언트가 깨지지 않게 string 으로 둔다.
 * skipped: 'not_found' | 'in_progress' | 'max_attempts' | 'cooldown' | 'forbidden'
 */
export type PreviewResult = {
  post_id: number;
  status: string;
  source?: string;
  error?: string | null;
  skipped?: string;
  client_task?: PreviewClientTask;
};

/** link-preview 응답 — delete-account 와 같은 {success, step, error} 골격 + results */
export type PreviewResponse = {
  success: boolean;
  step?: string;
  error?: string;
  accepted?: boolean;
  results?: PreviewResult[];
};

/** pending 을 "수집 중" 으로 보는 창. 트리거·가속 호출이 모두 죽었으면 이 뒤로는 도메인 카드로 굳는다 */
export const PREVIEW_PENDING_WINDOW_MS = 10 * 60 * 1000;
/** fetching 선점이 살아있다고 보는 창 — 005 claim_post_preview 의 stale 기준(2분)과 같다 */
export const PREVIEW_FETCHING_WINDOW_MS = 2 * 60 * 1000;

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

/**
 * 이 행 때문에 목록을 폴링(3초)·스켈레톤을 그려야 하나.
 * 창을 두는 이유: 막힌 행(함수 미배포·pg_net 실패 등)이 영구 폴링을 만들면 안 된다.
 * 시각이 없거나 못 읽으면 false — 끝을 알 수 없는 로딩은 로딩이 아니다.
 */
export function isPreviewLoading(
  status: string | null | undefined,
  createdAt: string | null | undefined,
  claimedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (status === 'pending') {
    const age = ageMs(createdAt, now);
    return age !== null && age < PREVIEW_PENDING_WINDOW_MS;
  }
  if (status === 'fetching') {
    const age = ageMs(claimedAt, now);
    return age !== null && age < PREVIEW_FETCHING_WINDOW_MS;
  }
  return false;
}

/**
 * '미리보기 다시 불러오기' 버튼을 보일 상태. unsupported(삭제·비공개·404)는 영구 실패라 숨기고,
 * ready/needs_client 는 서버가 이미 결론을 냈으니 사용자가 다시 누를 이유가 없다.
 */
export function canRetryPreview(status: string | null | undefined): boolean {
  return status === 'failed';
}

/**
 * 폴더 catch-up 이 자동 재시도하는 failed 코드. 차단(blocked:*)·영구 실패는 여기 없다.
 * network(연결 거절·리셋·TLS 실패, 서버 fetch.ts toIoError)·fetch_failed(그 외 fetch 예외, sites/generic.ts errorCode)는
 * 서버가 attempts<3 재시도 대상으로 두는 일시 코드인데 여기서 빠지면 자동 재시도가 영영 안 돌아 수동 버튼만 남는다.
 */
export const TRANSIENT_PREVIEW_ERRORS = [
  'timeout',
  'http_5xx',
  'dns_failed',
  'network',
  'fetch_failed',
  'unexpected',
] as const;

/**
 * 서버가 'dns_failed:ENOTFOUND' 처럼 코드 뒤에 세부를 붙여도 코드 부분만 본다.
 * error 가 비어 있으면 false — 원인을 모르는 failed 를 자동으로 다시 돌리면 attempts 만 태운다.
 */
export function isTransientFailure(error: string | null | undefined): boolean {
  if (!error) return false;
  const code = error.split(':')[0].trim();
  return (TRANSIENT_PREVIEW_ERRORS as readonly string[]).includes(code);
}

/** 어느 사이트든 식별에 기여하지 않는 추적 파라미터 (서버 canonicalize 와 같은 목록) */
const TRACKING_PARAMS = new Set([
  'igsh',
  'igshid',
  'si',
  'fbclid',
  'gclid',
  'ref_src',
  'feature',
  'pp',
  // 쿠팡 파트너스
  'lptag',
  'wpcid',
  'mcid',
  'traceid',
  'itime',
  'sharesource',
  // 네이버
  'fromrss',
  'trackingcode',
  'placepath',
]);

/** x.com 공유 링크의 s/t 는 추적값이지만 다른 사이트에선 의미 있는 쿼리일 수 있어 X 에서만 뗀다 */
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

function isTrackingParam(key: string, hostname: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith('utm_')) return true;
  if (TRACKING_PARAMS.has(k)) return true;
  return X_HOSTS.has(hostname) && (k === 's' || k === 't');
}

/**
 * 중복 저장 검사 전용 정규화 — 소문자 호스트, 프래그먼트·추적 파라미터 제거, 끝 슬래시 제거.
 * posts.url 에는 절대 이 값을 넣지 않는다(원문 보존). 서버 canonical 과 달리 리다이렉트·사이트별
 * 재작성은 하지 않는다(네트워크 0회). URL 로 못 읽는 문자열은 trim 만 해서 돌려준다.
 */
export function normalizeForCompare(url: string): string {
  const trimmed = url.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const hostname = u.hostname.toLowerCase();
  // 순회 중 삭제하면 건너뛰는 키가 생기므로 먼저 모은다.
  // keys() 가 아니라 forEach 인 이유: RN 의 URLSearchParams 타입(lib DOM 아님)에 iterator 메서드가 없다
  const keys = new Set<string>();
  u.searchParams.forEach((_value, key) => {
    keys.add(key);
  });
  keys.forEach((key) => {
    if (isTrackingParam(key, hostname)) u.searchParams.delete(key);
  });

  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${hostname}${port}${path}${u.search}`;
}
