// 실행: bun test supabase/functions/link-preview
// 고정 HTML 은 2026-11-04 프로브 본문에서 판정에 필요한 태그만 발췌한 것이다 (전체 본문은 scratchpad 에만).
import { describe, expect, test } from 'bun:test';

import {
  collectImageCandidates,
  detectBlockPage,
  filenameFromUrl,
  findMetaRefresh,
  firstLine,
  getLink,
  getMeta,
  getMetaAll,
  isBoilerplateDescription,
  isUsefulMeta,
  looksLikeSpaShell,
  normalizeFields,
  normalizeText,
  parseAttrs,
  parseTags,
  pickCanonicalUrl,
  pickFields,
  resolveUrl,
  sameSite,
  stripControlChars,
  stripTags,
  visibleTextLength,
} from '../html.ts';
import { daangnAdapter, kurlyAdapter } from '../sites/kakao.ts';

const wrap = (head: string, body = '') =>
  `<!DOCTYPE html><html lang="ko"><head>${head}</head><body>${body}</body></html>`;

describe('parseAttrs / parseTags', () => {
  test('속성 순서·따옴표 유무·대소문자 무관, 값은 엔티티 디코드', () => {
    expect(parseAttrs(' content="Schindler&#039;s List" PROPERTY=og:title ')).toEqual({
      content: "Schindler's List",
      property: 'og:title',
    });
    expect(parseAttrs(`name='twitter:card' content='summary'`)).toEqual({ name: 'twitter:card', content: 'summary' });
    expect(parseAttrs('async data-x')).toEqual({ async: '', 'data-x': '' });
  });

  test('자기 닫는 슬래시와 중복 속성(첫 값 우선) 처리', () => {
    expect(parseAttrs('charset="utf-8"/')).toEqual({ charset: 'utf-8' });
    expect(parseAttrs('content="a" content="b"')).toEqual({ content: 'a' });
  });

  test('meta/link/title/JSON-LD 를 모두 뽑고, 주석과 <script> 안의 가짜 메타는 무시한다', () => {
    const html = wrap(
      '<meta property="og:title" content="진짜">' +
        '<!-- <meta property="og:title" content="주석"> -->' +
        '<script>var t = \'<meta property="og:description" content="스크립트 문자열">\';</script>' +
        '<script type="application/ld+json">{"@type":"Product","name":"스웨터","image":"https://img.kr/a.webp"}</script>' +
        '<script type="application/ld+json">{broken</script>' +
        '<link rel="canonical" href="https://a.com/x">' +
        '<title> 제목 &amp; 부제 </title>',
    );
    const tags = parseTags(html);
    expect(getMeta(tags, 'og:title')).toBe('진짜');
    expect(getMeta(tags, 'og:description')).toBe(null);
    expect(tags.title).toBe('제목 & 부제');
    expect(getLink(tags, 'canonical')).toBe('https://a.com/x');
    expect(tags.jsonLd).toHaveLength(1);
  });

  test('<body> 안의 <svg><title> 은 무시하고 head 의 <title> 을 쓴다', () => {
    const html = wrap('<title>본문 제목</title>', '<svg><title>아이콘</title></svg>');
    expect(parseTags(html).title).toBe('본문 제목');
    expect(parseTags(wrap('', '<svg><title>아이콘만</title></svg>')).title).toBe('아이콘만');
  });

  test('getMeta 는 첫 비어있지 않은 값, getMetaAll 은 전부 (문서 순서)', () => {
    const tags = parseTags(
      wrap(
        '<meta property="og:image" content=""><meta property="og:image" content="https://a/1.jpg"><meta property="og:image" content="https://a/2.jpg">',
      ),
    );
    expect(getMeta(tags, 'og:image')).toBe('https://a/1.jpg');
    expect(getMetaAll(tags, 'og:image')).toEqual(['https://a/1.jpg', 'https://a/2.jpg']);
    expect(getMeta(tags, 'OG:IMAGE')).toBe('https://a/1.jpg');
  });

  test('excalidraw 처럼 twitter:* 를 property= 로 쓴 페이지도 읽는다', () => {
    const tags = parseTags(wrap('<meta property="twitter:card" content="summary_large_image"/>'));
    expect(getMeta(tags, 'twitter:card')).toBe('summary_large_image');
  });

  test('getLink 는 rel 토큰 목록과 접두 변형(apple-touch-icon-precomposed) 을 본다', () => {
    const tags = parseTags(
      wrap(
        '<link rel="shortcut icon" href="/f.ico"><link rel="apple-touch-icon-precomposed" href="/a.png"><link rel="image_src" href="/i.jpg">',
      ),
    );
    expect(getLink(tags, 'icon')).toBe('/f.ico');
    expect(getLink(tags, 'apple-touch-icon')).toBe('/a.png');
    expect(getLink(tags, 'image_src')).toBe('/i.jpg');
    expect(getLink(tags, 'canonical')).toBe(null);
  });

  test('따옴표 안의 raw ">" 는 태그 끝이 아니다 — 브레드크럼 설명 뒤의 og:title 도 살아 있다', () => {
    const tags = parseTags(
      wrap(
        '<meta property="og:description" content="홈 > 패션 > 남성 반팔티">' +
          `<meta property='og:title' content='A -> B "따옴표" 포함'>` +
          '<meta name="twitter:title" content="a>b"/>' +
          '<link rel="canonical" href="https://a.com/x?q=a>b">',
      ),
    );
    expect(getMeta(tags, 'og:description')).toBe('홈 > 패션 > 남성 반팔티');
    expect(getMeta(tags, 'og:title')).toBe('A -> B "따옴표" 포함');
    expect(getMeta(tags, 'twitter:title')).toBe('a>b');
    expect(getLink(tags, 'canonical')).toBe('https://a.com/x?q=a>b');
    expect(tags.metas).toHaveLength(3);
  });

  test('따옴표는 "=" 뒤에서만 값을 연다 — 인용 없는 값의 아포스트로피가 다음 태그를 삼키지 않는다', () => {
    const tags = parseTags(
      wrap(`<meta property=og:title content=Schindler's><meta property="og:type" content="video.movie">`),
    );
    expect(getMeta(tags, 'og:title')).toBe('Schindler');
    expect(getMeta(tags, 'og:type')).toBe('video.movie');
  });

  test('문서 끝까지 닫히지 않은 따옴표는 첫 ">" 로 자르고 다음 태그부터 정상 파싱 (멈추지 않는다)', () => {
    const tags = parseTags(
      wrap(
        '<meta property=og:description content="끝나지 않는 값>' +
          '<meta property=og:title content=제목>' +
          '<link rel=canonical href=https://a.com/x>',
      ),
    );
    expect(getMeta(tags, 'og:title')).toBe('제목');
    expect(getLink(tags, 'canonical')).toBe('https://a.com/x');
    expect(getMeta(tags, 'og:description')).toBe(null);
  });

  test('200 KB 적대적 태그(닫히지 않은 따옴표·반복 가짜 <meta) 도 200 ms 안에 끝난다', () => {
    const hostile = [
      // ">" 가 전혀 없는 끝나지 않은 값 — 완성된 태그가 없다
      '<meta content="' + '<meta '.repeat(34000),
      // 모든 ">" 가 따옴표 안에만 있어 태그마다 한도까지 훑고 첫 ">" 로 되돌아가는 최악 패턴
      '<meta x=" > " '.repeat(14300),
      // 따옴표 없이 ">" 도 없는 긴 꼬리
      '<meta ' + 'x'.repeat(200000),
    ];
    for (const h of hostile) {
      expect(h.length).toBeGreaterThanOrEqual(200000);
      const t0 = performance.now();
      const tags = parseTags(h + '<meta property="og:title" content="끝">');
      expect(performance.now() - t0).toBeLessThan(200);
      expect(tags.metas.length).toBeLessThanOrEqual(400);
    }
  });

  test('findMetaRefresh 도 따옴표 안 ">" 를 넘어 refresh 메타를 찾는다', () => {
    expect(
      findMetaRefresh(
        '<meta name="description" content="A > B"><meta http-equiv="refresh" content="0;url=/next">',
        'https://a.com/',
      ),
    ).toBe('https://a.com/next');
  });
});

