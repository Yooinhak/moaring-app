/**
 * 토스트 브리지 — React 바깥(queryClient 등)에서 토스트를 띄우기 위한 최소 통로.
 *
 * ToastProvider 가 마운트되면서 자신의 showToast 를 여기 등록하고,
 * queryClient 의 QueryCache onError 처럼 훅을 쓸 수 없는 곳에서 이걸 호출한다.
 * (Toast ↔ queryClient 직접 import 를 피해 순환 참조를 만들지 않는다)
 */

type Notify = (message: string) => void;

let handler: Notify | null = null;

/** ToastProvider 전용 — 마운트 시 등록, 언마운트 시 null. */
export function registerErrorToast(fn: Notify | null) {
  handler = fn;
}

/** Provider 가 아직 없으면 콘솔로 폴백(스플래시 단계 에러도 흔적은 남긴다). */
export function notifyError(message: string) {
  if (handler) handler(message);
  else console.warn('[toastBridge] Provider 미등록:', message);
}
