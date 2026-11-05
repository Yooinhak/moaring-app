// 실행: bun test supabase/functions/link-preview
// yes24 는 같은 호스트가 메인(ks_c_5601-1987 / euc-kr) 과 상품(UTF8) 에 다른 charset 을 쓴다 — 응답마다 판정해야 한다.
import { describe, expect, test } from 'bun:test';

import {
  charsetFromContentType,
  charsetFromMeta,
  decodeHtmlBytes,
  detectBom,
  latin1Prefix,
  mediaType,
  normalizeCharsetLabel,
  pickCharset,
  replacementRatio,
} from '../charset.ts';

// yes24 메인 <title> 의 실제 바이트: bf b9 bd ba 32 34 = EUC-KR '예스24'
const YES24_TITLE_BYTES = new Uint8Array([0xbf, 0xb9, 0xbd, 0xba, 0x32, 0x34]);
const YES24_MAIN_HEADER = 'text/html; charset=ks_c_5601-1987';
const YES24_PRODUCT_HEADER = 'text/html;charset=UTF8';

describe('normalizeCharsetLabel', () => {
  test('yes24 헤더 라벨 ks_c_5601-1987 → euc-kr', () => {
    expect(normalizeCharsetLabel('ks_c_5601-1987')).toBe('euc-kr');
  });

  test('yes24 상품 페이지 라벨 UTF8 (하이픈 없음) → utf-8', () => {
    expect(normalizeCharsetLabel('UTF8')).toBe('utf-8');
  });

  test('한국어 비표준 변형들 전부 euc-kr', () => {
    for (const label of ['ms949', 'cp949', 'ksc5601', 'KSC5601', 'euc_kr', 'EUC-KR', 'windows-949', 'x-windows-949']) {
      expect(normalizeCharsetLabel(label)).toBe('euc-kr');
    }
  });

  test('trim·따옴표 제거', () => {
    expect(normalizeCharsetLabel(' "euc-kr" ')).toBe('euc-kr');
    expect(normalizeCharsetLabel("'UTF-8'")).toBe('utf-8');
    expect(normalizeCharsetLabel('EUC-KR ')).toBe('euc-kr');
  });

  test('모르는 라벨은 소문자 그대로(호출자가 try/catch), 빈 값은 null', () => {
    expect(normalizeCharsetLabel('Shift_JIS')).toBe('shift_jis');
    expect(normalizeCharsetLabel('')).toBe(null);
    expect(normalizeCharsetLabel('""')).toBe(null);
    expect(normalizeCharsetLabel(null)).toBe(null);
  });

  test("TextDecoder 는 'euc_kr' 을 거부한다 — 정규화가 필요한 이유", () => {
    expect(() => new TextDecoder('euc_kr')).toThrow(RangeError);
    expect(new TextDecoder(normalizeCharsetLabel('euc_kr') as string).encoding).toBe('euc-kr');
  });
});

describe('charsetFromContentType / mediaType', () => {
  test('헤더 파라미터', () => {
    expect(charsetFromContentType(YES24_MAIN_HEADER)).toBe('euc-kr');
    expect(charsetFromContentType(YES24_PRODUCT_HEADER)).toBe('utf-8');
    expect(charsetFromContentType('text/html; charset="UTF-8"')).toBe('utf-8');
    expect(charsetFromContentType('text/html')).toBe(null);
    expect(charsetFromContentType(null)).toBe(null);
  });

  test("mediaType 은 ';' 뒤를 버린다 — W3C PDF 는 'application/pdf; qs=0.001'", () => {
    expect(mediaType('application/pdf; qs=0.001')).toBe('application/pdf');
    expect(mediaType('Text/HTML; charset=utf-8')).toBe('text/html');
    expect(mediaType(null)).toBe(null);
  });
});