describe('resolveUrl', () => {
  test('nts.go.kr 루트상대 og:image', () => {
    expect(resolveUrl('/images/nts/layout/logo.png', 'https://www.nts.go.kr/')).toBe(
      'https://www.nts.go.kr/images/nts/layout/logo.png',
    );
  });

  test('namu.wiki 프로토콜상대 og:image 는 페이지 스킴(https) 을 받는다', () => {
    expect(resolveUrl('//i.namu.wiki/i/abc.svg', 'https://namu.wiki/w/%EB%8C%80%ED%95%9C%EB%AF%BC%EA%B5%AD')).toBe(
      'https://i.namu.wiki/i/abc.svg',
    );
  });

  test('Daum 카페 상대 og:url, 경로상대', () => {
    expect(resolveUrl('/supporters/MbmU/92', 'https://m.cafe.daum.net/supporters/MbmU/92')).toBe(
      'https://m.cafe.daum.net/supporters/MbmU/92',
    );
    expect(resolveUrl('img/a.png', 'https://a.com/dir/page.html')).toBe('https://a.com/dir/img/a.png');
  });

  test('http(s) 외 스킴 거부 — YouTube twitter:app:url 의 vnd.youtube://, javascript:, data:', () => {
    expect(
      resolveUrl('vnd.youtube://www.youtube.com/watch?v=4zLfCnGVeL4&feature=applinks', 'https://www.youtube.com/'),
    ).toBe(null);
    expect(resolveUrl('javascript:alert(1)', 'https://a.com/')).toBe(null);
    expect(resolveUrl('data:image/png;base64,AAAA', 'https://a.com/')).toBe(null);
  });

  test('http 는 후보로 허용(서버가 받아 https 로 저장), 프래그먼트 제거, 빈 값·초과 길이 null', () => {
    expect(resolveUrl('http://cfile288.uf.daum.net/original/99471E435D25AD7C063DCE', 'https://m.cafe.daum.net/')).toBe(
      'http://cfile288.uf.daum.net/original/99471E435D25AD7C063DCE',
    );
    expect(resolveUrl('https://a.com/x#top', 'https://a.com/')).toBe('https://a.com/x');
    expect(resolveUrl('', 'https://a.com/')).toBe(null);
    expect(resolveUrl('   ', 'https://a.com/')).toBe(null);
    expect(resolveUrl('https://a.com/' + 'x'.repeat(2100), 'https://a.com/')).toBe(null);
  });

  test('값 안의 제어문자(\\u0000) 는 제거 후 해석', () => {
    expect(resolveUrl('https://a.com/\u0000x', 'https://a.com/')).toBe('https://a.com/x');
  });

  test('sameSite 는 www./m. 접두만 무시', () => {
    expect(sameSite('blog.naver.com', 'm.blog.naver.com')).toBe(true);
    expect(sameSite('www.x.com', 'x.com')).toBe(true);
    expect(sameSite('x.com', 'twitter.com')).toBe(false);
  });
});

