/**
 * 키-값 저장소 선택 로직 (RN 의존 없음 → 단위 테스트 대상).
 *
 * iOS 공유 확장은 메인 앱과 다른 프로세스라 AsyncStorage(앱 전용 컨테이너)를 공유하지 못한다.
 * App Group UserDefaults 네이티브 모듈이 있으면 그걸 쓰고, 없으면(Android·웹) 폴백을 그대로 쓴다.
 */

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
}

/** modules/shared-storage 의 iOS 네이티브 함수 (동기) */
export interface SharedStorageNative {
  getItem(suite: string, key: string): string | null;
  setItem(suite: string, key: string, value: string): void;
  removeItem(suite: string, key: string): void;
}

export function createAppStorage(
  native: SharedStorageNative | null,
  suite: string,
  fallback: KeyValueStorage,
): KeyValueStorage {
  if (!native) return fallback;

  return {
    getItem: async (key) => native.getItem(suite, key),
    setItem: async (key, value) => native.setItem(suite, key, value),
    removeItem: async (key) => native.removeItem(suite, key),
    multiRemove: async (keys) => keys.forEach((key) => native.removeItem(suite, key)),
  };
}
