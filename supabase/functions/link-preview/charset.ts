// 응답 charset 판정 + 바이트 디코드 (순수 모듈 — TextDecoder 는 웹 표준이라 Deno·bun 양쪽에 있다)
//
// 왜 필요한가 (프로브 2026-11-04):
//   - yes24 메인은 헤더 'charset=ks_c_5601-1987'(EUC-KR 의 윈도우 별칭) + 본문 <meta …charset=euc-kr>,
//     같은 호스트의 상품 페이지는 헤더 'charset=UTF8'(하이픈 없음). → 응답마다 판정, 도메인 단위 캐시 금지.
//   - UTF-8 로 잘못 디코드한 '����24' 는 복구가 안 된다. 원본 바이트를 한 번만 디코드해야 한다.
//   - Deno 의 TextDecoder 는 WHATWG 라벨 표에 없는 라벨('euc_kr', 'x-nope') 에 RangeError 를 던진다.
//     bun 에서 확인: 'euc-kr' 'ks_c_5601-1987' 'windows-949' 'UTF8' 은 통과, 'euc_kr' 은 거부.
//   - 1 MiB 캡으로 잘린 본문은 마지막 글자가 끊겨 있을 수 있다 → fatal 디코더는 {stream:true} 로 돌려야
//     끊긴 꼬리를 오류가 아니라 "대기" 로 처리한다.

export type CharsetSource = 'header' | 'bom' | 'meta';

export interface CharsetPick {
  /** 정규화된 WHATWG 라벨 ('euc-kr' | 'utf-8' | …). 아무 단서도 없으면 null. */
  label: string | null;
  source: CharsetSource | null;
}

export interface DecodedHtml {
  text: string;
  /** 실제 디코더가 보고한 encoding 이름 (TextDecoder.encoding). */
  charset: string;
  /** 라벨을 어디서 얻었나. 단서 없이 utf-8 fatal 성공이면 'utf8-fatal', 그것도 실패해 euc-kr 로 떨어졌으면 'euc-kr-fallback'. */
  source: CharsetSource | 'utf8-fatal' | 'euc-kr-fallback';
  /** U+FFFD 비율. 5% 넘으면 호출자가 텍스트 필드를 버리고 ASCII 필드만 쓴다 (설계 §10). */
  replacementRatio: number;
}

// WHATWG Encoding Standard 의 EUC-KR 라벨 + 실무에서 보이는 비표준 변형(ms949·cp949·euc_kr).
const EUC_KR_LABELS = new Set([
  'euc-kr',
  'euc_kr',
  'euckr',
  'cseuckr',
  'csksc56011987',
  'iso-ir-149',
  'korean',
  'ks_c_5601-1987',
  'ks_c_5601-1989',
  'ks_c_5601_1987',
  'ksc5601',
  'ksc_5601',
  'ms949',
  'cp949',
  'windows-949',
  'x-windows-949',
]);

const UTF8_LABELS = new Set([
  'utf-8',
  'utf8',
  'unicode-1-1-utf-8',
  'unicode11utf8',
  'unicode20utf8',
  'x-unicode20utf8',
]);

// 표준이 windows-1252 로 취급하는 라벨들. 그대로 넘겨도 디코더가 같은 결과를 내지만 비교·로그를 위해 통일.
const LATIN1_LABELS = new Set([
  'iso-8859-1',
  'iso8859-1',
  'latin1',
  'l1',
  'ascii',
  'us-ascii',
  'windows-1252',
  'cp1252',
]);

/**
 * charset 라벨을 TextDecoder 가 받는 WHATWG 라벨로 정규화한다.
 * trim · 따옴표 제거 · 소문자 → 한국어 계열은 전부 'euc-kr', UTF-8 변형은 'utf-8'. 모르는 라벨은 소문자 그대로
 * 돌려주고 호출자가 try/catch 로 TextDecoder 에 넘긴다. 빈 값은 null.
 */
export function normalizeCharsetLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const lower = label
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim()
    .toLowerCase();
  if (!lower) return null;
  if (EUC_KR_LABELS.has(lower)) return 'euc-kr';
  if (UTF8_LABELS.has(lower)) return 'utf-8';
  if (LATIN1_LABELS.has(lower)) return 'windows-1252';
  return lower;
}

/** Content-Type 헤더의 charset 파라미터. 'text/html; charset="utf-8"' 처럼 따옴표가 있어도 된다. 없으면 null. */
export function charsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const m = /;\s*charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/i.exec(contentType);
  return m ? normalizeCharsetLabel(m[1]) : null;
}

/** 'text/html; charset=UTF-8' → 'text/html'. 비교는 항상 이 값으로 한다 (W3C PDF 는 'application/pdf; qs=0.001'). */
export function mediaType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const t = contentType.split(';')[0].trim().toLowerCase();
  return t || null;
}

