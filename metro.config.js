const { getDefaultConfig } = require('expo/metro-config');
const { withShareExtension } = require('expo-share-extension/metro');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// 디버그 빌드에서 iOS 공유 확장이 ?shareExtension=true 로 요청하면 index.share 번들을 내준다.
module.exports = withNativeWind(withShareExtension(config), { input: './global.css' });
