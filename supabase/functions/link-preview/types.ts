// link-preview 공유 계약 (타입 + 상수)
//
// 이 파일은 Edge Function(Deno) 의 모든 모듈과 bun 테스트가 함께 import 한다.
// 그래서 Deno 전역·URL import 를 쓰지 않고, 런타임 코드는 상수 몇 개만 둔다.
// (이 Mac 에는 deno 가 없어 `bun test supabase/functions/link-preview` 가 배포 전 유일한 검증 수단이다.)
//
// 필드 이름은 DB 컬럼(005_link_previews.sql 의 posts.preview_*)·클라이언트 계약(src/utils/preview/types.ts)
// 과 수동으로 동기한다 — CHECK 제약 값은 `supabase gen types` 에 안 보이므로 여기서 상수로 고정한다.

// ---------------------------------------------------------------------------
// 상태·출처
// ---------------------------------------------------------------------------

/** posts.preview_status CHECK 와 1:1. 순서는 의미 없음. */
export const PREVIEW_STATUSES = [
  'pending', // 미시도 (신규 기본값, 기존 행 백필 큐)
  'fetching', // 워커가 선점함 (claimed_at 2분 지나면 죽은 것으로 봄)
  'ready', // 완료 — 제목·이미지가 null 일 수 있다 (= 도메인 카드)
  'needs_client', // 서버(데이터센터 IP)가 차단됨 → 폰이 1회 보조
  'failed', // 일시 실패. attempts < 3 이면 catch-up 이 재시도
  'unsupported', // 영구 실패 (삭제·404·EmbedBrokenMedia·oEmbed 400). force 만 가능
] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/** posts.preview_source — 어떤 경로로 필드를 얻었는지. 카드 렌더에는 안 쓰고 모니터링·디버깅용. */
export const PREVIEW_SOURCES = [
  'oembed', // 고정 oEmbed 엔드포인트 (YouTube·Vimeo·Reddit …)
  'embed', // 공개 임베드 페이지 파싱 (Instagram /embed/captioned/)
  'og', // 일반 og/twitter/<title> 파싱
  'redirect', // 리다이렉트 Location 만으로 확정 (naver.me 지도 공유 등)
  'slug', // URL 슬러그에서 만든 제목 (Medium·Notion — 본문 fetch 불가)
  'direct', // 링크 자체가 이미지·PDF 등 파일
  'device', // 폰(assist) 이 제출한 결과
  'hint', // 공유 텍스트 제목 힌트만 남은 경우
] as const;
export type PreviewSource = (typeof PREVIEW_SOURCES)[number];

// ---------------------------------------------------------------------------
// 수집 결과
// ---------------------------------------------------------------------------

/**
 * provider 가 돌려주는 필드. 전부 nullable — 비어 있어도 상태는 ready 일 수 있다(도메인 카드).
 * imageCandidates 는 우선순위 순서. 복사(image.ts)가 순차 시도해 첫 성공만 저장한다.
 * 원본 CDN URL 은 절대 그대로 렌더하지 않는다(만료·http) — 여기 들어가는 값은 "후보" 일 뿐이다.
 */
export interface PreviewFields {
  title: string | null;
  description: string | null;
  author: string | null;
  siteName: string | null;
  canonicalUrl: string | null;
  imageCandidates: string[];
}

export type ClientRunner = 'fetch' | 'webview';
export type ClientParser = 'generic' | 'instagram_embed' | 'tiktok_ssr';

/** needs_client 일 때 폰이 해야 할 일. url 은 폰이 fetch 할 주소(임베드 URL 등), parser 는 결과를 해석할 서버 파서 키. */
export interface ClientTask {
  runner: ClientRunner;
  parser: ClientParser;
  url: string;
}

/**
 * provider.run 의 결과. kind 가 곧 preview_status 가 된다 (failed 는 attempts 에 따라 catch-up 재시도).
 * error 는 짧은 코드(≤120자): 'blocked:cloudflare' | 'gone' | 'timeout' | 'http_5xx' | 'needs:webview' …
 */
