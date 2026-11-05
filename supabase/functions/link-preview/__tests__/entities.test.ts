// 실행: bun test supabase/functions/link-preview
// 고정 문자열은 2026-11-04 프로브에서 실제로 관측된 메타 값의 짧은 발췌다.
import { describe, expect, test } from 'bun:test';

import { decodeEntities, hasNamedEntity } from '../entities.ts';

describe('decodeEntities — 숫자 엔티티', () => {
  test('Wikipedia og:title 의 0패딩 10진 &#039;', () => {
    expect(decodeEntities('Schindler&#039;s List - Wikipedia')).toBe("Schindler's List - Wikipedia");
  });

  test('Rotten Tomatoes og:title 의 &#39;', () => {
    expect(decodeEntities('Schindler&#39;s List | Rotten Tomatoes')).toBe("Schindler's List | Rotten Tomatoes");
  });

  test('YouTube twitter:description 의 I&#39;ve', () => {
    expect(decodeEntities('I&#39;ve come to talk with you again')).toBe("I've come to talk with you again");
  });

  test('16진 소문자·대문자 X', () => {
    expect(decodeEntities('&#x27;a&#X27;')).toBe("'a'");
  });

  test('Instagram twitter:title 의 16진 한글 &#xc96c;… → 쥬블리홈', () => {
    expect(decodeEntities('&#xc96c;&#xbe14;&#xb9ac;&#xd648;')).toBe('쥬블리홈');
  });

  test('Daum 카페 og:description — 전부 숫자 엔티티로 쓰인 한국어', () => {
    const src =
      '&#50504;&#45397;&#54616;&#49464;&#50836;Daum&#52852;&#54168;&#51077;&#45768;&#45796;.&#47588;&#51068; &#49892;&#49884;&#44036;';
    expect(decodeEntities(src)).toBe('안녕하세요Daum카페입니다.매일 실시간');
  });

  test('Instagram 임베드 alt 의 &#064; → @', () => {
    expect(decodeEntities('Instagram post shared by &#064;jewvely_home')).toBe(
      'Instagram post shared by @jewvely_home',
    );
  });

  test('세미콜론 누락 10진도 디코드', () => {
    expect(decodeEntities('Tom &#38 Jerry')).toBe('Tom & Jerry');
  });

  test('0·서로게이트·범위 밖은 U+FFFD, C1 은 Windows-1252 재매핑', () => {
    expect(decodeEntities('&#0;')).toBe('�');
    expect(decodeEntities('&#xD800;')).toBe('�');
    expect(decodeEntities('&#x110000;')).toBe('�');
    expect(decodeEntities('it&#146;s')).toBe('it’s');
  });
});

describe('decodeEntities — 명명 엔티티', () => {
  test('Wikipedia og:title 의 &quot;Heroes&quot;', () => {
    expect(decodeEntities('&quot;Heroes&quot; (album) - Wikipedia')).toBe('"Heroes" (album) - Wikipedia');
  });

  test('brunch og:description 의 &#34; 와 ohou &amp;', () => {
    expect(decodeEntities('&#34;브런치&#34; 볼만한 글')).toBe('"브런치" 볼만한 글');
    expect(decodeEntities('image.jpeg?w=1200&amp;h=630')).toBe('image.jpeg?w=1200&h=630');
  });

  test('og:image URL 안의 &amp; (Wikipedia utm 체인) — URL 도 디코드해야 fetch 가 된다', () => {
    const src =
      'https://upload.wikimedia.org/x.jpg?utm_source=en.wikipedia.org&amp;utm_campaign=index&amp;utm_content=thumbnail';
    expect(decodeEntities(src)).toBe(
      'https://upload.wikimedia.org/x.jpg?utm_source=en.wikipedia.org&utm_campaign=index&utm_content=thumbnail',
    );
  });

  test('GitHub meta content 의 &lt;user-name&gt;', () => {
    expect(decodeEntities('/&lt;user-name&gt;/&lt;repo-name&gt;')).toBe('/<user-name>/<repo-name>');
  });

  test('diagrams.net <title> 의 &amp;, nbsp·hellip·따옴표류', () => {
    expect(decodeEntities('Flowchart Maker &amp; Online Diagram Software')).toBe(
      'Flowchart Maker & Online Diagram Software',
    );
    expect(decodeEntities('a&nbsp;b&hellip;&ldquo;c&rdquo;&rsquo;')).toBe('a b…“c”’');
    expect(decodeEntities('&middot;&copy;&trade;')).toBe('·©™');
  });

  test('세미콜론 누락 명명 엔티티는 디코드하되 "&not=" 처럼 뒤에 = 가 오면 보존 (쿼리 파라미터 보호)', () => {
    expect(decodeEntities('A &amp B')).toBe('A & B');
    expect(decodeEntities('?a=1&not=2&copy=3')).toBe('?a=1&not=2&copy=3');
  });

  test('모르는 이름·불완전한 참조는 그대로', () => {
    expect(decodeEntities('&foo; &bar &; &#; &#x; &')).toBe('&foo; &bar &; &#; &#x; &');
    expect(decodeEntities('&ampersand')).toBe('&ampersand');
  });

  test('한 번만 디코드 — &amp;lt; 가 < 로 변하면 안 된다', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  test('& 가 없으면 입력 그대로, null/undefined 는 빈 문자열', () => {
    expect(decodeEntities('plain')).toBe('plain');
    expect(decodeEntities(null)).toBe('');
    expect(decodeEntities(undefined)).toBe('');
  });

  test('표 조회 헬퍼', () => {
    expect(hasNamedEntity('amp')).toBe(true);
    expect(hasNamedEntity('nosuch')).toBe(false);
  });
});
