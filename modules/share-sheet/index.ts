import { requireOptionalNativeModule } from 'expo';

/**
 * 공유 시트 Activity(Android) 제어. iOS/웹에는 네이티브 모듈이 없어 no-op.
 */
const ShareSheet = requireOptionalNativeModule<{ close(): void }>('ShareSheet');

/** 공유 시트 Activity 를 닫고 공유한 앱으로 돌아간다. */
export function closeShareSheet() {
  ShareSheet?.close();
}
