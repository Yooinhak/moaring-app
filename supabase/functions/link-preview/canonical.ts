// URL 정규화 — 추적 파라미터 제거·호스트 패턴 매칭·기본 canonical (순수 모듈)
//
// posts.url 은 사용자 원문 그대로 둔다. 여기서 만드는 fetchUrl/canonicalUrl 은
//   ① 서버가 실제로 fetch 할 주소 (추적 토큰을 외부 서버에 다시 보내지 않기 위해 — 프라이버시)
//   ② 같은 그룹 안에서 같은 글을 다시 수집하지 않기 위한 비교 키 (posts_preview_canonical_idx)
// 사이트별 재작성(m.blog.naver.com, youtube watch?v= 등) 은 어댑터의 canonicalize 가 덧붙인다.
//
// 'si' 'feature' 'pp' 처럼 짧은 이름은 사이트에 따라 의미가 다를 수 있어 (YouTube 의 t=42s 는 재생 위치!)
// 전역 목록은 보수적으로, 나머지는 호스트별로 묶는다.

import type { CanonicalResult, HostPattern } from './types.ts';

/** 어디서나 추적용으로만 쓰이는 파라미터. 대소문자 무관 비교. */
export const GLOBAL_TRACKING_PARAMS: readonly string[] = [
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'yclid',
  'igsh', // Instagram 공유 시트
  'igshid',
  'si', // YouTube·Spotify 공유 식별자
  'ref_src',
  'ref_url',
  'srsltid', // Google 쇼핑
  'spm', // 알리/타오바오
  '_ga',
  '_gl',
  'feature', // youtu.be → watch?…&feature=youtu.be
];

/** 'utm_source' 'utm_id' … 전부. */
export const GLOBAL_TRACKING_PREFIXES: readonly string[] = ['utm_'];

/** 특정 사이트군에서만 추적용인 파라미터. */
export const HOST_TRACKING_PARAMS: ReadonlyArray<{ hosts: HostPattern[]; params: string[] }> = [
  // X 공유 시트: ?s=20&t=AbCd — og:url 도 이 둘을 뺀 canonical 을 준다
  { hosts: ['x.com', '*.x.com', 'twitter.com', '*.twitter.com'], params: ['s', 't'] },
  // YouTube: pp 는 서버가 붙이는 재생 컨텍스트 토큰, ab_channel 은 공유 시트 잔재. t(재생 위치)·list 는 남긴다.
  { hosts: ['*.youtube.com', 'youtu.be', '*.youtube-nocookie.com'], params: ['pp', 'ab_channel', 'app'] },
  // 쿠팡 파트너스/앱 공유: itemId·vendorItemId 외는 전부 추적 (어댑터가 최종적으로 둘만 남긴다)
  {
    hosts: ['*.coupang.com'],
    params: [
      'lptag',
      'wPcid',
      'mcid',
      'traceid',
      'itime',
      'sharesource',
      'pageType',
      'pageValue',
      'redirect',
      'subid',
      'src',
      'spec',
      'addtag',
      'ctag',
      'style',
      'isshortened',
      'settlement',
    ],
  },
  // 네이버: RSS 유입 표시, 지도 공유의 경로 힌트
  { hosts: ['*.naver.com', 'naver.me'], params: ['fromRss', 'trackingCode', 'placePath'] },
];

/**
 * hostname 이 패턴 중 하나에 맞는지. 문자열은 정확히 일치, '*.example.com' 은 example.com 과 모든 하위 도메인,
 * RegExp 는 hostname 전체에 test. hostname 은 URL.hostname(소문자·punycode) 을 그대로 넘긴다.
 * patterns 가 undefined/빈 배열이면 false — 허용목록이 없다는 뜻이므로 호출자가 "제한 없음" 을 따로 판단한다.
 */
export function matchesHost(hostname: string, patterns: readonly HostPattern[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const p of patterns) {
    if (p instanceof RegExp) {
      if (p.test(host)) return true;
      continue;
    }
    const pat = p.toLowerCase();
    if (pat.startsWith('*.')) {
      const apex = pat.slice(2);
      if (host === apex || host.endsWith('.' + apex)) return true;
    } else if (host === pat) {
      return true;
    }
  }
  return false;
}

function isTrackingParam(name: string, hostname: string): boolean {
  const lower = name.toLowerCase();
  for (const prefix of GLOBAL_TRACKING_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  for (const g of GLOBAL_TRACKING_PARAMS) {
    if (lower === g) return true;
  }
  for (const group of HOST_TRACKING_PARAMS) {
    if (!matchesHost(hostname, group.hosts)) continue;
    for (const p of group.params) {
      if (lower === p.toLowerCase()) return true;
    }
  }
  return false;
}

/**
 * 추적 파라미터를 뺀 새 URL 을 돌려준다 (입력은 변경하지 않음). 나머지 파라미터의 순서·값은 그대로.
 * 결과 search 가 비면 '?' 도 사라진다 (URL 표준 동작).
 */
export function stripTrackingParams(u: URL): URL {
  const out = new URL(u.href);
  const keys = Array.from(new Set(Array.from(out.searchParams.keys())));
  for (const key of keys) {
    if (isTrackingParam(key, out.hostname)) out.searchParams.delete(key);
  }
  // searchParams.delete 뒤 남는 빈 '?' 를 확실히 제거
  if (out.search === '?' || out.searchParams.toString() === '') out.search = '';
  return out;
}

/** http(s) URL 이면 URL 객체, 아니면 null. 사용자 입력 파싱의 첫 관문. */
export function parseHttpUrl(input: string | null | undefined): URL | null {
  if (!input) return null;
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * 기본 canonical: 프래그먼트 제거 + 추적 파라미터 제거 + 소문자 호스트/기본 포트 정리(URL 표준이 처리).
 * userinfo 는 제거한다 — 저장·로그에 자격증명이 남지 않게. 경로·대소문자·끝 슬래시는 건드리지 않는다
 * (어떤 사이트는 구분한다). 어댑터가 canonicalize 를 제공하면 그쪽이 우선.
 */
export function canonicalize(input: URL | string): CanonicalResult {
  const u = typeof input === 'string' ? new URL(input.trim()) : new URL(input.href);
  u.hash = '';
  u.username = '';
  u.password = '';
  const stripped = stripTrackingParams(u);
  return { fetchUrl: stripped.href, canonicalUrl: stripped.href };
}

/** 'blog.naver.com/abc/123' 의 ['abc','123'] 처럼 빈 세그먼트를 뺀 경로 조각. 어댑터의 id 추출 공용. */
export function pathSegments(u: URL): string[] {
  return u.pathname.split('/').filter((s) => s.length > 0);
}
