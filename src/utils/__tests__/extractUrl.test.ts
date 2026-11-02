import { extractUrl } from '../extractUrl';

describe('extractUrl', () => {
  it('URL 만 있으면 그대로 반환', () => {
    expect(extractUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('앞뒤 공백 제거', () => {
    expect(extractUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('문장 속 첫 링크 추출', () => {
    expect(extractUrl('이거 봐 https://youtu.be/abc #꿀팁 https://other.com')).toBe('https://youtu.be/abc');
  });

  it('링크가 없으면 null', () => {
    expect(extractUrl('그냥 텍스트')).toBeNull();
  });

  it('http(s) 가 아니면 null', () => {
    expect(extractUrl('ftp://example.com')).toBeNull();
  });

  it('빈 값이면 null', () => {
    expect(extractUrl(undefined)).toBeNull();
    expect(extractUrl(null)).toBeNull();
    expect(extractUrl('')).toBeNull();
  });
});