describe('BOM / <meta>', () => {
  test('BOM', () => {
    expect(detectBom('ï»¿<!DOCTYPE')).toBe('utf-8');
    expect(detectBom('ÿþ<')).toBe('utf-16le');
    expect(detectBom('þÿ<')).toBe('utf-16be');
    expect(detectBom('<!DOCTYPE')).toBe(null);
  });

  test('yes24 메인의 <meta http-equiv="Content-Type" content="text/html;charset=euc-kr" />', () => {
    const prefix =
      '\n\t<!DOCTYPE html>\n\t<html lang="ko">\n\n<head>\n\t<meta http-equiv="X-UA-Compatible" content="IE=Edge" />\n' +
      '\t<meta http-equiv="Content-Type" content="text/html;charset=euc-kr" />';
    expect(charsetFromMeta(prefix)).toBe('euc-kr');
  });

  test('<meta charset=…> 따옴표 유무·대소문자·속성 순서', () => {
    expect(charsetFromMeta('<meta charset="utf-8"/>')).toBe('utf-8');
    expect(charsetFromMeta('<META CHARSET=EUC-KR>')).toBe('euc-kr');
    expect(charsetFromMeta('<meta content="text/html; charset=UTF-8" http-equiv="Content-Type">')).toBe('utf-8');
    expect(charsetFromMeta('<meta name="viewport" content="width=device-width">')).toBe(null);
  });
});

describe('pickCharset — BOM → 헤더 → meta', () => {
  test('헤더가 있으면 meta 가 달라도 헤더 우선 (yes24 메인: 헤더 ks_c_5601-1987, meta euc-kr)', () => {
    const pick = pickCharset(
      YES24_MAIN_HEADER,
      '<meta http-equiv="Content-Type" content="text/html;charset=euc-kr" />',
    );
    expect(pick).toEqual({ label: 'euc-kr', source: 'header' });
  });

  test('UTF-8 BOM 은 euc-kr 헤더보다 우선한다 (WHATWG — 레거시 서버 기본값 + UTF-8(BOM) 저장 파일)', () => {
    expect(pickCharset(YES24_MAIN_HEADER, 'ï»¿<meta charset="utf-8"><title>x</title>')).toEqual({
      label: 'utf-8',
      source: 'bom',
    });
    expect(pickCharset('text/html; charset=euc-kr', 'ÿþ<\u0000')).toEqual({ label: 'utf-16le', source: 'bom' });
  });

  test('헤더에 charset 없으면 BOM, 그다음 meta', () => {
    expect(pickCharset('text/html', 'ï»¿<meta charset="euc-kr">')).toEqual({ label: 'utf-8', source: 'bom' });
    expect(pickCharset('text/html', '<html><head><meta charset="utf-8">')).toEqual({ label: 'utf-8', source: 'meta' });
    expect(pickCharset(null, '<html><head><title>x</title>')).toEqual({ label: null, source: null });
  });

  test('당근처럼 헤더가 bare text/html 이고 meta 만 있는 경우', () => {
    expect(pickCharset('text/html', '<!DOCTYPE html><html><head><meta charset=utf-8>')).toEqual({
      label: 'utf-8',
      source: 'meta',
    });
  });
});