describe('pickFields — 우선순위와 보정', () => {
  test('title/description/image 우선순위: og → twitter → <title>/meta', () => {
    const tags = parseTags(
      wrap(
        '<title>HTML 제목</title>' +
          '<meta name="twitter:title" content="트위터 제목">' +
          '<meta property="og:title" content="OG 제목">' +
          '<meta name="description" content="메타 설명">' +
          '<meta name="twitter:description" content="트위터 설명">' +
          '<meta name="twitter:image" content="https://a.com/tw.jpg">' +
          '<meta property="og:image" content="https://a.com/og.jpg">' +
          '<meta property="og:image:secure_url" content="https://a.com/secure.jpg">' +
          '<meta property="og:site_name" content="사이트">' +
          '<meta property="og:type" content="article">',
      ),
    );
    const f = pickFields(tags, 'https://a.com/p/1');
    expect(f.title).toBe('OG 제목');
    expect(f.description).toBe('트위터 설명');
    expect(f.imageCandidates).toEqual(['https://a.com/secure.jpg', 'https://a.com/og.jpg', 'https://a.com/tw.jpg']);
    expect(f.siteName).toBe('사이트');
    expect(f.raw.htmlTitle).toBe('HTML 제목');
    expect(f.raw.hasOgOrTwitter).toBe(true);
  });

  test('og 가 없으면 twitter:title, 그것도 없으면 <title> 과 meta description', () => {
    const f = pickFields(
      parseTags(
        wrap('<title>Flowchart Maker &amp; Online Diagram Software</title><meta name="description" content="d">'),
      ),
      'https://app.diagrams.net/',
    );
    expect(f.title).toBe('Flowchart Maker & Online Diagram Software');
    expect(f.description).toBe('d');
    expect(f.raw.hasOgOrTwitter).toBe(false);
  });

  test('Daum 카페: 상대 og:url + http og:image + 전부 숫자 엔티티 설명 + og:article:author', () => {
    const html = wrap(
      '<meta property="og:url" content="/supporters/MbmU/92">' +
        '<meta property="og:title" content="[안내] 다음카페 인기글 채널을 소개합니다">' +
        '<meta property="og:image" content="http://cfile288.uf.daum.net/original/99471E435D25AD7C063DCE">' +
        '<meta property="og:description" content="&#50504;&#45397;&#54616;&#49464;&#50836;Daum&#52852;&#54168;&#51077;&#45768;&#45796;.">' +
        '<meta property="og:article:author" content="[공식]Daum카페 라운지">' +
        '<meta property="og:type" content="article">',
    );
    const f = pickFields(parseTags(html), 'https://m.cafe.daum.net/supporters/MbmU/92');
    expect(f.title).toBe('[안내] 다음카페 인기글 채널을 소개합니다');
    expect(f.description).toBe('안녕하세요Daum카페입니다.');
    expect(f.imageCandidates).toEqual(['http://cfile288.uf.daum.net/original/99471E435D25AD7C063DCE']);
    expect(f.canonicalUrl).toBe('https://m.cafe.daum.net/supporters/MbmU/92');
    expect(f.author).toBe('[공식]Daum카페 라운지');
  });

  test('author: URL 인 article:author 는 건너뛰고 이름만 받는다', () => {
    const f = pickFields(
      parseTags(
        wrap(
          '<meta property="article:author" content="https://brunch.co.kr/@patagwania"><meta property="og:article:author" content="파타과니아">',
        ),
      ),
      'https://brunch.co.kr/@patagwania/750',
    );
    expect(f.author).toBe('파타과니아');
    const onlyUrl = pickFields(
      parseTags(wrap('<meta property="article:author" content="https://a.com/u">')),
      'https://a.com/p',
    );
    expect(onlyUrl.author).toBe(null);
  });

  test('nts.go.kr 루트상대·namu 프로토콜상대 og:image 가 절대 URL 후보가 된다 (죽은 링크·SVG 판정은 복사 단계)', () => {
    const nts = pickFields(
      parseTags(wrap('<meta property="og:image" content="/images/nts/layout/logo.png">')),
      'https://www.nts.go.kr/',
    );
    expect(nts.imageCandidates).toEqual(['https://www.nts.go.kr/images/nts/layout/logo.png']);
    const namu = pickFields(
      parseTags(wrap('<meta property="og:image" content="//i.namu.wiki/i/x.svg">')),
      'https://namu.wiki/w/x',
    );
    expect(namu.imageCandidates).toEqual(['https://i.namu.wiki/i/x.svg']);
  });

  test('플레이스홀더 이미지 제외: velog·tistory(fname 안 %2F)·notion·static.licdn', () => {
    const html = wrap(
      '<meta property="og:image" content="https://images.velog.io/velog.png">' +
        '<meta property="og:image" content="https://img1.daumcdn.net/thumb/R800x0/?scode=mtistory2&amp;fname=https%3A%2F%2Ft1.daumcdn.net%2Ftistory_admin%2Fstatic%2Fimages%2FopenGraph%2Fopengraph.png">' +
        '<meta property="og:image" content="https://app.notion.com/images/meta/default.png">' +
        '<meta property="og:image" content="https://static.licdn.com/aero-v1/sc/h/22ifp2etz8kb9tgjqn65s9ics">' +
        '<meta property="og:image" content="https://img1.daumcdn.net/thumb/R800x0/?scode=mtistory2&amp;fname=https%3A%2F%2Ftistory1.daumcdn.net%2Ftistory%2F6968064%2Fattach%2F2999d522f27f441a8815ece4719bb49b">',
    );
    const f = pickFields(parseTags(html), 'https://ssb2046.tistory.com/199');
    expect(f.imageCandidates).toEqual([
      'https://img1.daumcdn.net/thumb/R800x0/?scode=mtistory2&fname=https%3A%2F%2Ftistory1.daumcdn.net%2Ftistory%2F6968064%2Fattach%2F2999d522f27f441a8815ece4719bb49b',
    ]);
  });

  test('이미지 폴백 체인: link[rel=image_src] → JSON-LD image → apple-touch-icon, 중복 제거, 비 http(s) 제외', () => {
    const html = wrap(
      '<meta name="twitter:app:url:iphone" content="vnd.youtube://www.youtube.com/watch?v=x">' +
        '<link rel="image_src" href="/src.jpg">' +
        '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"스웨터","image":["https://img.kr/a.webp","/src.jpg"]}]}</script>' +
        '<link rel="apple-touch-icon" href="/touch.png">',
    );
    const tags = parseTags(html);
    expect(collectImageCandidates(tags, 'https://a.com/x')).toEqual([
      'https://a.com/src.jpg',
      'https://img.kr/a.webp',
      'https://a.com/touch.png',
    ]);
  });

  test('컬리: 전 상품 공통 og:description 은 generic 이 살리고 kurly 어댑터가 문구 패턴으로 버린다', () => {
    const bp =
      '사람과 환경을 위한 포장재 - Better Life for All. 건강한 식재료부터 믿을 수 있는 뷰티, 라이프스타일 상품까지.';
    const html = wrap(
      `<meta name="description" content="${bp}" data-next-head=""/>` +
        '<meta property="og:type" content="website" data-next-head=""/>' +
        '<meta property="og:title" content="[Kurly] 컬리 퍼플 박스 35L - 마켓컬리" data-next-head=""/>' +
        `<meta property="og:description" content="${bp}" data-next-head=""/>`,
    );
    const url = 'https://www.kurly.com/goods/1000427479';
    const f = pickFields(parseTags(html), url);
    expect(f.title).toBe('[Kurly] 컬리 퍼플 박스 35L - 마켓컬리');
    expect(f.description).toBe(bp); // website + 중복이라는 이유만으로는 안 버린다
    const kurly = kurlyAdapter.parseSubmitted?.(html, url);
    expect(kurly?.title).toBe('컬리 퍼플 박스 35L');
    expect(kurly?.description).toBe(null);
    expect(kurly?.siteName).toBe('컬리');
  });

  test('og:type=website 이고 og:description == meta description 이어도 유지 — 템플릿 기본값이라 진짜 요약인 경우가 대부분', () => {
    for (const type of ['website', 'article']) {
      const html = wrap(
        `<meta name="description" content="같은 설명"><meta property="og:description" content="같은 설명"><meta property="og:type" content="${type}">`,
      );
      expect(pickFields(parseTags(html), 'https://stackoverflow.com/questions/123/how-to-x').description).toBe(
        '같은 설명',
      );
    }
    expect(
      isBoilerplateDescription('Enjoy the videos and music you love, upload original content, and share it all'),
    ).toBe(true);
    expect(isBoilerplateDescription('같은 설명')).toBe(false);
    expect(isBoilerplateDescription(null)).toBe(false);
  });

  test('당근 동네생활: og:type=website + 중복 설명이 글 본문 — 어댑터 우회 없이 generic 결과 그대로 쓴다', () => {
    const html = wrap(
      '<meta name="description" content="오늘 저녁 같이 산책하실 분">' +
        '<meta property="og:type" content="website">' +
        '<meta property="og:title" content="산책 메이트 구해요 | 당근 동네생활">' +
        '<meta property="og:description" content="오늘 저녁 같이 산책하실 분">',
    );
    const out = daangnAdapter.parseSubmitted?.(html, 'https://www.daangn.com/kr/community/x/');
    expect(out?.title).toBe('산책 메이트 구해요');
    expect(out?.description).toBe('오늘 저녁 같이 산책하실 분');
    expect(out?.siteName).toBe('당근');
  });

  test('canonicalUrl: 같은 사이트의 og:url 만, 추적 파라미터 제거; Notion 처럼 다른 사이트·루트만 가리키면 버린다', () => {
    expect(pickCanonicalUrl(['https://x.com/jack/status/20?s=20'], 'https://x.com/jack/status/20?s=20&t=A')).toBe(
      'https://x.com/jack/status/20',
    );
    expect(
      pickCanonicalUrl(
        ['https://app.notion.com'],
        'https://notion.notion.site/What-s-new-5bc0001166ac450c898189f8a2b07fd8',
      ),
    ).toBe(null);
    expect(pickCanonicalUrl(['https://a.com/'], 'https://a.com/post/1')).toBe(null);
    expect(pickCanonicalUrl(['https://a.com/'], 'https://a.com/')).toBe('https://a.com/');
    expect(pickCanonicalUrl([null, '/alt'], 'https://m.a.com/post/1')).toBe('https://m.a.com/alt');
    expect(
      pickCanonicalUrl(
        ['https://www.instagram.com/jewvely_home/reel/DI3R5NfBWn_/'],
        'https://www.instagram.com/reel/DI3R5NfBWn_/',
      ),
    ).toBe('https://www.instagram.com/jewvely_home/reel/DI3R5NfBWn_/');
  });

  test('결과는 NFC·제어문자 제거·길이 캡까지 끝난 상태 (당근 twitter:description 의 \\u0000)', () => {
    const html = wrap(
      '<meta name="twitter:description" content="중고거래 비추\u0000 사람">' +
        `<meta property="og:title" content="${'가'.repeat(400)}">`,
    );
    const f = pickFields(parseTags(html), 'https://www.daangn.com/kr/community/x/');
    expect(f.description).toBe('중고거래 비추 사람');
    expect(Array.from(f.title as string)).toHaveLength(300);
    expect((f.title as string).endsWith('…')).toBe(true);
  });
});

