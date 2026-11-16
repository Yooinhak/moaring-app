import { isValidUrl } from './validateUrl';

/** 공유 텍스트에서 첫 http(s) 링크를 뽑는다 — "이거 봐 https://… #태그" 같은 문장 대응. */
export function extractUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (isValidUrl(trimmed)) return trimmed;
  const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  return match && isValidUrl(match[0]) ? match[0] : null;
}
