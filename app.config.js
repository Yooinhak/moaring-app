/**
 * 동적 Expo 설정 — app.json 을 기반으로 조건부 플러그인을 추가한다.
 *
 * expo-share-intent (공유하기로 링크 받기):
 *   - Android: 멤버십 불필요 → 기본 활성화 대상.
 *   - iOS: Share Extension + App Groups entitlement 가 필요해
 *     Apple Developer Program(유료) 없이는 빌드가 깨진다.
 *
 * 사용법:
 *   - Android 프리빌드/실행:  SHARE_INTENT=1 npx expo prebuild -p android
 *                             SHARE_INTENT=1 npx expo run:android
 *   - iOS (멤버십 없는 동안):  플래그 없이 그대로 → 플러그인 미적용, 기존과 동일
 *   - Apple 멤버십 가입 후:    아래 ENABLE_BY_DEFAULT 를 true 로 바꾸고
 *                             app.json 의 usesAppleSignIn/expo-apple-authentication 도
 *                             함께 복원 (_disabled_plugins_TODO 참고)
 */

const ENABLE_BY_DEFAULT = false; // Apple Developer 멤버십 가입 후 true 로

// Android release 빌드를 업로드 키로 서명하도록 build.gradle 을 손보는 config plugin.
// (설정/키가 없으면 플러그인이 알아서 debug 키로 폴백 → 항상 안전하게 켜둬도 됨)
const withReleaseSigning = require('./plugins/withReleaseSigning');
// Android 공유 수신을 MainActivity → ShareSheetActivity(투명, modules/share-sheet)로 옮긴다.
// 앱 전환 없이 공유한 앱 위에 저장 시트만 뜨게 하는 핵심. expo-share-intent 뒤에 적용돼야 함.
const withShareSheet = require('./plugins/withShareSheet');

module.exports = ({ config }) => {
  const enableShareIntent = ENABLE_BY_DEFAULT || process.env.SHARE_INTENT === '1';

  if (enableShareIntent) {
    config.plugins = [
      ...(config.plugins ?? []),
      [
        'expo-share-intent',
        {
          iosActivationRules: {
            NSExtensionActivationSupportsWebURLWithMaxCount: 1,
            NSExtensionActivationSupportsText: true,
          },
          androidIntentFilters: ['text/*'],
        },
      ],
    ];
  }

  return withShareSheet(withReleaseSigning(config));
};