describe('isUsefulMeta / looksLikeSpaShell', () => {
  test('instagram.com 루트: og:title === og:site_name 은 유용하지 않다', () => {
    const f = pickFields(
      parseTags(
        wrap('<meta property="og:title" content="Instagram"><meta property="og:site_name" content="Instagram">'),
      ),
      'https://www.instagram.com/',
    );
    expect(isUsefulMeta(f, 'www.instagram.com')).toBe(false);
  });

  test('제목이 호스트명(www. 유무) 과 같으면 유용하지 않다, 제목이 없으면 false', () => {
    expect(
      isUsefulMeta(
        pickFields(parseTags(wrap('<title>example.com</title>')), 'https://www.example.com/'),
        'www.example.com',
      ),
    ).toBe(false);
    expect(
      isUsefulMeta(
        pickFields(
          parseTags(
            wrap('<meta property="og:site_name" content="Excalidraw"><meta property="og:type" content="website">'),
          ),
          'https://excalidraw.com/',
        ),
        'excalidraw.com',
      ),
    ).toBe(false);
  });

  test('excalidraw 처럼 og:title 이 사이트명과 다르면 유용', () => {
    const f = pickFields(
      parseTags(
        wrap(
          '<meta property="og:site_name" content="Excalidraw"/><meta property="og:title" content="Excalidraw — Collaborative whiteboarding made easy"/>',
        ),
      ),
      'https://excalidraw.com/',
    );
    expect(isUsefulMeta(f, 'excalidraw.com')).toBe(true);
  });

  test('TodoMVC/diagrams.net 류 SPA 셸: og 0 + 가시 텍스트 <300 + noscript/빈 #root', () => {
    const todomvc = wrap(
      '<title>TodoMVC: React</title>',
      '<section class="todoapp" id="root"></section><script src="app.js"></script>',
    );
    const todoFields = pickFields(parseTags(todomvc), 'https://todomvc.com/examples/react/dist/');
    expect(visibleTextLength(todomvc)).toBeLessThan(300);
    expect(looksLikeSpaShell(todomvc, todoFields)).toBe(true); // 1 KB 미만 본문

    const diagrams = wrap(
      '<title>Flowchart Maker &amp; Online Diagram Software</title>',
      '<noscript><p>You need to enable JavaScript to run this app.</p></noscript><div id="root"></div>' +
        '<script>'.padEnd(1500, 'x') +
        '</script>',
    );
    expect(looksLikeSpaShell(diagrams, pickFields(parseTags(diagrams), 'https://app.diagrams.net/'))).toBe(true);
  });

  test('og:title 이 있거나 본문 텍스트가 충분하면 셸이 아니다', () => {
    const withOg = wrap('<meta property="og:title" content="제목">', '<noscript>x</noscript><div id="root"></div>');
    expect(looksLikeSpaShell(withOg, pickFields(parseTags(withOg), 'https://a.com/'))).toBe(false);
    const article = wrap('<title>글</title>', `<div id="root"><p>${'본문 '.repeat(200)}</p></div>`);
    expect(looksLikeSpaShell(article, pickFields(parseTags(article), 'https://a.com/'))).toBe(false);
  });

  test('visibleTextLength 는 script/style/noscript/head 를 빼고 센다', () => {
    expect(
      visibleTextLength(
        wrap('<title>abcdef</title><style>body{}</style>', '<script>var x="aaaaaaaaaa"</script><p>hi &amp; bye</p>'),
      ),
    ).toBe('hi & bye'.length);
  });
});

