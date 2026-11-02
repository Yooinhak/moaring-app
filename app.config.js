/**
 * 동적 Expo 설정 — app.json 을 기반으로 조건부 플러그인을 추가한다.
 *
 * 공유하기로 링크 받기:
 *   - Android: expo-share-intent + ShareSheetActivity(modules/share-sheet).
 *     SHARE_INTENT=1 npx expo prebuild -p android  (빌드 스크립트가 자동 포함)
 *   - iOS: expo-share-extension — Share Extension 안에서 RN 바텀시트(ShareApp)를 띄운다.
 *     App Group entitlement 가 필요해 Apple Developer Program(유료) 없이는 실기기 빌드가 깨진다.
 *     → IOS_SHARE_EXT=1 일 때만 타깃을 만든다. 멤버십 전에는 시뮬레이터 전용
 *       (bun run ios:sim:share). 실기기 ios:release 는 플래그 없이 기존과 동일.
 *   - Apple 멤버십 가입 후: IOS_SHARE_EXT 기본 활성화 + app.json 의
 *     usesAppleSignIn/expo-apple-authentication 복원 (_disabled_plugins_TODO 참고)
 */

const ENABLE_BY_DEFAULT = false; // Android expo-share-intent 기본 활성화 여부

// Android release 빌드를 업로드 키로 서명하도록 build.gradle 을 손보는 config plugin.
// (설정/키가 없으면 플러그인이 알아서 debug 키로 폴백 → 항상 안전하게 켜둬도 됨)
const withReleaseSigning = require('./plugins/withReleaseSigning');
// Android 공유 수신을 MainActivity → ShareSheetActivity(투명, modules/share-sheet)로 옮긴다.
// 앱 전환 없이 공유한 앱 위에 저장 시트만 뜨게 하는 핵심. expo-share-intent 뒤에 적용돼야 함.
const withShareSheet = require('./plugins/withShareSheet');
// Xcode 27: Pods 리소스 번들의 낮은 배포 타깃(9.0~13.4)이 빌드 에러 → 15.1 로 보정.
const withPodsDeploymentTarget = require('./plugins/withPodsDeploymentTarget');

module.exports = ({ config }) => {
  const enableShareIntent = ENABLE_BY_DEFAULT || process.env.SHARE_INTENT === '1';
  const enableIosShareExt = process.env.IOS_SHARE_EXT === '1';

  if (enableShareIntent) {
    config.plugins = [
      ...(config.plugins ?? []),
      // iOS 는 expo-share-extension 이 담당 — 둘 다 Share Extension 타깃을 만들면 충돌한다.
      ['expo-share-intent', { disableIOS: true, androidIntentFilters: ['text/*'] }],
    ];
  }

  if (enableIosShareExt) {
    // expo-share-extension 은 config.scheme 을 그대로 HostAppScheme(문자열)로 쓴다.
    // 배열이면 openHostApp 이 조용히 무시되므로 단일 문자열로 정규화.
    if (Array.isArray(config.scheme)) config.scheme = config.scheme[0];

    config.plugins = [
      ...(config.plugins ?? []),
      [
        'expo-share-extension',
        {
          activationRules: [{ type: 'url', max: 1 }, { type: 'text' }],
          // 투명 배경 — 공유한 앱 위에 바텀시트만 보이게 (Android 투명 Activity 와 동일)
          backgroundColor: { red: 0, green: 0, blue: 0, alpha: 0 },
          excludedPackages: ['expo-dev-client', 'expo-splash-screen', 'expo-share-intent'],
        },
      ],
    ];
  }

  return withPodsDeploymentTarget(withShareSheet(withReleaseSigning(config)));
};
