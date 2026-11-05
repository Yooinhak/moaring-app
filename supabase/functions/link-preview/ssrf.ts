// SSRF 방어 — fetch 할 URL 의 스킴·포트·호스트·해석된 IP 를 검사한다 (fail-closed)
//
// 왜 필요한가: link-preview 는 `--no-verify-jwt` 공개 URL 이고, 처리 대상(posts.url)은 사용자가 저장한 임의 URL 이다.
// 함수가 요청 본문의 URL 을 fetch 하지는 않지만 posts.url 자체가 사용자 입력이고, 리다이렉트 Location 은 상대 서버의
// 입력이다. 그래서 ① 시작 URL ② 모든 리다이렉트 홉 ③ 이미지 후보 ④ device.image_url 이 전부 assertPublicHttpUrl 을
// 지난다 — fetch.ts 의 모든 요청은 requestWithRedirects 하나로 모이고 그 안에서 이 함수가 호출된다.
//
// 판정 순서: http/https 만 → 기본 포트(80/443) 만 → userinfo 거부 → 호스트 블록(localhost·*.local·*.internal·자기
// Supabase) → IP 리터럴은 직접 판정 → 도메인은 Deno.resolveDns A/AAAA → 실패·미지원이면 DoH(cloudflare-dns) → 둘 다
// 실패 또는 주소 0개면 거부. "모르면 안 간다" 가 원칙이고, 답 중 하나라도 사설이면 전체를 거부한다.
//
// 한계 (설계 §9): Deno fetch 는 해석한 IP 로 연결을 고정할 수 없어 DNS 리바인딩 잔여 위험이 있다 — 본문을 호출자에게
// 중계하지 않고 제목·설명만 길이 캡 후 저장하므로 blind probe 로 축소된다. DoH 는 저장 URL 의 호스트명을 Cloudflare 에 보낸다.
//
// bun 테스트: 모듈 로드 시 Deno 전역을 만지지 않는다 (globalThis 에서 실행 시점에만 찾는다). resolver 를 주입할 수 있어
// 네트워크 없이 fail-closed 경로를 검증한다 (__tests__/ssrf.test.ts).

import { matchesHost } from './canonical.ts';
import type { HostPattern } from './types.ts';

// ---------------------------------------------------------------------------
// 에러 — code 가 곧 preview_error 후보다. 'dns_failed' 만 일시 코드(catch-up 재시도), 'ssrf:*' 는 영구 거부.
// ---------------------------------------------------------------------------

export type SsrfCode =
  | 'ssrf:url' // URL 파싱 실패
  | 'ssrf:scheme' // http/https 아님 (javascript: data: file: …)
  | 'ssrf:port' // 80/443 외 포트
  | 'ssrf:userinfo' // user:pass@ 포함
  | 'ssrf:host' // 블록 호스트 (localhost·*.local·*.internal·자기 Supabase·점 없는 이름)
  | 'ssrf:hop_host' // 허용목록(allowHosts) 밖 호스트 — 어댑터가 좁힌 리다이렉트 범위를 벗어남
  | 'ssrf:ip' // 사설·루프백·링크로컬·멀티캐스트·예약 주소 (IP 리터럴 또는 해석 결과)
  | 'dns_failed'; // 해석 실패 또는 주소 0개 — fail-closed 거부, 일시 코드

export class SsrfError extends Error {
  readonly code: SsrfCode;
  readonly hostname: string;

  constructor(code: SsrfCode, hostname: string, detail?: string) {
    super(detail ? `${code} (${hostname}): ${detail}` : `${code} (${hostname})`);
    this.name = 'SsrfError';
    this.code = code;
    this.hostname = hostname;
  }
}

