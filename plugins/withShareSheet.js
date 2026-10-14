/**
 * withShareSheet — Android 공유 수신을 MainActivity 에서 떼어내는 config plugin.
 *
 * 공유(ACTION_SEND)는 로컬 모듈 modules/share-sheet 의 ShareSheetActivity(투명) 가 받는다.
 * 그 Activity 선언은 모듈 AndroidManifest 가 매니페스트 병합으로 넣어주므로 여기선 건드리지 않는다.
 *
 * 이 플러그인이 하는 일은 하나: MainActivity 에 붙은 SEND intent-filter 제거.
 * expo-share-intent 플러그인(SHARE_INTENT=1)이 MainActivity 에 SEND 필터를 추가하는데,
 * 남겨두면 공유 대상 목록에 모아링이 두 번 뜨고, 그쪽을 고르면 예전처럼 앱으로 전환된다.
 * (iOS 쪽 expo-share-intent 설정에는 영향 없음)
 *
 * 반드시 expo-share-intent 플러그인보다 "나중에" 적용돼야 한다 → app.config.js 에서
 * 플러그인 배열이 아니라 함수 체인 마지막에 감싼다.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

function isSendFilter(filter) {
  return (filter.action ?? []).some((a) => a.$['android:name'] === 'android.intent.action.SEND');
}

module.exports = function withShareSheet(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    const main = app?.activity?.find((a) => a.$['android:name'] === '.MainActivity');
    if (main?.['intent-filter']) {
      main['intent-filter'] = main['intent-filter'].filter((f) => !isSendFilter(f));
    }
    return cfg;
  });
};