describe('decodeHtmlBytes', () => {
  test('yes24 메인 바이트 + ks_c_5601-1987 헤더 → 예스24', () => {
    const r = decodeHtmlBytes(YES24_TITLE_BYTES, YES24_MAIN_HEADER);
    expect(r.text).toBe('예스24');
    expect(r.charset).toBe('euc-kr');
    expect(r.source).toBe('header');
    expect(r.replacementRatio).toBe(0);
  });

  test('같은 바이트를 UTF-8 로 읽으면 복구 불가한 깨진 글자가 된다 (왜 원본 바이트를 한 번만 디코드해야 하는지)', () => {
    const wrong = new TextDecoder('utf-8').decode(YES24_TITLE_BYTES);
    expect(wrong).not.toBe('예스24');
    expect(replacementRatio(wrong)).toBeGreaterThan(0.3);
  });

  test('헤더·meta 모두 없으면 utf-8 fatal 실패 → euc-kr 폴백', () => {
    const r = decodeHtmlBytes(YES24_TITLE_BYTES, 'text/html');
    expect(r.text).toBe('예스24');
    expect(r.source).toBe('euc-kr-fallback');
  });

  test('UTF8 라벨 상품 페이지 (한글 UTF-8 바이트)', () => {
    const bytes = new TextEncoder().encode('독재자(들) | 황현필 | 역바연 - 예스24');
    const r = decodeHtmlBytes(bytes, YES24_PRODUCT_HEADER);
    expect(r.text).toBe('독재자(들) | 황현필 | 역바연 - 예스24');
    expect(r.charset).toBe('utf-8');
    expect(r.source).toBe('header');
  });

  test('단서 없는 UTF-8 본문은 fatal 디코더로 성공 (utf8-fatal)', () => {
    const bytes = new TextEncoder().encode('<title>정부24</title>');
    const r = decodeHtmlBytes(bytes, null);
    expect(r.text).toBe('<title>정부24</title>');
    expect(r.source).toBe('utf8-fatal');
  });

  test('1 MiB 캡으로 멀티바이트 글자가 끊긴 꼬리는 오류가 아니라 버려진다 (stream:true)', () => {
    const full = new TextEncoder().encode('가나다'); // 9 바이트
    const cut = full.subarray(0, 7); // 마지막 글자의 1/3 지점에서 잘림
    const r = decodeHtmlBytes(cut, null);
    expect(r.text).toBe('가나');
    expect(r.source).toBe('utf8-fatal');
  });

  test('meta 가 모르는 라벨을 주장하면 라벨을 버리고 utf-8 fatal → euc-kr 체인으로', () => {
    const r = decodeHtmlBytes(new TextEncoder().encode('<meta charset="x-nope">한글'), 'text/html');
    expect(r.text).toContain('한글');
    expect(r.source).toBe('utf8-fatal');
  });

  test('BOM 은 디코더가 삼킨다', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('abc')]);
    const r = decodeHtmlBytes(bytes, 'text/html');
    expect(r.text).toBe('abc');
    expect(r.source).toBe('bom');
  });

  test('euc-kr 헤더 + UTF-8 BOM 본문은 UTF-8 로 읽는다 (WHATWG: BOM 이 헤더보다 우선)', () => {
    const html = '<meta charset="utf-8"><title>예스24 - 독재자(들)</title>';
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(html)]);
    const r = decodeHtmlBytes(bytes, 'text/html; charset=euc-kr');
    expect(r.text).toBe(html);
    expect(r.charset).toBe('utf-8');
    expect(r.source).toBe('bom');
    expect(r.replacementRatio).toBe(0);

    // 헤더를 따랐다면: 한글이 전부 깨지고 치환문자가 5% 게이트를 넘어 멀쩡한 페이지의 텍스트를 버렸을 것이다
    const wrong = new TextDecoder('euc-kr').decode(bytes);
    expect(wrong).not.toContain('예스24');
    expect(replacementRatio(wrong)).toBeGreaterThan(0.05);
  });
});

describe('replacementRatio / latin1Prefix', () => {
  test('비율', () => {
    expect(replacementRatio('')).toBe(0);
    expect(replacementRatio('abcd')).toBe(0);
    expect(replacementRatio('a�')).toBe(0.5);
  });

  test('latin1Prefix 는 바이트를 그대로 문자코드로 올리고 max 에서 자른다', () => {
    const bytes = new Uint8Array([0x3c, 0xbf, 0xb9, 0x3e]);
    expect(latin1Prefix(bytes)).toBe('<¿¹>');
    expect(latin1Prefix(bytes, 2)).toBe('<¿');
    expect(latin1Prefix(new Uint8Array(5000), 4096).length).toBe(4096);
  });
});