export type ProviderOutcome =
  | { kind: 'ready'; fields: PreviewFields; source: PreviewSource }
  | { kind: 'needs_client'; fields?: PreviewFields; error: string; task: ClientTask }
  | { kind: 'unsupported'; error: string; fields?: PreviewFields }
  | { kind: 'failed'; error: string };

// ---------------------------------------------------------------------------
// I/O 계약 — fetch.ts(T3) 가 구현, 어댑터는 이것만 쓴다 (Deno 전역 직접 호출 금지 → bun 으로 가짜 io 테스트 가능)
// ---------------------------------------------------------------------------

/**
 * 호스트 허용 패턴. 문자열은 정확히 일치, '*.example.com' 은 example.com 자체와 모든 하위 도메인,
 * RegExp 는 hostname 전체에 test. 비교는 소문자 hostname(punycode) 기준 — canonical.ts 의 matchesHost 참고.
 */
export type HostPattern = string | RegExp;

export interface FetchTextOptions {
  /** 스트림 캡(압축 해제 후 바이트). 넘으면 reader.cancel — Range 는 5곳 중 4곳이 무시해서 못 쓴다. */
  maxBytes: number;
  timeoutMs: number;
  /** `</head>` 또는 `<body` 가 보이면 조기 중단. Instagram 임베드·TikTok SSR 처럼 본문이 필요한 곳은 false. */
  stopAtHead?: boolean;
  /** 리다이렉트 홉이 갈 수 있는 호스트. 없으면 SSRF 검사만 통과하면 어디든. */
  hopAllow?: HostPattern[];
  /** 기본 BUDGET.maxHops. */
  maxHops?: number;
}

export interface FetchTextResult {
  status: number;
  /** 리다이렉트 끝의 URL. 상대 URL 해석·canonical 기준. */
  finalUrl: string;
  /** 소문자 media type 만 (';' 뒤 파라미터 제거). 예: 'text/html', 'image/jpeg', 'application/pdf' */
  contentType: string | null;
  /** 디코드된 본문. HTML(text/html·application/xhtml+xml) 이 아니면 '' (본문을 읽지 않는다). */
  text: string;
  /** 소문자 키 응답 헤더. 차단 시그니처 판정(server·cf-mitigated·x-tt-system-error) 용. */
  headers: Record<string, string>;
  /** 캡·조기 중단으로 본문이 잘렸으면 true. */
  truncated?: boolean;
  /** 디코드에 쓴 charset 라벨 (charset.ts). 치환문자 비율 판정용 replacementRatio 도 함께. */
  charset?: string;
  replacementRatio?: number;
}

export interface FetchJsonOptions {
  timeoutMs: number;
  maxBytes?: number;
  hopAllow?: HostPattern[];
}

export interface FetchJsonResult {
  status: number;
  finalUrl: string;
  contentType: string | null;
  /** content-type 이 JSON 이 아니거나 파싱 실패면 null. 호출자가 shape 를 직접 검증한다. */
  json: unknown;
  headers: Record<string, string>;
}

export interface HeadOptions {
  timeoutMs: number;
  hopAllow?: HostPattern[];
}

export interface HeadResult {
  status: number;
  contentType: string | null;
}

export interface ResolveRedirectsOptions {
  maxHops: number;
  hopAllow?: HostPattern[];
  /** naver.me·link.coupang.com 용: 첫 Location 만 읽고 따라가지 않는다 (본문 0 B, 파트너스 클릭 집계 회피). */
  firstHopOnly?: boolean;
  timeoutMs?: number;
}

export interface ResolveRedirectsResult {
  /** 거친 URL 들 (시작 URL 포함, final 제외). */
  hops: string[];
  /** 마지막으로 도달한(또는 firstHopOnly 면 시작) URL. */
  final: string;
  /** 첫 응답의 Location 을 절대 URL 로 해석한 값. 리다이렉트가 아니면 undefined. */
  firstLocation?: string;
  /** 마지막 응답 상태코드. */
  status?: number;
}

