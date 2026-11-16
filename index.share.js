import './src/share/patchTextForExtension'; // 반드시 첫 import — 확장 텍스트 폰트 스케일 보정
import { AppRegistry } from 'react-native';

import ShareExtensionRoot from './src/share/ShareExtensionRoot';

// iOS 공유 확장 번들 엔트리. 이름은 반드시 'shareExtension' (expo-share-extension 네이티브가 이 이름으로 띄움).
AppRegistry.registerComponent('shareExtension', () => ShareExtensionRoot);
