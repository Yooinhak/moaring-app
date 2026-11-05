// 실행: bun test supabase/functions/link-preview
// misc.ts 중 리다이렉터를 거치는 두 어댑터 — Reddit 앱 공유 링크(/r/<sub>/s/<id>) 와 LinkedIn 단축(lnkd.in). 둘 다 "첫 Location 만 읽고
// 호스트로 분기" 가 핵심이라 가짜 io 는 fetch.ts 의 hopAllow·firstHopOnly 규칙을 그대로 흉내 낸다 (x.test.ts 의 followChain 과 동일).
import { describe, expect, test } from 'bun:test';

import { canonicalize, matchesHost } from '../canonical.ts';
import { linkedinAdapter, redditAdapter, redditOembedUrl } from '../sites/misc.ts';
import type {
  FetchJsonResult,
  FetchTextResult,
  PreviewIO,
  ProviderCtx,
  ProviderOutcome,
  ResolveRedirectsOptions,
  ResolveRedirectsResult,
  SiteAdapter,
} from '../types.ts';

// ---------------------------------------------------------------------------
// 가짜 io / ctx
// ---------------------------------------------------------------------------

/** 시작 URL 의 응답 체인 — locations[k] 는 k번째 응답의 Location. 비면 리다이렉트가 아니었고 status 가 그 응답 코드. */
interface RedirectChain {
  locations: string[];
  status?: number;
}

interface Routes {
  text?: Record<string, Partial<FetchTextResult>>;
  json?: Record<string, Partial<FetchJsonResult>>;
  redirects?: Record<string, RedirectChain | Error>;
}

interface Call {
  method: keyof PreviewIO;
  url: string;
  opts?: unknown;
}

/** fetch.ts requestWithRedirects 의 규칙: 홉 ≥1 이 hopAllow 밖이면 ssrf:hop_host, firstHopOnly 면 첫 Location 을 검사 없이 돌려준다. */
function followChain(url: string, chain: RedirectChain, opts: ResolveRedirectsOptions): ResolveRedirectsResult {
  const hops: string[] = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    const host = new URL(current).hostname;
    if (hop >= 1 && opts.hopAllow && opts.hopAllow.length > 0 && !matchesHost(host, opts.hopAllow)) {
      throw Object.assign(new Error(`ssrf:hop_host (${host})`), { code: 'ssrf:hop_host' });
    }
    const next = chain.locations[hop];
    if (!next) return { hops, final: current, firstLocation: chain.locations[0], status: chain.status ?? 200 };
    if (opts.firstHopOnly) return { hops, final: current, firstLocation: next, status: 301 };
    if (hop >= opts.maxHops) throw Object.assign(new Error('too_many_redirects'), { code: 'too_many_redirects' });
    hops.push(current);
    current = next;
  }
}

