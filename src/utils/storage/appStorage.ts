import AsyncStorage from '@react-native-async-storage/async-storage';

import { SharedStorage } from '../../../modules/shared-storage';

import { createAppStorage } from './createAppStorage';

/** expo-share-extension 기본 규칙(group.<bundleId>)과 같아야 한다. */
export const APP_GROUP = 'group.dev.inak.moaring';

/**
 * 메인 앱·iOS 공유 확장이 함께 읽는 값(세션·현재 그룹·최근 폴더·최근 이모지) 전용 저장소.
 * iOS → App Group UserDefaults, Android/웹 → AsyncStorage (기존 키 그대로라 마이그레이션 불필요).
 */
export const appStorage = createAppStorage(SharedStorage, APP_GROUP, AsyncStorage);
