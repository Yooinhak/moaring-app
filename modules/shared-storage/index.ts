import { requireOptionalNativeModule } from 'expo';

import type { SharedStorageNative } from '../../src/utils/storage/createAppStorage';

/** iOS 전용. Android/웹에는 네이티브 모듈이 없어 null. */
export const SharedStorage = requireOptionalNativeModule<SharedStorageNative>('SharedStorage');