/** 본문 앞부분(latin1 문자열) 의 BOM. UTF-8 BOM 은 EF BB BF, UTF-16 은 FF FE / FE FF. */
export function detectBom(prefixLatin1: string): string | null {
  if (prefixLatin1.startsWith('ï»¿')) return 'utf-8';
  if (prefixLatin1.startsWith('ÿþ')) return 'utf-16le';
  if (prefixLatin1.startsWith('þÿ')) return 'utf-16be';
  return null;
}

// <meta charset="euc-kr"> 과 <meta http-equiv="Content-Type" content="text/html; charset=euc-kr"> 둘 다
// 'charset=' 토큰 뒤의 라벨만 보면 되므로 하나의 정규식으로 잡는다. 속성 순서·따옴표 유무 무관.
const META_CHARSET_RE = /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_:.()+-]+)/i;

/** <meta> 의 charset. 표준 프리스캔은 1,024바이트지만 호출자가 넘긴 접두부 전체를 본다 (yes24 는 108바이트에 있었다). */
export function charsetFromMeta(prefixLatin1: string): string | null {
  const m = META_CHARSET_RE.exec(prefixLatin1);
  return m ? normalizeCharsetLabel(m[1]) : null;
}

/**
 * 우선순위: BOM → 헤더 → <meta> (WHATWG decode 와 브라우저가 따르는 순서). 아무것도 없으면 {label:null} 이고 호출자는
 * utf-8 fatal → euc-kr 순으로 시도한다.
 * BOM 이 헤더보다 앞인 이유: 서버 기본값이 euc-kr 로 남은 레거시 IIS/Apache 에 UTF-8(BOM) 로 저장한 파일을 올린 경우가 있다.
 * 헤더대로 EUC-KR 로 풀면 한글이 전부 깨져(U+FFFD 12~30%) 5% 게이트가 멀쩡한 UTF-8 페이지의 텍스트를 버리게 된다.
 * bytesPrefixAsLatin1 은 바이트를 그대로 문자코드로 올린 문자열(latin1Prefix) — 인코딩을 모르는 상태에서
 * ASCII 마커를 찾기 위한 트릭이라 멀티바이트 글자는 깨져 보여도 상관없다.
 */
export function pickCharset(headerContentType: string | null | undefined, bytesPrefixAsLatin1: string): CharsetPick {
  const fromBom = detectBom(bytesPrefixAsLatin1);
  if (fromBom) return { label: fromBom, source: 'bom' };
  const fromHeader = charsetFromContentType(headerContentType);
  if (fromHeader) return { label: fromHeader, source: 'header' };
  const fromMeta = charsetFromMeta(bytesPrefixAsLatin1);
  if (fromMeta) return { label: fromMeta, source: 'meta' };
  return { label: null, source: null };
}

/** U+FFFD 비율 (0~1). 빈 문자열은 0. */
export function replacementRatio(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) n++;
  }
  return n / text.length;
}

/** 앞 max 바이트를 latin1 문자열로. 큰 페이지에서 String.fromCharCode(...spread) 의 인자 수 제한을 피하려고 청크로 자른다. */
export function latin1Prefix(bytes: Uint8Array, max = 4096): string {
  const n = Math.min(bytes.length, max);
  let out = '';
  for (let i = 0; i < n; i += 1024) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(n, i + 1024))));
  }
  return out;
}

function tryDecoder(label: string, fatal: boolean): TextDecoder | null {
  try {
    return new TextDecoder(label, { fatal });
  } catch {
    // Deno: RangeError "The encoding label provided ('…') is invalid." — 라벨이 표에 없다
    return null;
  }
}

/**
 * HTML 바이트를 한 번에 디코드한다 (BOM → 헤더 → meta → utf-8 fatal → euc-kr).
 * stream:true 로 호출해 캡에 잘린 마지막 멀티바이트 글자를 오류로 보지 않게 한다.
 */
export function decodeHtmlBytes(bytes: Uint8Array, headerContentType: string | null | undefined): DecodedHtml {
  const pick = pickCharset(headerContentType, latin1Prefix(bytes));
  if (pick.label && pick.source) {
    const decoder = tryDecoder(pick.label, false);
    if (decoder) {
      const text = decoder.decode(bytes, { stream: true });
      return { text, charset: decoder.encoding, source: pick.source, replacementRatio: replacementRatio(text) };
    }
  }
  const strict = tryDecoder('utf-8', true);
  if (strict) {
    try {
      const text = strict.decode(bytes, { stream: true });
      return { text, charset: 'utf-8', source: 'utf8-fatal', replacementRatio: replacementRatio(text) };
    } catch {
      // utf-8 로 해석 불가 — 한국 사이트에서 현실적으로 남는 유일한 다른 인코딩은 EUC-KR 이다
    }
  }
  const eucKr = new TextDecoder('euc-kr');
  const text = eucKr.decode(bytes, { stream: true });
  return { text, charset: eucKr.encoding, source: 'euc-kr-fallback', replacementRatio: replacementRatio(text) };
}