/** hostname → 주소 문자열 목록 (A·AAAA 섞여도 된다). 테스트·대체 해석기 주입용. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/** fetch 호환 시그니처 — 테스트에서 가짜 fetch 를 넣기 위해 필요한 부분만 적는다. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Deno 전역 — 모듈 로드 시 참조하지 않는다 (bun 테스트·앱 tsconfig 에는 Deno 가 없다)
// ---------------------------------------------------------------------------

interface DenoLike {
  resolveDns?: (hostname: string, recordType: 'A' | 'AAAA', options?: { signal?: AbortSignal }) => Promise<string[]>;
  env?: { get(name: string): string | undefined };
}

function getDeno(): DenoLike | undefined {
  return (globalThis as { Deno?: DenoLike }).Deno;
}

function getEnv(name: string): string | undefined {
  try {
    return getDeno()?.env?.get(name) ?? undefined;
  } catch {
    // --allow-env 가 없으면 PermissionDenied — 환경변수 없이도 나머지 검사는 그대로 동작해야 한다
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// IP 파싱·범위 판정 (순수 함수)
// ---------------------------------------------------------------------------

/** 점 네 개 십진수만 받는다. URL.hostname 은 0x7f.1 같은 변형을 이미 127.0.0.1 로 정규화해 준다. */
export function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function groupsToWords(groups: string[], allowEmbeddedV4: boolean): number[] | null {
  const words: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g === '') return null;
    if (g.includes('.')) {
      // 내장 IPv4 (::ffff:1.2.3.4) 는 마지막 그룹에만 올 수 있다
      if (!allowEmbeddedV4 || i !== groups.length - 1) return null;
      const v4 = parseIpv4(g);
      if (!v4) return null;
      words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    } else {
      if (g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
      words.push(parseInt(g, 16));
    }
  }
  return words;
}

/** 대괄호 유무 무관. '::' 압축·내장 IPv4 지원. zone id(%) 는 공개 주소에 없으므로 거부. 16바이트 또는 null. */
export function parseIpv6(host: string): Uint8Array | null {
  let s = host.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s || s.includes('%') || !/^[0-9a-fA-F:.]+$/.test(s)) return null;

  const dbl = s.indexOf('::');
  if (dbl !== -1 && s.indexOf('::', dbl + 1) !== -1) return null;

  const headStr = dbl === -1 ? s : s.slice(0, dbl);
  const tailStr = dbl === -1 ? null : s.slice(dbl + 2);
  const head = headStr === '' ? [] : headStr.split(':');
  const tail = tailStr === null || tailStr === '' ? [] : tailStr.split(':');

  const headWords = groupsToWords(head, tailStr === null);
  const tailWords = groupsToWords(tail, true);
  if (!headWords || !tailWords) return null;

  let words: number[];
  if (dbl === -1) {
    if (headWords.length !== 8) return null;
    words = headWords;
  } else {
    // '::' 는 최소 1 워드를 대신해야 한다
    if (headWords.length + tailWords.length > 7) return null;
    const zeros = new Array<number>(8 - headWords.length - tailWords.length).fill(0);
    words = [...headWords, ...zeros, ...tailWords];
  }

  const out = new Uint8Array(16);
  words.forEach((w, i) => {
    out[2 * i] = (w >> 8) & 0xff;
    out[2 * i + 1] = w & 0xff;
  });
  return out;
}

// [네트워크, 프리픽스 길이] — 설계 §9 의 IPv4 차단 범위 전부
const V4_BLOCKED: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this" 네트워크
  [0x0a000000, 8], // 10/8 사설
  [0x64400000, 10], // 100.64/10 캐리어 NAT
  [0x7f000000, 8], // 127/8 루프백
  [0xa9fe0000, 16], // 169.254/16 링크로컬 (클라우드 메타데이터 169.254.169.254 포함)
  [0xac100000, 12], // 172.16/12 사설
  [0xc0000000, 24], // 192.0.0/24 IETF 프로토콜 할당
  [0xc0a80000, 16], // 192.168/16 사설
  [0xc6120000, 15], // 198.18/15 벤치마크
  [0xe0000000, 4], // 224/4 멀티캐스트
  [0xf0000000, 4], // 240/4 예약 + 255.255.255.255
];

