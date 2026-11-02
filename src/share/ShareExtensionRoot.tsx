import React from 'react';

import type { InitialProps } from 'expo-share-extension';

import ShareApp from './ShareApp';

/**
 * iOS 공유 확장 루트 (AppRegistry 'shareExtension', index.share.js).
 * Safari 공유 → url, 메모·메신저 텍스트 공유 → text. 이후 흐름은 Android 와 같은 ShareApp.
 */
export default function ShareExtensionRoot({ url, text }: InitialProps) {
  return <ShareApp sharedText={url ?? text} />;
}