export interface PreviewIO {
  fetchText(url: string, opts: FetchTextOptions): Promise<FetchTextResult>;
  fetchJson(url: string, opts: FetchJsonOptions): Promise<FetchJsonResult>;
  head(url: string, opts: HeadOptions): Promise<HeadResult>;
  resolveRedirects(url: string, opts: ResolveRedirectsOptions): Promise<ResolveRedirectsResult>;
}

// ---------------------------------------------------------------------------
// 어댑터 계약 — sites/*.ts (T4·T5) 가 구현, process.ts(T6) 가 호출
// ---------------------------------------------------------------------------

/** 로그는 post_id·host·status·error 코드만 남긴다 (본문·제목은 로그 금지). */
export type PreviewLogger = (event: string, extra?: Record<string, unknown>) => void;

export interface ProviderCtx {
  /** posts.url 원문 (사용자 입력 그대로). */
  postUrl: string;
  /** 추적 파라미터 제거·사이트별 재작성 후 실제로 fetch 할 URL. */
  fetchUrl: string;
  /** 저장할 canonical URL (adapter.canonicalize 또는 canonical.ts 기본 구현). */
  canonicalUrl: string;
  io: PreviewIO;
  /** epoch ms. 이 시각까지 run 이 끝나야 한다 (단건 25 s). 네트워크 호출 전 Date.now() 와 비교할 것. */
  deadline: number;
  log: PreviewLogger;
  /** 공유 텍스트에서 뽑은 제목 힌트 (claim 의 hint_title). 서버 제목이 없을 때·fetch 불가 사이트 제목에 쓴다. */
  hintTitle: string | null;
  /** claim 뒤의 preview_attempts. 1 = 첫 시도. LinkedIn 999 처럼 "1회만 needs_client" 판정에 쓴다. */
  attempts: number;
  /** 저장 직후 가속 호출에 실린 폰 파싱 결과. 서버 결과의 빈 필드만 채우는 용도. */
  device?: DeviceHints | null;
}

export interface CanonicalResult {
  fetchUrl: string;
  canonicalUrl: string;
}

export interface SiteAdapter {
  /** posts.preview_provider 에 저장. 'youtube' | 'instagram' | 'x' | 'naver_blog' | … | 'generic' */
  id: string;
  /**
   * false 면 run 은 네트워크 없이 outcome 을 돌려준다 (쿠팡·스마트스토어·플레이스·Medium·Notion).
   * 배포 후 데이터센터 IP 차단이 확인된 사이트는 이 플래그 1줄로 needs_client 직행시킨다.
   */
  serverFetch: boolean;
  /** 이미지 복사를 허용할 호스트. 정의돼 있으면 device.image_url 도 여기 맞아야만 재다운로드한다. */
  imageHosts?: RegExp[];
  match(u: URL): boolean;
  canonicalize?(u: URL): CanonicalResult;
  run(ctx: ProviderCtx): Promise<ProviderOutcome>;
  /** 폰이 제출한 HTML(assist) 을 서버 규칙으로 해석. 없으면 device 필드를 그대로 정제해 쓴다. */
  parseSubmitted?(html: string, finalUrl: string): PreviewFields | null;
}

// ---------------------------------------------------------------------------
// 요청/응답 (§5) — index.ts(T6) 와 클라이언트 invoke 래퍼(T9) 가 공유
// ---------------------------------------------------------------------------

/** 폰 파싱 결과. 전부 선택 — 서버 결과 우선, 빈 필드만 채운다. image_url 은 서버가 재다운로드 후에만 저장. */
export interface DeviceHints {
  title?: string | null;
  description?: string | null;
  image_url?: string | null;
  author?: string | null;
  canonical_url?: string | null;
  /** 인스타 임베드·TikTok SSR 처럼 서버 파서가 필요한 경우의 원문 HTML (≤256 KB). */
  html?: string | null;
  /** 폰도 비 2xx 를 받았음 → 서버가 failed 로 종결 (무한 루프 방지). */
  blocked?: boolean;
  http_status?: number;
}