function ipv4ToInt(parts: readonly number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isBlockedIpv4(parts: readonly number[]): boolean {
  const ip = ipv4ToInt(parts);
  for (const [net, bits] of V4_BLOCKED) {
    const mask = (~0 << (32 - bits)) >>> 0;
    if ((ip & mask) >>> 0 === net) return true;
  }
  return false;
}

function allZero(b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
}

/** 16바이트 IPv6. 내장 IPv4(mapped·NAT64·6to4) 는 꺼내서 IPv4 규칙으로 다시 본다. */
export function isBlockedIpv6(b: Uint8Array): boolean {
  if (b.length !== 16) return true;
  // ::/96 — :: 과 ::1(루프백), 폐기된 IPv4-compatible 전부
  if (allZero(b, 0, 12)) return true;
  // ::ffff:0:0/96 IPv4-mapped — AAAA 응답으로 사설 v4 를 숨기는 고전 수법
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4([b[12], b[13], b[14], b[15]]);
  // 64:ff9b::/96 NAT64 (RFC 6052) — 내장 v4 재검사. 64:ff9b:1::/48 (RFC 8215 로컬용) 은 통째로 차단
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b[4] === 0x00 && b[5] === 0x01) return true;
    if (allZero(b, 4, 12)) return isBlockedIpv4([b[12], b[13], b[14], b[15]]);
  }
  // 2002::/16 6to4 — 비트 16~48 에 v4 가 들어 있다
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4([b[2], b[3], b[4], b[5]]);
  // 100::/64 discard-only
  if (b[0] === 0x01 && b[1] === 0x00 && allZero(b, 2, 8)) return true;
  // 2001:db8::/32 문서용
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  // fc00::/7 ULA(사설)
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 링크로컬, fec0::/10 폐기된 사이트로컬
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;
  // ff00::/8 멀티캐스트
  if (b[0] === 0xff) return true;
  return false;
}

/**
 * 주소 문자열이 공개 인터넷 주소가 아니면 true. 파싱이 안 되는 문자열도 true — 모르는 주소로는 가지 않는다 (fail-closed).
 * IPv4·IPv6(대괄호 유무 무관) 모두 받는다.
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return isBlockedIpv6(v6);
  return true;
}

// ---------------------------------------------------------------------------
// 호스트명 블록
// ---------------------------------------------------------------------------

// DNS 를 보기 전에 이름만으로 거부할 호스트. metadata.google.internal 은 *.internal 에 포함되지만 의도를 남긴다.
const BLOCKED_HOST_PATTERNS: readonly HostPattern[] = [
  'localhost',
  '*.localhost',
  '*.local',
  '*.internal',
  'metadata.google.internal',
  '*.supabase.co', // 자기 프로젝트 포함 — 함수가 자기 API 를 때리는 경로를 막는다
];

let ownSupabaseHostCache: string | null | undefined;

function ownSupabaseHost(): string | null {
  if (ownSupabaseHostCache !== undefined) return ownSupabaseHostCache;
  const raw = getEnv('SUPABASE_URL');
  let host: string | null = null;
  if (raw) {
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      host = null;
    }
  }
  ownSupabaseHostCache = host;
  return host;
}

/** 이름만으로 거부되는 호스트인가. 끝 점(FQDN 표기) 은 무시하고, 대소문자 무관. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (matchesHost(host, BLOCKED_HOST_PATTERNS)) return true;
  const own = ownSupabaseHost();
  return own !== null && host === own;
}

// ---------------------------------------------------------------------------
// 동기 검사 (스킴·포트·userinfo·호스트명·허용목록)
// ---------------------------------------------------------------------------

export interface UrlSyntaxOptions {
  /** 있으면 hostname 이 이 중 하나에 맞아야 한다 (리다이렉트 홉·이미지 호스트 허용목록). 빈 배열은 "제한 없음". */
  allowHosts?: readonly HostPattern[];
}

/**
 * 네트워크 없이 끝나는 검사만 수행하고 정규화된 URL 을 돌려준다 (프래그먼트 제거). 실패는 SsrfError.
 * URL 표준이 기본 포트를 '' 로 정규화하므로 port 가 비어 있지 않으면 80/443 이 아니다.
 */