function makeIo(routes: Routes = {}) {
  const calls: Call[] = [];
  const io: PreviewIO = {
    fetchText(url, opts) {
      calls.push({ method: 'fetchText', url, opts });
      const r = routes.text?.[url];
      if (!r) return Promise.reject(new Error(`fake io: no route (fetchText) ${url}`));
      return Promise.resolve({ status: 200, finalUrl: url, contentType: 'text/html', text: '', headers: {}, ...r });
    },
    fetchJson(url, opts) {
      calls.push({ method: 'fetchJson', url, opts });
      const r = routes.json?.[url];
      if (!r) return Promise.reject(new Error(`fake io: no route (fetchJson) ${url}`));
      return Promise.resolve({
        status: 200,
        finalUrl: url,
        contentType: 'application/json',
        json: null,
        headers: {},
        ...r,
      });
    },
    head(url) {
      calls.push({ method: 'head', url });
      return Promise.reject(new Error(`fake io: no route (head) ${url}`));
    },
    resolveRedirects(url, opts) {
      calls.push({ method: 'resolveRedirects', url, opts });
      const chain = routes.redirects?.[url];
      if (!chain) return Promise.reject(new Error(`fake io: no route (resolveRedirects) ${url}`));
      if (chain instanceof Error) return Promise.reject(chain);
      try {
        return Promise.resolve(followChain(url, chain, opts));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
  return { io, calls };
}

function makeCtx(adapter: SiteAdapter, postUrl: string, io: PreviewIO, extra: Partial<ProviderCtx> = {}): ProviderCtx {
  const u = new URL(postUrl);
  const c = adapter.canonicalize ? adapter.canonicalize(u) : canonicalize(u);
  return {
    postUrl,
    fetchUrl: c.fetchUrl,
    canonicalUrl: c.canonicalUrl,
    io,
    deadline: Date.now() + 25_000,
    log: () => {},
    hintTitle: null,
    attempts: 1,
    ...extra,
  };
}

function expectKind<K extends ProviderOutcome['kind']>(
  o: ProviderOutcome,
  kind: K,
): Extract<ProviderOutcome, { kind: K }> {
  if (o.kind !== kind) throw new Error(`expected ${kind}, got ${o.kind}${'error' in o ? ` (${o.error})` : ''}`);
  return o as Extract<ProviderOutcome, { kind: K }>;
}

const firstHopOpts = (calls: Call[]) => calls[0].opts as ResolveRedirectsOptions;

// ---------------------------------------------------------------------------
// Reddit — /r/<sub>/s/<shareId> 공유 링크
// ---------------------------------------------------------------------------

describe('redditAdapter — 앱 공유 링크 /r/<sub>/s/<id>', () => {
  const SHARE = 'https://www.reddit.com/r/reactnative/s/AbCdEf1234';
  const PERMALINK = 'https://www.reddit.com/r/reactnative/comments/1abcde/some_title/';
  const OEMBED = { title: 'Some title', author_name: 'someone', provider_name: 'reddit', type: 'rich' };

  test('첫 Location(permalink) 으로 바꿔 oEmbed 에 묻고 canonical 도 permalink — 공유 id 가 아니라 글로 모인다', async () => {
    const { io, calls } = makeIo({
      redirects: { [SHARE]: { locations: [`${PERMALINK}?share_id=xyz&utm_name=iossmf`], status: 200 } },
      json: { [redditOembedUrl(PERMALINK)]: { json: OEMBED } },
    });
    const out = expectKind(await redditAdapter.run(makeCtx(redditAdapter, SHARE, io)), 'ready');
    expect(out.source).toBe('oembed');
    expect(out.fields.title).toBe('Some title');
    expect(out.fields.author).toBe('u/someone');
    expect(out.fields.siteName).toBe('r/reactnative');
    expect(out.fields.canonicalUrl).toBe(PERMALINK);

    expect(calls.map((c) => c.method)).toEqual(['resolveRedirects', 'fetchJson']);
    expect(firstHopOpts(calls).firstHopOnly).toBe(true);
    expect(calls[1].url).toBe(redditOembedUrl(PERMALINK));
    expect(calls[1].url).not.toContain('AbCdEf1234');
  });

  test('Location 이 reddit 밖이면 unsupported(offsite_redirect), oEmbed 는 부르지 않는다', async () => {
    const { io, calls } = makeIo({ redirects: { [SHARE]: { locations: ['https://example.com/x'] } } });
    const out = expectKind(await redditAdapter.run(makeCtx(redditAdapter, SHARE, io)), 'unsupported');
    expect(out.error).toBe('offsite_redirect');
    expect(calls.map((c) => c.method)).toEqual(['resolveRedirects']);
  });

  test('Location 없는 404 → unsupported(gone)', async () => {
    const { io } = makeIo({ redirects: { [SHARE]: { locations: [], status: 404 } } });
    expect(await redditAdapter.run(makeCtx(redditAdapter, SHARE, io))).toEqual({ kind: 'unsupported', error: 'gone' });
  });

  test('permalink 저장은 전처럼 바로 oEmbed (resolveRedirects 없음)', async () => {
    const { io, calls } = makeIo({ json: { [redditOembedUrl(PERMALINK)]: { json: OEMBED } } });
    const out = expectKind(
      await redditAdapter.run(makeCtx(redditAdapter, `${PERMALINK}?utm_source=share`, io)),
      'ready',
    );
    expect(out.fields.canonicalUrl).toBe(PERMALINK);
    expect(calls.map((c) => c.method)).toEqual(['fetchJson']);
  });
});

// ---------------------------------------------------------------------------
// LinkedIn — lnkd.in 단축
// ---------------------------------------------------------------------------

describe('linkedinAdapter — lnkd.in', () => {
  const SHORT = 'https://lnkd.in/gAbC123';
  const LINKEDIN_HOP_HOSTS = ['*.linkedin.com', 'lnkd.in'];
  const ARTICLE = 'https://techcrunch.com/2026/11/04/some-article/';
  const ARTICLE_HTML =
    '<html><head><meta property="og:title" content="Some article"><meta property="og:site_name" content="TechCrunch">' +
    `<meta property="og:url" content="${ARTICLE}"></head><body></body></html>`;
  const POST = 'https://www.linkedin.com/posts/hardik_activity-123';
  const POST_HTML =
    '<html><head><meta property="og:title" content="#imageprocessing #dip | Hardik Kamboj | 12 comments">' +
    '<meta property="og:description" content="Digital image processing notes">' +
    '<meta property="og:image" content="https://static.licdn.com/aero-v1/sc/h/placeholder.png"></head><body></body></html>';

  test('가짜 io 검증: 외부 체인을 LinkedIn hopAllow 로 따라가면 fetch.ts 처럼 ssrf:hop_host (옛 fetchPage 경로가 죽던 지점)', () => {
    expect(() => followChain(SHORT, { locations: [ARTICLE] }, { maxHops: 8, hopAllow: LINKEDIN_HOP_HOSTS })).toThrow(
      /ssrf:hop_host/,
    );
  });

  test('★ lnkd.in → 외부 기사(대다수): 첫 Location 만 읽고(firstHopOnly·hopAllow 없음) generic 으로 그 URL 을 읽는다', async () => {
    const { io, calls } = makeIo({
      redirects: { [SHORT]: { locations: [ARTICLE] } },
      text: { [ARTICLE]: { text: ARTICLE_HTML } },
    });
    const out = expectKind(await linkedinAdapter.run(makeCtx(linkedinAdapter, SHORT, io)), 'ready');
    expect(out.fields.title).toBe('Some article');
    expect(out.fields.siteName).toBe('TechCrunch');
    expect(out.fields.canonicalUrl).toBe(ARTICLE);

    expect(calls.map((c) => c.method)).toEqual(['resolveRedirects', 'fetchText']);
    expect(firstHopOpts(calls).firstHopOnly).toBe(true);
    expect(firstHopOpts(calls).hopAllow).toBeUndefined();
    expect(calls[1].url).toBe(ARTICLE);
    expect((calls[1].opts as { hopAllow?: unknown }).hopAllow).toBeUndefined();
  });

  test('lnkd.in → linkedin.com/posts/ 는 LinkedIn 흐름: trk 제거한 주소를 LinkedIn 홉 안에서 읽고 canonical 도 그 주소', async () => {
    const { io, calls } = makeIo({
      redirects: { [SHORT]: { locations: [`${POST}?trk=public_post&utm_source=share`] } },
      text: { [POST]: { text: POST_HTML } },
    });
    const out = expectKind(await linkedinAdapter.run(makeCtx(linkedinAdapter, SHORT, io)), 'ready');
    expect(out.fields.title).toBe('#imageprocessing #dip');
    expect(out.fields.author).toBe('Hardik Kamboj');
    expect(out.fields.siteName).toBe('LinkedIn');
    expect(out.fields.canonicalUrl).toBe(POST);
    expect(out.fields.imageCandidates).toEqual([]); // static.licdn.com 플레이스홀더 제외

    expect(calls.map((c) => c.method)).toEqual(['resolveRedirects', 'fetchText']);
    expect(calls[1].url).toBe(POST);
    expect((calls[1].opts as { hopAllow?: string[] }).hopAllow).toEqual(LINKEDIN_HOP_HOSTS);
  });

  test('lnkd.in → /in/ 프로필은 해석 뒤에도 네트워크 없이 unsupported(login_wall) + 슬러그 제목', async () => {
    const { io, calls } = makeIo({
      redirects: { [SHORT]: { locations: ['https://www.linkedin.com/in/savas-tutumlu?trk=x'] } },
    });
    const out = expectKind(await linkedinAdapter.run(makeCtx(linkedinAdapter, SHORT, io)), 'unsupported');
    expect(out.error).toBe('login_wall');
    expect(out.fields?.title).toBe('Savas tutumlu');
    expect(calls.map((c) => c.method)).toEqual(['resolveRedirects']);
  });

  test('Location 없는 404 → unsupported(gone)', async () => {
    const { io } = makeIo({ redirects: { [SHORT]: { locations: [], status: 404 } } });
    expect(await linkedinAdapter.run(makeCtx(linkedinAdapter, SHORT, io))).toEqual({
      kind: 'unsupported',
      error: 'gone',
    });
  });
});