describe('detectBlockPage', () => {
  test('gmarket/auction: 403 + server cloudflare + Attention Required!', () => {
    expect(
      detectBlockPage(
        403,
        { server: 'cloudflare', 'cf-ray': 'a551e83489b1735f-ICN' },
        '<title>Attention Required! | Cloudflare</title>',
      ),
    ).toBe('blocked:cloudflare');
  });

  test('Medium/StackOverflow: cf-mitigated: challenge + Just a moment...', () => {
    expect(
      detectBlockPage(403, { server: 'cloudflare', 'cf-mitigated': 'challenge' }, '<title>Just a moment...</title>'),
    ).toBe('blocked:cloudflare');
    // 200 으로 내려오는 JS 챌린지(Reddit) 도 본문 마커로 잡는다
    expect(
      detectBlockPage(
        200,
        {},
        '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>',
      ),
    ).toBe('blocked:cloudflare');
  });

  test('쿠팡: server AkamaiGHost 또는 <TITLE>Access Denied</TITLE> + edgesuite', () => {
    expect(detectBlockPage(403, { server: 'AkamaiGHost' }, '')).toBe('blocked:akamai');
    expect(
      detectBlockPage(
        403,
        {},
        '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>You don\'t have permission to access "http://www.coupang.com/vp/products/9651433228" on this server.<P>Reference #18.d7e9fbcb errors.edgesuite.net</BODY></HTML>',
      ),
    ).toBe('blocked:akamai');
  });

  test('TikTok WAF 스텁·LinkedIn 999', () => {
    expect(detectBlockPage(200, { 'x-tt-system-error': '1' }, '<html></html>')).toBe('waf_stub');
    expect(detectBlockPage(200, {}, '<html><script>window.slardar_us_waf=1</script></html>')).toBe('waf_stub');
    expect(detectBlockPage(999, {}, '')).toBe('waf_stub');
  });

  test('평범한 403(ppomppu ISayPPOM2, IMDb) 과 정상 200 은 null', () => {
    expect(detectBlockPage(403, { server: 'ISayPPOM2', 'content-type': 'text/html' }, '<html>Forbidden</html>')).toBe(
      null,
    );
    expect(detectBlockPage(403, { server: 'Server' }, '')).toBe(null);
    expect(detectBlockPage(200, { server: 'cloudflare' }, '<html><head><title>글</title></head></html>')).toBe(null);
  });
});