export function checkUrlSyntax(input: string | URL, opts: UrlSyntaxOptions = {}): URL {
  let u: URL;
  try {
    u = typeof input === 'string' ? new URL(input.trim()) : new URL(input.href);
  } catch {
    throw new SsrfError('ssrf:url', '');
  }
  const host = u.hostname;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('ssrf:scheme', host, u.protocol);
  if (u.username || u.password) throw new SsrfError('ssrf:userinfo', host);
  if (u.port !== '') throw new SsrfError('ssrf:port', host, u.port);
  if (!host) throw new SsrfError('ssrf:host', host, 'empty');

  const isIpLiteral = host.startsWith('[') || parseIpv4(host) !== null;
  // 점 없는 이름(intranet, printer …) 은 공개 사이트에 없고 검색 도메인으로 내부 호스트에 닿을 수 있다
  if (!isIpLiteral && !host.includes('.')) throw new SsrfError('ssrf:host', host, 'single-label');
  if (isBlockedHostname(host)) throw new SsrfError('ssrf:host', host);
  if (opts.allowHosts && opts.allowHosts.length > 0 && !matchesHost(host, opts.allowHosts)) {
    throw new SsrfError('ssrf:hop_host', host);
  }

  u.hash = ''; // 프래그먼트는 서버로 가지 않는다 — 로그·비교 노이즈만 만든다
  return u;
}

// ---------------------------------------------------------------------------
// DNS 해석 — Deno.resolveDns → DoH 폴백, 짧은 캐시
// ---------------------------------------------------------------------------

const DNS_TIMEOUT_MS = 3_000;
const DNS_CACHE_TTL_MS = 60_000; // 한 호출 안에서 같은 호스트(페이지 → 이미지 → 홉) 를 다시 묻지 않을 정도만
const DNS_CACHE_MAX = 256;
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

const dnsCache = new Map<string, { addresses: string[]; expires: number }>();

/** 테스트용 — 기본 resolver 캐시 비우기. */
export function clearDnsCache(): void {
  dnsCache.clear();
}

async function resolveWithDeno(hostname: string): Promise<string[] | null> {
  const deno = getDeno();
  if (!deno || typeof deno.resolveDns !== 'function') return null;
  const resolveDns = deno.resolveDns;
  const settled = await Promise.allSettled(
    (['A', 'AAAA'] as const).map((type) => resolveDns(hostname, type, { signal: AbortSignal.timeout(DNS_TIMEOUT_MS) })),
  );
  const ok = settled.filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled');
  // 둘 다 실패하면 NXDOMAIN 인지 미지원·권한 문제인지 구분할 수 없다 → null 로 돌려 DoH 가 확정하게 한다.
  // 한쪽만 실패한 건 "그 레코드 타입이 없다" 는 뜻이라 정상.
  if (ok.length === 0) return null;
  return ok.flatMap((r) => r.value);
}

