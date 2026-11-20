/**
 * Edge Function `link-preview` 호출 래퍼 (얇게 — 응답 해석·토스트는 호출자 몫).
 *
 * 함수는 요청 바디의 URL 을 절대 fetch 하지 않는다 — 우리는 post_id 만 보내고, 서버가 DB 의 posts.url 을
 * 읽어 수집한다. 바디 URL 을 믿으면 함수가 누구나 쓰는 SSRF 프록시가 되기 때문이다.
 * 인증은 supabase-js 가 붙이는 사용자 JWT 하나(delete-account 와 같은 패턴, ProfileScreen 참고) —
 * 서버는 RLS 가 보여주는 글만 처리하고, 안 보이는 id 는 results[].skipped='not_found' 로 돌아온다.
 *
 * reject·error 는 그대로 전달한다. 저장 직후 가속 호출은 `void requestPreviewFetch(...)` 로 버리고,
 * 수동 재시도(useRefreshPreview) 만 cooldown 을 사용자에게 보여준다. 여기서 토스트를 띄우지 않는 이유:
 * 함수 미배포·5xx 여도 카드는 도메인 카드로 멀쩡히 그려지므로 사용자에게 알릴 실패가 아니다.
 */
import { supabase } from '../supabase/client';

import type { DeviceAssistHints, DeviceHints, PreviewResponse, PreviewResult } from './types';

const FUNCTION_NAME = 'link-preview';

/** 서버 계약(mode fetch post_ids ≤ 8)과 같다 — 넘기면 서버가 400 으로 거절한다 */
export const PREVIEW_BATCH_SIZE = 8;

/**
 * supabase.functions.invoke 의 {data, error} 를 그대로 노출한다. FunctionsResponse 유니언을 쓰지 않는 이유:
 * 배치는 일부 청크가 성공한 뒤 실패할 수 있어 data(부분 results)와 error 가 동시에 있을 수 있다.
 */
export type PreviewInvokeResult = { data: PreviewResponse | null; error: Error | null };

function invoke(body: Record<string, unknown>): Promise<PreviewInvokeResult> {
  return supabase.functions.invoke<PreviewResponse>(FUNCTION_NAME, { method: 'POST', body });
}

/** 서버 index.ts BODY_MAX_BYTES(8192) 에서 헤더·프레이밍 여유를 뺀 값 — 넘기면 서버가 400 으로 거절한다 */
const FETCH_BODY_SOFT_LIMIT_BYTES = 7680;
/** 바디가 넘칠 때 빼는 순서 — 카드 품질 기여가 낮은 것부터(설명 → 이미지 → canonical → 작성자) */
const DEVICE_FIELD_DROP_ORDER: Array<keyof DeviceHints> = ['description', 'image_url', 'canonical_url', 'author'];

/** JSON.stringify 결과의 UTF-8 바이트 수. 한글은 3바이트라 code unit 길이로는 서버 캡을 가늠할 수 없다 (TextEncoder 미의존) */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // 서로게이트 쌍 = 코드포인트 1개 = 4바이트
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** fetch 바디가 서버 캡(8 KB)을 넘지 않게 device 힌트를 덜어낸다. 폰이 뽑은 값은 힌트일 뿐이라 일부를 버려도 서버 수집은 그대로다 */
function fitFetchBody(body: Record<string, unknown>): Record<string, unknown> {
  if (utf8ByteLength(JSON.stringify(body)) <= FETCH_BODY_SOFT_LIMIT_BYTES) return body;
  const device = { ...(body.device as DeviceHints) };
  for (const key of DEVICE_FIELD_DROP_ORDER) {
    if (device[key] === undefined || device[key] === null) continue;
    delete device[key];
    const next = { ...body, device };
    if (utf8ByteLength(JSON.stringify(next)) <= FETCH_BODY_SOFT_LIMIT_BYTES) return next;
  }
  // 제목만 남아도 넘치면(비현실적 — 제목 캡 300자) 힌트 없이 보낸다
  const { device: _dropped, ...rest } = body;
  return rest;
}

/**
 * 단건 수집 — 저장 직후 가속(device = 저장 전 parseMetadata 결과, 없으면 null) 과 수동 재시도(force).
 * force 는 post 당 60초 쿨다운이 있어 results[0].skipped === 'cooldown' 으로 거절될 수 있다.
 * device 나 force 가 실리면 서버가 owner/editor 만 허용한다(viewer 는 403 + results[0].skipped === 'forbidden').
 */
export function requestPreviewFetch(
  postId: number,
  device?: DeviceHints | null,
  force?: boolean,
): Promise<PreviewInvokeResult> {
  const body: Record<string, unknown> = {
    mode: 'fetch',
    post_id: postId,
    ...(device ? { device } : {}),
    ...(force ? { force: true } : {}),
  };
  return invoke(device ? fitFetchBody(body) : body);
}

/**
 * 폴더 catch-up 배치 — 8개씩 쪼개 순차 호출하고 results 를 이어 붙인다(동시 호출은 함수 CPU 예산을 겹치게 한다).
 * onChunk 는 청크 하나가 끝날 때마다 불린다 — 호출자가 청크마다 목록을 invalidate 해 먼저 끝난 카드부터 채우라고.
 * 청크가 error 를 돌려주면 거기서 멈춘다(함수 미배포·세션 만료면 나머지도 같은 이유로 실패한다):
 * data 에는 그때까지 모은 results 를 success:false 로 담고 error 를 그대로 싣는다.
 */
export async function requestPreviewBatch(
  postIds: number[],
  onChunk?: (result: PreviewInvokeResult, ids: number[]) => void,
): Promise<PreviewInvokeResult> {
  const results: PreviewResult[] = [];
  for (let i = 0; i < postIds.length; i += PREVIEW_BATCH_SIZE) {
    const ids = postIds.slice(i, i + PREVIEW_BATCH_SIZE);
    const res = await invoke({ mode: 'fetch', post_ids: ids });
    onChunk?.(res, ids);
    if (res.error) {
      return { data: { success: false, results }, error: res.error };
    }
    if (res.data?.results) results.push(...res.data.results);
  }
  return { data: { success: true, results }, error: null };
}

/**
 * 폰 파싱 결과 제출(needs_client 행, owner/editor 만). 전부 null 인 결과도 보낸다 —
 * 서버가 그 행을 failed 로 종결해야 catch-up 이 같은 글을 무한히 다시 돌리지 않는다.
 */
export function requestPreviewAssist(postId: number, device: DeviceAssistHints): Promise<PreviewInvokeResult> {
  return invoke({ mode: 'assist', post_id: postId, device });
}
