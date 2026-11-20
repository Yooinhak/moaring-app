// 실행: bun test supabase/functions/link-preview
import { describe, expect, test } from 'bun:test';

import { canonicalize, matchesHost, parseHttpUrl, pathSegments, stripTrackingParams } from '../canonical.ts';

const strip = (href: string) => stripTrackingParams(new URL(href)).href;

describe('stripTrackingParams — 전역 목록', () => {
  test('Instagram 공유 시트 igsh (= 가 들어간 값 포함)', () => {
    expect(strip('https://www.instagram.com/reel/DVnTUlzgrGe/?igsh=MXdoeDg3OXE5cmU1ag==')).toBe(
      'https://www.instagram.com/reel/DVnTUlzgrGe/',
    );
    expect(strip('https://www.instagram.com/p/X/?igshid=abc')).toBe('https://www.instagram.com/p/X/');
  });

  test('YouTube si·feature 는 빼고 v·t(재생 위치)·list 는 남긴다', () => {
    expect(strip('https://youtu.be/dQw4w9WgXcQ?si=abcDEF123')).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(strip('https://www.youtube.com/watch?si=abcDEF123&v=dQw4w9WgXcQ&feature=youtu.be')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(strip('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123&pp=0gcJCbsCQVKahPAF')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123',
    );
  });

  test('utm_* 접두 전부 + fbclid/gclid', () => {
    expect(
      strip('https://a.com/p?utm_source=x&utm_medium=y&utm_campaign=z&utm_id=1&UTM_Content=c&fbclid=f&gclid=g&q=1'),
    ).toBe('https://a.com/p?q=1');
  });

  test('남는 파라미터가 없으면 ? 도 사라진다', () => {
    expect(strip('https://a.com/p?utm_source=x')).toBe('https://a.com/p');
  });

  test('입력 URL 은 변경하지 않는다', () => {
    const u = new URL('https://a.com/?utm_source=x');
    stripTrackingParams(u);
    expect(u.search).toBe('?utm_source=x');
  });
});

describe('stripTrackingParams — 호스트별', () => {
  test('X 공유 시트 ?s=20&t=… 는 x.com/twitter.com 에서만', () => {
    expect(strip('https://x.com/jack/status/20?s=20&t=AbCdEfGh123')).toBe('https://x.com/jack/status/20');
    expect(strip('https://mobile.twitter.com/jack/status/20?s=20')).toBe('https://mobile.twitter.com/jack/status/20');
    // 다른 사이트의 s/t 는 의미가 있을 수 있어 보존
    expect(strip('https://example.com/search?s=shoes&t=1')).toBe('https://example.com/search?s=shoes&t=1');
  });

  test('쿠팡 Location 의 추적 파라미터 (lptag·wPcid·mcid·traceid·itime·sharesource …) 제거, itemId·vendorItemId 보존', () => {
    const loc =
      'https://www.coupang.com/vp/products/7608804797?itemId=20146298818&vendorItemId=87239403818&src=1191000&spec=10999999' +
      '&addtag=400&ctag=7608804797&lptag=CFM24988502&itime=20261104&pageType=PRODUCT&pageValue=7608804797&wPcid=abc' +
      '&redirect=landing&traceid=t1&mcid=m1&subid=s1&sharesource=sharebutton&style=&isshortened=Y&settlement=N';
    expect(strip(loc)).toBe(
      'https://www.coupang.com/vp/products/7608804797?itemId=20146298818&vendorItemId=87239403818',
    );
  });

  test('네이버 RSS 꼬리 fromRss/trackingCode, 지도 placePath', () => {
    expect(strip('https://blog.naver.com/naverofficial/224464411656?fromRss=true&trackingCode=rss')).toBe(
      'https://blog.naver.com/naverofficial/224464411656',
    );
    expect(strip('https://map.naver.com/p/entry/place/19764118?placePath=%2Fhome')).toBe(
      'https://map.naver.com/p/entry/place/19764118',
    );
  });
});

describe('matchesHost', () => {
  test("'*.naver.com' 은 apex 와 하위 전부", () => {
    expect(matchesHost('naver.com', ['*.naver.com'])).toBe(true);
    expect(matchesHost('m.blog.naver.com', ['*.naver.com'])).toBe(true);
    expect(matchesHost('naver.com.evil.com', ['*.naver.com'])).toBe(false);
    expect(matchesHost('evilnaver.com', ['*.naver.com'])).toBe(false);
  });

  test('정확 일치는 대소문자·끝 점 무관, RegExp 도 받는다', () => {
    expect(matchesHost('T.CO', ['t.co'])).toBe(true);
    expect(matchesHost('x.com.', ['x.com'])).toBe(true);
    expect(matchesHost('i.ytimg.com', [/^i\.ytimg\.com$/])).toBe(true);
    expect(matchesHost('www.x.com', ['x.com'])).toBe(false);
  });

  test('패턴이 없으면 false (제한 없음은 호출자가 따로 판단)', () => {
    expect(matchesHost('a.com', undefined)).toBe(false);
    expect(matchesHost('a.com', [])).toBe(false);
  });
});

describe('canonicalize (기본 구현)', () => {
  test('프래그먼트·추적 파라미터·userinfo 제거, 호스트 소문자, 기본 포트 정리', () => {
    const r = canonicalize('https://user:pw@WWW.Example.com:443/Path/?utm_source=x&id=7#frag');
    expect(r.canonicalUrl).toBe('https://www.example.com/Path/?id=7');
    expect(r.fetchUrl).toBe(r.canonicalUrl);
  });

  test('URL 객체 입력도 받고 원본은 건드리지 않는다', () => {
    const u = new URL('https://a.com/x?si=1#y');
    expect(canonicalize(u).canonicalUrl).toBe('https://a.com/x');
    expect(u.href).toBe('https://a.com/x?si=1#y');
  });

  test('한글 경로는 WHATWG URL 이 퍼센트 인코딩, IDN 호스트는 punycode', () => {
    expect(canonicalize('https://namu.wiki/w/대한민국').canonicalUrl).toBe(
      'https://namu.wiki/w/%EB%8C%80%ED%95%9C%EB%AF%BC%EA%B5%AD',
    );
    expect(new URL(canonicalize('https://한국인터넷정보센터.한국/').canonicalUrl).hostname).toBe(
      'xn--3e0bx5euxnjje69i70af08bea817g.xn--3e0b707e',
    );
  });

  test('경로 대소문자·끝 슬래시는 유지', () => {
    expect(canonicalize('https://a.com/A/B/').canonicalUrl).toBe('https://a.com/A/B/');
  });
});

describe('parseHttpUrl / pathSegments', () => {
  test('http(s) 만 통과', () => {
    expect(parseHttpUrl(' https://a.com/x ')?.href).toBe('https://a.com/x');
    expect(parseHttpUrl('http://a.com')?.protocol).toBe('http:');
    expect(parseHttpUrl('vnd.youtube://www.youtube.com/watch?v=x')).toBe(null);
    expect(parseHttpUrl('javascript:alert(1)')).toBe(null);
    expect(parseHttpUrl('not a url')).toBe(null);
    expect(parseHttpUrl('')).toBe(null);
    expect(parseHttpUrl(null)).toBe(null);
  });

  test('pathSegments 는 빈 조각을 뺀다', () => {
    expect(pathSegments(new URL('https://blog.naver.com/naverofficial/224464411656/'))).toEqual([
      'naverofficial',
      '224464411656',
    ]);
    expect(pathSegments(new URL('https://a.com'))).toEqual([]);
  });
});