async function dohQuery(hostname: string, type: 'A' | 'AAAA', f: FetchLike, timeoutMs: number): Promise<string[]> {
  const u = new URL(DOH_ENDPOINT);
  u.searchParams.set('name', hostname);
  u.searchParams.set('type', type);
  const res = await f(u.href, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`doh http_${res.status}`);
  const body = (await res.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  // Status 3 = NXDOMAIN, 2 = SERVFAIL … → 주소 없음. 거부는 호출자가 "주소 0개" 로 한다
  if (body.Status !== 0) return [];
  const want = type === 'A' ? 1 : 28;
  return (body.Answer ?? [])
    .filter((a) => a.type === want && typeof a.data === 'string')
    .map((a) => (a.data as string).trim());
}

/**
 * DNS-over-HTTPS (application/dns-json). CNAME 체인은 Answer 에 섞여 오므로 레코드 타입으로 걸러낸다.
 * A·AAAA 둘 다 실패(네트워크·HTTP 오류) 면 throw, 한쪽만 성공하면 그 결과.
 */
export async function resolveViaDoh(
  hostname: string,
  fetchImpl?: FetchLike,
  timeoutMs = DNS_TIMEOUT_MS,
): Promise<string[]> {
  const f: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const settled = await Promise.allSettled([
    dohQuery(hostname, 'A', f, timeoutMs),
    dohQuery(hostname, 'AAAA', f, timeoutMs),
  ]);
  const ok = settled.filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled');
  if (ok.length === 0) {
    const first = settled[0] as PromiseRejectedResult;
    throw new Error(first.reason instanceof Error ? first.reason.message : String(first.reason));
  }
  return ok.flatMap((r) => r.value);
}

/** 기본 해석기: Deno.resolveDns → (미지원·둘 다 실패·주소 0개) → DoH. */
export const defaultResolver: DnsResolver = async (hostname) => {
  const viaDeno = await resolveWithDeno(hostname);
  if (viaDeno && viaDeno.length > 0) return viaDeno;
  return await resolveViaDoh(hostname);
};

/**
 * 호스트의 주소 목록. 실패·0개면 SsrfError('dns_failed'). 기본 해석기일 때만 60 s 캐시한다
 * (주입된 해석기는 테스트용이라 캐시를 공유하면 테스트 간 누수가 생긴다).
 */
export async function resolveHostAddresses(hostname: string, resolve?: DnsResolver): Promise<string[]> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const useCache = resolve === undefined;
  if (useCache) {
    const hit = dnsCache.get(host);
    if (hit && hit.expires > Date.now()) return hit.addresses;
  }

  let addresses: string[];
  try {
    addresses = await (resolve ?? defaultResolver)(host);
  } catch (err) {
    throw new SsrfError('dns_failed', host, err instanceof Error ? err.message : String(err));
  }
  const unique = [...new Set(addresses.map((a) => a.trim()).filter((a) => a.length > 0))];
  if (unique.length === 0) throw new SsrfError('dns_failed', host, 'no addresses');

  if (useCache) {
    if (dnsCache.size >= DNS_CACHE_MAX) dnsCache.clear();
    dnsCache.set(host, { addresses: unique, expires: Date.now() + DNS_CACHE_TTL_MS });
  }
  return unique;
}

// ---------------------------------------------------------------------------
// 공개 진입점
// ---------------------------------------------------------------------------

export interface AssertPublicUrlOptions extends UrlSyntaxOptions {
  /** 테스트·대체 해석기. 기본은 defaultResolver (Deno.resolveDns → DoH). */
  resolve?: DnsResolver;
}

export interface PublicUrlCheck {
  /** 프래그먼트가 제거된 정규화 URL. fetch 는 이 href 로 한다. */
  url: URL;
  hostname: string;
  /** 판정에 쓴 주소들 (IP 리터럴이면 그 자신). 로그용. */
  addresses: string[];
}

/**
 * URL 이 공개 인터넷의 http(s) 주소임을 확인한다. 아니면 SsrfError 를 던진다 — 통과한 URL 만 fetch 할 수 있다.
 * IP 리터럴은 DNS 없이 바로 판정하고, 도메인은 해석된 모든 주소를 검사한다 (하나라도 사설이면 거부).
 */
export async function assertPublicHttpUrl(
  input: string | URL,
  opts: AssertPublicUrlOptions = {},
): Promise<PublicUrlCheck> {
  const url = checkUrlSyntax(input, opts);
  const hostname = url.hostname;

  const v4 = parseIpv4(hostname);
  if (v4) {
    if (isBlockedIpv4(v4)) throw new SsrfError('ssrf:ip', hostname);
    return { url, hostname, addresses: [hostname] };
  }
  if (hostname.startsWith('[')) {
    const v6 = parseIpv6(hostname);
    if (!v6 || isBlockedIpv6(v6)) throw new SsrfError('ssrf:ip', hostname);
    return { url, hostname, addresses: [hostname.slice(1, -1)] };
  }

  const addresses = await resolveHostAddresses(hostname, opts.resolve);
  for (const address of addresses) {
    if (isPrivateIp(address)) throw new SsrfError('ssrf:ip', hostname, address);
  }
  return { url, hostname, addresses };
}
