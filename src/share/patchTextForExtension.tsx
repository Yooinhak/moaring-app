import React, { forwardRef } from 'react';

/**
 * iOS 공유 확장 전용 — RN Text/TextInput 을 allowFontScaling={false} 로 감싼다.
 * 확장에는 UIApplication 이 없어 폰트 스케일 계산이 깨지고 글자가 안 보인다 (expo-share-extension README).
 *
 * `Libraries/Text/Text` 의 default 는 getter 전용이라 못 바꾼다. 대신 react-native 진입 모듈의
 * `Text`/`TextInput` getter(객체 리터럴 → configurable)를 재정의한다. `import { Text } from 'react-native'`
 * 는 사용 시점에 이 getter 를 읽으므로, index.share.js 최상단에서 한 번 바꾸면 확장 번들 전체에 적용된다.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require('react-native');

function patch(name: 'Text' | 'TextInput') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Original: React.ComponentType<any> = RN[name];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Patched = forwardRef<unknown, any>((props, ref) => <Original {...props} ref={ref} allowFontScaling={false} />);
  Patched.displayName = Original.displayName ?? name;
  // TextInput.State 같은 정적 멤버 유지
  Object.assign(Patched, Original);
  Object.defineProperty(RN, name, { configurable: true, enumerable: true, get: () => Patched });
}

patch('Text');
patch('TextInput');
