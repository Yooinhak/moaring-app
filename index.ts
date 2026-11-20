import { AppRegistry } from 'react-native';

import { registerRootComponent } from 'expo';

import App from './App';
import ShareApp from './src/share/ShareApp';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// Android 공유 시트(ShareSheetActivity) 루트 — 앱 전환 없이 공유한 앱 위에 저장 시트만 띄운다.
AppRegistry.registerComponent('share', () => ShareApp);