export type Req =
  | { mode: 'fetch'; post_id: number; device?: DeviceHints | null; force?: boolean } // 저장 직후 가속 · 수동 재시도
  | { mode: 'fetch'; post_ids: number[] } // 폴더 catch-up, ≤8
  | { mode: 'assist'; post_id: number; device: DeviceHints } // 폰 파싱 결과 제출 (owner/editor)
  | { mode: 'webhook'; post_id: number } // DB 트리거 → 202 즉시 + EdgeRuntime.waitUntil
  | { mode: 'sweep'; limit?: number }; // pick_preview_jobs → 순차, 60 s 예산

export type ReqMode = Req['mode'];

export type SkipReason = 'not_found' | 'in_progress' | 'max_attempts' | 'cooldown' | 'forbidden';

export interface ClientTaskEntry extends ClientTask {
  post_id: number;
  folder_id: number;
}

export interface ResultEntry {
  post_id: number;
  status: PreviewStatus;
  source?: PreviewSource | null;
  error?: string | null;
  skipped?: SkipReason;
  client_task?: ClientTaskEntry;
}

export interface Res {
  success: boolean;
  step?: string;
  error?: string;
  /** webhook: 202 와 함께 true. */
  accepted?: boolean;
  /** sweep: 처리한 건수. */
  processed?: number;
  results?: ResultEntry[];
}

// ---------------------------------------------------------------------------
// DB 행 모양 — claim RPC 결과와 단일 UPDATE 페이로드 (컬럼명 오타를 타입으로 잡기 위해)
// ---------------------------------------------------------------------------

/** public.claim_post_preview(p_post_id, p_force) 의 한 행. */
export interface ClaimRow {
  id: number;
  url: string;
  folder_id: number;
  group_id: string;
  attempts: number;
  prev_image_path: string | null;
  hint_title: string | null;
}

/** processPost 끝의 단일 UPDATE 페이로드. preview_claimed_at 은 항상 null 로 되돌린다. */
export interface PreviewUpdate {
  preview_title: string | null;
  preview_description: string | null;
  preview_author: string | null;
  preview_site_name: string | null;
  preview_image_url: string | null;
  preview_image_path: string | null;
  preview_image_src: string | null;
  preview_canonical_url: string | null;
  preview_provider: string | null;
  preview_source: PreviewSource | null;
  preview_status: PreviewStatus;
  preview_error: string | null;
  preview_fetched_at: string;
  preview_claimed_at: null;
  preview_assisted_by?: string | null;
}

// ---------------------------------------------------------------------------
// 상수 — SQL CHECK·§5 예산과 동기
// ---------------------------------------------------------------------------

/** posts_preview_lengths_check 와 동일. char_length 는 코드포인트 수라 Array.from 으로 센다. */
export const FIELD_LIMITS = {
  title: 300,
  description: 1000,
  author: 120,
  siteName: 120,
  error: 120,
} as const;

export const BUDGET = {
  htmlMaxBytes: 1024 * 1024, // YouTube 첫 og 가 ~777 KB — 256 KB 캡은 놓친다
  htmlTimeoutMs: 10_000,
  imageMaxBytes: 3 * 1024 * 1024, // 버킷 file_size_limit 과 동일
  imageTimeoutMs: 8_000,
  postTimeoutMs: 25_000, // 단건 run 예산
  batchSize: 8, // post_ids 상한
  concurrency: 2, // CPU 2 s/요청 — 인스타 512 KB·틱톡 1 MiB 정규식이 겹치지 않게
  maxHops: 8, // naver.me 가 5홉
  forceCooldownMs: 60_000,
  staleClaimMs: 120_000, // claim_post_preview 의 interval '2 minutes' 와 동일
  maxAttempts: 5, // 비-force 상한 → skipped 'max_attempts'
} as const;

export const STORAGE_BUCKET = 'link-previews';
