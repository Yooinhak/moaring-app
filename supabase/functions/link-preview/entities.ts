// HTML 엔티티 디코더 (순수 모듈 — Deno 전역 없음, bun test 로 검증)
//
// 메타 속성값은 거의 항상 엔티티가 섞여 온다 (프로브 2026-11-04):
//   Wikipedia  og:title  "Schindler&#039;s List"           → 0패딩 10진
//   RT         og:title  "Schindler&#39;s List"            → 10진
//   Wikipedia  og:title  "&quot;Heroes&quot; (album)"      → 명명
//   YouTube    twitter:description "I&#39;ve come…"
//   Daum 카페  og:description 전체가 "&#50504;&#45397;…"    → 숫자 엔티티만으로 쓰인 한국어
//   Instagram  twitter:title "&#xc96c;…"                   → 16진
//   og:image URL 안의 "&amp;utm_campaign=…"               → URL 도 디코드해야 fetch 가 된다
// DOM 이 없는 Edge Runtime 에서 textarea 트릭을 못 쓰므로 표준의 핵심 규칙만 직접 구현한다.

/** 자주 보이는 명명 엔티티만. 전체 2,231개 표는 번들 크기·CPU 대비 가치가 없다. 모르는 이름은 그대로 둔다. */
const NAMED: Record<string, string> = {
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  bdquo: '„',
  mdash: '—',
  ndash: '–',
  minus: '−',
  copy: '©',
  COPY: '©',
  reg: '®',
  REG: '®',
  trade: '™',
  bull: '•',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  micro: 'µ',
  para: '¶',
  sect: '§',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  curren: '¤',
  iexcl: '¡',
  iquest: '¿',
  shy: '­',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  lrm: '‎',
  rlm: '‏',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  prime: '′',
  Prime: '″',
  oline: '‾',
  frasl: '⁄',
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  hearts: '♥',
  spades: '♠',
  clubs: '♣',
  diams: '♦',
  infin: '∞',
  ne: '≠',
  le: '≤',
  ge: '≥',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  tilde: '˜',
  circ: 'ˆ',
  Tab: '\t',
  NewLine: '\n',
  excl: '!',
  num: '#',
  dollar: '$',
  percnt: '%',
  lpar: '(',
  rpar: ')',
  ast: '*',
  plus: '+',
  comma: ',',
  period: '.',
  sol: '/',
  colon: ':',
  semi: ';',
  equals: '=',
  quest: '?',
  commat: '@',
  lsqb: '[',
  bsol: '\\',
  rsqb: ']',
  lowbar: '_',
  grave: '`',
  lcub: '{',
  verbar: '|',
  rcub: '}',
  star: '☆',
  starf: '★',
  check: '✓',
  cross: '✗',
};

/**
 * HTML 표준 "numeric character reference end state" 의 C1 재매핑.
 * 옛 윈도우 CMS 가 &#146; 처럼 Windows-1252 코드를 그대로 뱉는 경우가 있어 브라우저와 같은 글자를 내기 위함.
 */
const C1_REMAP: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};

// 16진(&#x27; &#X27;) · 10진(&#39; &#039; 0패딩) · 명명(&amp;) — 세미콜론은 선택.
// 명명 이름은 영문으로 시작하는 1~32자, 숫자는 과도한 자릿수를 막아 parseInt 오버플로를 피한다.
const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{0,31}))(;?)/g;

function fromCodePoint(cp: number): string {
  // 0·서로게이트·범위 밖은 표준처럼 U+FFFD. 그대로 두면 String.fromCodePoint 가 throw 한다.
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  const remapped = C1_REMAP[cp];
  if (remapped !== undefined) return remapped;
  return String.fromCodePoint(cp);
}

/**
 * 엔티티를 문자로 바꾼다. 한 번만 디코드한다 — 두 번 돌리면 "&amp;lt;" 가 "<" 가 되어 XSS·URL 오염 여지가 생긴다.
 * 세미콜론이 없는 명명 엔티티는 뒤에 '=' 이 오면 엔티티로 보지 않는다(속성값 규칙: "?a=1&not=2" 보호).
 */
export function decodeEntities(input: string | null | undefined): string {
  if (!input) return '';
  if (input.indexOf('&') === -1) return input;
  return input.replace(
    ENTITY_RE,
    (
      whole: string,
      hex: string | undefined,
      dec: string | undefined,
      name: string | undefined,
      semi: string,
      offset: number,
      str: string,
    ) => {
      if (hex !== undefined) return fromCodePoint(parseInt(hex, 16));
      if (dec !== undefined) return fromCodePoint(parseInt(dec, 10));
      if (name === undefined) return whole;
      const mapped = NAMED[name];
      if (mapped === undefined) return whole;
      if (!semi) {
        const next = str.charAt(offset + whole.length);
        if (next === '=') return whole;
      }
      return mapped;
    },
  );
}

/** 테스트·디버깅용: 이름이 표에 있는지. */
export function hasNamedEntity(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NAMED, name);
}
