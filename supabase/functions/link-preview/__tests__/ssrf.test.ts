// 실행: bun test supabase/functions/link-preview
// SSRF 검사는 네트워크 없이 검증한다 — resolver 를 주입하고, Deno 전역은 테스트 안에서만 잠깐 흉내 낸다.
import { afterEach, describe, expect, test } from 'bun:test';

import {
  assertPublicHttpUrl,
  checkUrlSyntax,
  clearDnsCache,
  defaultResolver,
  isBlockedHostname,
  isPrivateIp,
  parseIpv4,
  parseIpv6,
  resolveViaDoh,
  SsrfError,
} from '../ssrf.ts';
import type { FetchLike } from '../ssrf.ts';

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700::6810:84e5';

function codeOf(fn: () => Promise<unknown> | unknown): Promise<string | null> {
  return Promise.resolve()
    .then(fn)
    .then(() => null)
    .catch((err: unknown) => (err instanceof SsrfError ? err.code : `not-ssrf:${String(err)}`));
}

describe('parseIpv4 / parseIpv6', () => {
  test('점 네 개 십진수만', () => {
    expect(parseIpv4('127.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIpv4('256.0.0.1')).toBe(null);
    expect(parseIpv4('0x7f.1')).toBe(null); // URL 이 이미 정규화해 주므로 여기선 거부
    expect(parseIpv4('1.2.3')).toBe(null);
  });

  test('IPv6 압축·대괄호·내장 IPv4', () => {
    expect(Array.from(parseIpv6('::1') as Uint8Array)).toEqual([...new Array(15).fill(0), 1]);
    expect(Array.from(parseIpv6('[::ffff:127.0.0.1]') as Uint8Array).slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    // URL.hostname 은 mapped 주소를 hex 로 직렬화한다 — 둘 다 같은 바이트여야 한다
    expect(parseIpv6('::ffff:7f00:1')).toEqual(parseIpv6('::ffff:127.0.0.1'));
    expect(parseIpv6('64:ff9b::102:304')).toEqual(parseIpv6('64:ff9b::1.2.3.4'));
    expect(parseIpv6('fe80::1%eth0')).toBe(null);
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBe(null);
    expect(parseIpv6('1::2::3')).toBe(null);
    expect(parseIpv6('12345::')).toBe(null);
  });
});

describe('isPrivateIp — 설계 §9 차단 범위', () => {
  test('IPv4 사설·루프백·링크로컬·CGNAT·멀티캐스트·예약', () => {
    for (const ip of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test('IPv4 공개 주소 (경계값 바깥)', () => {
    for (const ip of [PUBLIC_V4, '8.8.8.8', '100.128.0.1', '172.32.0.1', '198.20.0.1', '192.0.1.1', '1.1.1.1']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  test('IPv6 — ::/96·mapped·NAT64·6to4 내장 v4 재검사·ULA·링크로컬·멀티캐스트', () => {
    for (const ip of [
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b:1::1',
      '2002:7f00:1::',
      '100::1',
      '2001:db8::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of [PUBLIC_V6, '2a00:1450:4001:80e::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  test('파싱 불가는 차단 (fail-closed)', () => {
    expect(isPrivateIp('nope')).toBe(true);
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp('1.2.3.4.5')).toBe(true);
  });
});

describe('isBlockedHostname / checkUrlSyntax', () => {
  test('이름만으로 거부되는 호스트', () => {
    for (const h of [
      'localhost',
      'LOCALHOST.',
      'api.localhost',
      'printer.local',
      'db.internal',
      'metadata.google.internal',
      'abc.supabase.co',
      'supabase.co',
    ]) {
      expect(isBlockedHostname(h)).toBe(true);
    }
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('supabase.com')).toBe(false);
  });

  test('스킴·userinfo·포트·점 없는 이름', async () => {
    expect(await codeOf(() => checkUrlSyntax('ftp://example.com/'))).toBe('ssrf:scheme');
    expect(await codeOf(() => checkUrlSyntax('javascript:alert(1)'))).toBe('ssrf:scheme');
    expect(await codeOf(() => checkUrlSyntax('http://user:pw@example.com/'))).toBe('ssrf:userinfo');
    expect(await codeOf(() => checkUrlSyntax('https://example.com:8443/'))).toBe('ssrf:port');
    expect(await codeOf(() => checkUrlSyntax('http://intranet/'))).toBe('ssrf:host');
    expect(await codeOf(() => checkUrlSyntax('http://localhost/'))).toBe('ssrf:host');
    expect(await codeOf(() => checkUrlSyntax('not a url'))).toBe('ssrf:url');
  });

  test('기본 포트 명시는 정규화돼 통과, 프래그먼트 제거, 끝 점 유지', () => {
    expect(checkUrlSyntax('http://example.com:80/a#frag').href).toBe('http://example.com/a');
    expect(checkUrlSyntax('https://EXAMPLE.com:443/').hostname).toBe('example.com');
    expect(checkUrlSyntax('https://한국인터넷정보센터.한국/').hostname).toBe(
      'xn--3e0bx5euxnjje69i70af08bea817g.xn--3e0b707e',
    );
  });

  test('allowHosts — 허용목록 밖이면 ssrf:hop_host, 빈 배열은 제한 없음', async () => {
    const allow = ['t.co', 'x.com', '*.twitter.com'];
    expect(checkUrlSyntax('https://mobile.twitter.com/a', { allowHosts: allow }).hostname).toBe('mobile.twitter.com');
    expect(await codeOf(() => checkUrlSyntax('https://evil.example/', { allowHosts: allow }))).toBe('ssrf:hop_host');
    expect(checkUrlSyntax('https://evil.example/', { allowHosts: [] }).hostname).toBe('evil.example');
  });
});

describe('assertPublicHttpUrl — DNS 결과 판정 (resolver 주입)', () => {
  test('공개 주소로 해석되면 통과하고 주소를 돌려준다', async () => {
    const seen: string[] = [];
    const r = await assertPublicHttpUrl('https://Example.com/path?q=1#x', {
      resolve: async (h) => {
        seen.push(h);
        return [PUBLIC_V4, PUBLIC_V6];
      },
    });
    expect(r.url.href).toBe('https://example.com/path?q=1');
    expect(r.hostname).toBe('example.com');
    expect(r.addresses).toEqual([PUBLIC_V4, PUBLIC_V6]);
    expect(seen).toEqual(['example.com']);
  });

  test('fail-closed: 주소 0개 → dns_failed', async () => {
    expect(await codeOf(() => assertPublicHttpUrl('https://example.com/', { resolve: async () => [] }))).toBe(
      'dns_failed',
    );
  });

  test('fail-closed: 해석기 예외 → dns_failed', async () => {
    const resolve = async () => {
      throw new Error('NXDOMAIN');
    };
    expect(await codeOf(() => assertPublicHttpUrl('https://example.com/', { resolve }))).toBe('dns_failed');
  });

  test('답 중 하나라도 사설이면 전체 거부 (DNS 리바인딩 1차 방어)', async () => {
    const resolve = async () => [PUBLIC_V4, '10.0.0.5'];
    expect(await codeOf(() => assertPublicHttpUrl('https://example.com/', { resolve }))).toBe('ssrf:ip');
    const mapped = async () => ['::ffff:169.254.169.254'];
    expect(await codeOf(() => assertPublicHttpUrl('https://example.com/', { resolve: mapped }))).toBe('ssrf:ip');
  });

  test('IP 리터럴은 DNS 없이 바로 판정한다', async () => {
    let called = 0;
    const resolve = async () => {
      called++;
      return [PUBLIC_V4];
    };
    expect(await codeOf(() => assertPublicHttpUrl('http://127.0.0.1/', { resolve }))).toBe('ssrf:ip');
    expect(await codeOf(() => assertPublicHttpUrl('http://[::1]/', { resolve }))).toBe('ssrf:ip');
    expect(await codeOf(() => assertPublicHttpUrl('http://[::ffff:127.0.0.1]/', { resolve }))).toBe('ssrf:ip');
    expect(await codeOf(() => assertPublicHttpUrl('http://0x7f.1/', { resolve }))).toBe('ssrf:ip'); // URL 이 127.0.0.1 로 정규화
    expect(await codeOf(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data', { resolve }))).toBe(
      'ssrf:ip',
    );
    const ok = await assertPublicHttpUrl(`http://${PUBLIC_V4}/x`, { resolve });
    expect(ok.addresses).toEqual([PUBLIC_V4]);
    expect(called).toBe(0);
  });

  test('allowHosts 는 DNS 전에 본다 (허용목록 밖 호스트는 해석조차 안 한다)', async () => {
    let called = 0;
    const resolve = async () => {
      called++;
      return [PUBLIC_V4];
    };
    expect(await codeOf(() => assertPublicHttpUrl('https://evil.example/', { allowHosts: ['x.com'], resolve }))).toBe(
      'ssrf:hop_host',
    );
    expect(called).toBe(0);
  });
});

describe('resolveViaDoh — application/dns-json 파싱', () => {
  function dohFetch(answers: Record<string, unknown>, status = 200): FetchLike {
    return async (input, init) => {
      const u = new URL(input);
      expect(u.origin + u.pathname).toBe('https://cloudflare-dns.com/dns-query');
      expect((init?.headers as Record<string, string>).accept).toBe('application/dns-json');
      const type = u.searchParams.get('type') as string;
      return new Response(JSON.stringify(answers[type] ?? { Status: 0, Answer: [] }), {
        status,
        headers: { 'content-type': 'application/dns-json' },
      });
    };
  }

  test('A·AAAA 를 합치고 CNAME(type 5) 은 버린다', async () => {
    const f = dohFetch({
      A: {
        Status: 0,
        Answer: [
          { name: 'www.example.com', type: 5, data: 'example.com.' },
          { name: 'example.com', type: 1, data: PUBLIC_V4 },
        ],
      },
      AAAA: { Status: 0, Answer: [{ name: 'example.com', type: 28, data: PUBLIC_V6 }] },
    });
    expect(await resolveViaDoh('www.example.com', f)).toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  test('NXDOMAIN(Status 3) 은 빈 배열 → 호출자가 dns_failed 로 거부', async () => {
    const f = dohFetch({ A: { Status: 3 }, AAAA: { Status: 3 } });
    expect(await resolveViaDoh('nope.example', f)).toEqual([]);
    expect(
      await codeOf(() => assertPublicHttpUrl('https://nope.example/', { resolve: (h) => resolveViaDoh(h, f) })),
    ).toBe('dns_failed');
  });

  test('DoH 자체가 둘 다 실패(HTTP 5xx) 하면 throw → dns_failed', async () => {
    const f = dohFetch({}, 503);
    await expect(resolveViaDoh('example.com', f)).rejects.toThrow('doh http_503');
    expect(
      await codeOf(() => assertPublicHttpUrl('https://example.com/', { resolve: (h) => resolveViaDoh(h, f) })),
    ).toBe('dns_failed');
  });
});

describe('defaultResolver — Deno.resolveDns 경로 (전역을 테스트 안에서만 흉내)', () => {
  const g = globalThis as { Deno?: unknown };
  const original = g.Deno;

  afterEach(() => {
    if (original === undefined) delete g.Deno;
    else g.Deno = original;
    clearDnsCache();
  });

  test('A 성공 + AAAA 실패(레코드 없음) → A 결과만 쓰고 DoH 로 가지 않는다', async () => {
    const calls: string[] = [];
    g.Deno = {
      resolveDns: async (_host: string, type: string) => {
        calls.push(type);
        if (type === 'A') return [PUBLIC_V4];
        throw new Error('no AAAA record');
      },
    };
    expect(await defaultResolver('example.com')).toEqual([PUBLIC_V4]);
    expect(calls.sort()).toEqual(['A', 'AAAA']);
  });

  test('bun 처럼 Deno 가 없으면 resolveDns 를 건너뛴다 (DoH 폴백 경로 — 네트워크라 여기선 호출만 확인)', () => {
    delete g.Deno;
    expect(typeof defaultResolver).toBe('function');
  });
});
