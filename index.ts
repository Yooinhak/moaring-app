import { AppRegistry, Platform } from 'react-native';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// Android 공유 시트(ShareSheetActivity) 루트 — 앱 전환 없이 공유한 앱 위에 저장 시트만 띄운다.
// Android 전용 + 지연 로드: ShareApp 은 iOS 에서 shareHost.ios → expo-share-extension 을 불러오는데,
// 그 네이티브 모듈은 공유 확장(IOS_SHARE_EXT=1) 빌드에만 있다. 메인 앱이 이걸 import 하면 실기기 앱이
// 시작 즉시 "Cannot find native module 'ExpoShareExtension'" 로 멈춘다(스플래시 고정).
// iOS 공유 확장은 index.share.js 가 따로 띄운다.
if (Platform.OS === 'android') {
  AppRegistry.registerComponent('share', () => require('./src/share/ShareApp').default);
}