describe('텍스트 정규화', () => {
  test('stripControlChars 는 탭·개행은 두고 NUL·C1·BOM 을 뺀다', () => {
    expect(stripControlChars('a\u0000b\u0085c﻿d\te\nf')).toBe('abcd\te\nf');
  });

  test('normalizeText: NFC·공백 정리·캡(코드포인트)·빈 값 null', () => {
    expect(normalizeText('한가', 100)).toBe('한가'); // NFD 자모 → NFC
    expect(normalizeText('  a \t b  ', 100, { singleLine: true })).toBe('a b');
    expect(normalizeText(' 첫 줄 \r\n\r\n  둘째   줄 \n', 100)).toBe('첫 줄\n둘째 줄');
    expect(normalizeText('첫 줄\n둘째 줄', 100, { singleLine: true })).toBe('첫 줄 둘째 줄');
    expect(normalizeText('', 10)).toBe(null);
    expect(normalizeText('\u0000', 10)).toBe(null);
    expect(normalizeText(null, 10)).toBe(null);
  });

  test('캡은 서로게이트 쌍을 자르지 않고 … 로 끝난다', () => {
    const emoji = '😀'.repeat(10);
    const capped = normalizeText(emoji, 5) as string;
    expect(Array.from(capped)).toHaveLength(5);
    expect(capped).toBe('😀😀😀😀…');
  });

  test('normalizeFields 는 DB CHECK 길이(300/1000/120/120) 를 적용한다', () => {
    const f = normalizeFields({
      title: 'x'.repeat(500),
      description: 'y'.repeat(1500),
      author: 'z'.repeat(200),
      siteName: 's'.repeat(200),
      canonicalUrl: 'https://a.com/',
      imageCandidates: ['https://a.com/i.jpg'],
    });
    expect(Array.from(f.title as string)).toHaveLength(300);
    expect(Array.from(f.description as string)).toHaveLength(1000);
    expect(Array.from(f.author as string)).toHaveLength(120);
    expect(Array.from(f.siteName as string)).toHaveLength(120);
    expect(f.canonicalUrl).toBe('https://a.com/');
    expect(f.imageCandidates).toEqual(['https://a.com/i.jpg']);
  });

  test('firstLine: 인스타 캡션 첫 줄 ≤80', () => {
    expect(firstLine('\n옷에 자주 흘리는 칠칠이들 주목!!\n\n#꿀팁 #살림')).toBe('옷에 자주 흘리는 칠칠이들 주목!!');
    expect(firstLine('가'.repeat(100), 80)).toBe('가'.repeat(79) + '…');
    expect(firstLine('   ')).toBe(null);
  });

  test('stripTags: <br>/블록 닫힘 → 개행, 스크립트 제거, 엔티티 디코드 (X oEmbed <p>)', () => {
    const p =
      '<p lang="en" dir="ltr">just setting up my twttr<br>line2 &amp; more <a href="https://t.co/x">pic.twitter.com/x</a></p><script>x()</script>';
    expect(stripTags(p)).toBe('just setting up my twttr\nline2 & more pic.twitter.com/x\n');
  });

  test('filenameFromUrl: 직접 이미지·PDF 제목', () => {
    expect(filenameFromUrl('https://i.ytimg.com/vi/4zLfCnGVeL4/hqdefault.jpg')).toBe('hqdefault.jpg');
    expect(filenameFromUrl('https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf?x=1')).toBe(
      'dummy.pdf',
    );
    expect(filenameFromUrl('https://a.com/%ED%8C%8C%EC%9D%BC.png')).toBe('파일.png');
    expect(filenameFromUrl('https://a.com/')).toBe('a.com');
    expect(filenameFromUrl('nope')).toBe(null);
  });
});

describe('findMetaRefresh', () => {
  test('gov.kr 실제 본문: <meta http-equiv="refresh" content="0;URL=/portal/main"> → 상대 경로 해석', () => {
    const govkr =
      '<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta http-equiv="refresh" content="0;URL=/portal/main">\n' +
      '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>\n<title>정부24</title>\n</head>\n<body>\n</body>\n</html>';
    expect(findMetaRefresh(govkr, 'https://www.gov.kr/')).toBe('https://www.gov.kr/portal/main');
  });

  test('속성 순서 반대·따옴표·공백 변형·url= 생략', () => {
    expect(findMetaRefresh(`<meta content="5; url='https://b.com/x'" http-equiv=Refresh>`, 'https://a.com/')).toBe(
      'https://b.com/x',
    );
    expect(findMetaRefresh('<meta http-equiv="REFRESH" content="0; URL = /next">', 'https://a.com/')).toBe(
      'https://a.com/next',
    );
    expect(findMetaRefresh('<meta http-equiv="refresh" content="0;/next">', 'https://a.com/')).toBe(
      'https://a.com/next',
    );
  });

  test('대상 없는 새로고침·비 http 스킴·주석 안·없음 → null', () => {
    expect(findMetaRefresh('<meta http-equiv="refresh" content="30">', 'https://a.com/')).toBe(null);
    expect(findMetaRefresh('<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', 'https://a.com/')).toBe(
      null,
    );
    expect(findMetaRefresh('<!-- <meta http-equiv="refresh" content="0;url=/x"> -->', 'https://a.com/')).toBe(null);
    expect(findMetaRefresh('<meta name="viewport" content="width=device-width">', 'https://a.com/')).toBe(null);
  });
});
