#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 모아링 iOS 실기기 Release 빌드
#
# 사용법:
#   bun run ios:release              # 평소 (JS/스타일만 바꿨을 때)
#   bun run ios:release:prebuild     # app.json/아이콘/스플래시 바꿨을 때
#   bun run ios:release:clean        # 번들ID/스킴/프로젝트명 바꿨을 때
#
#   기기명 바꾸려면: DEVICE="다른 iPhone" bun run ios:release
#
# Sentry 소스맵·디버그 심볼 업로드는 기본 비활성 (auth token 없이 빌드 가능, Android 스크립트와 동일).
#   업로드하려면: SENTRY_UPLOAD=1 bun run ios:release
#
# --clean 시 ios/Podfile.properties.json 의 buildReactNativeFromSource 키가
# 날아가는 문제(→ "No script URL" 재발)를 자동으로 복구한다. (research.md 참고)
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

# .env 누락 시 실행 즉시 죽는 빌드가 나오므로 먼저 막는다 (scripts/check-env.js 참고)
node scripts/check-env.js

DEVICE="${DEVICE:-유인학의 iPhone}"
MODE="${1:-run}" # run | prebuild | clean

if [[ "$MODE" == "clean" ]]; then
  echo "🧹 prebuild --clean (ios/ 재생성)"
  npx expo prebuild -p ios --clean
elif [[ "$MODE" == "prebuild" ]]; then
  echo "🔧 prebuild (설정 동기화)"
  npx expo prebuild -p ios
fi

if [[ "$MODE" == "clean" || "$MODE" == "prebuild" ]]; then
  # ⚠️ 필수: 프리빌트 RN 코어에는 dev 심볼(RCTPackagerConnection)이 빠져 있어
  # 소스 빌드 강제가 필요하다. --clean 이 이 키를 지우므로 항상 재주입한다.
  echo "🩹 Podfile.properties.json 에 buildReactNativeFromSource 복구"
  node -e "
    const fs = require('fs');
    const f = 'ios/Podfile.properties.json';
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j['ios.buildReactNativeFromSource'] = 'true';
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  "
  npx pod-install
fi

# Xcode 의 Sentry 빌드 단계(소스맵·dSYM 업로드)는 토큰이 없으면 빌드를 실패시킨다
if [[ "${SENTRY_UPLOAD:-}" != "1" ]]; then
  export SENTRY_DISABLE_AUTO_UPLOAD=true
fi

# expo run:ios 는 Simulator.app 이 없으면 실기기 빌드도 막는다 (Xcode 27 은 Simulator.app 미포함).
# 그래서 xcodebuild 로 빌드하고 devicectl 로 설치·실행한다.
DEVICE_ID="$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | node -e "
  const out = require('fs').readFileSync(0, 'utf8');
  const devs = JSON.parse(out.slice(out.indexOf('{'))).result.devices;
  const d = devs.find((d) => d.deviceProperties?.name === process.argv[1] && d.hardwareProperties?.reality === 'physical');
  if (d) console.log(d.hardwareProperties.udid);
" "$DEVICE")"
if [[ -z "$DEVICE_ID" ]]; then
  echo "❌ \"$DEVICE\" 기기를 못 찾았어요. 연결/페어링 확인: xcrun devicectl list devices"
  exit 1
fi

# 번들 단계가 EXPO_PUBLIC_* 를 읽도록 .env 를 환경에 올린다
set -a; . ./.env; set +a

echo "📱 Release 빌드 → \"$DEVICE\" ($DEVICE_ID)"
xcodebuild -workspace ios/app.xcworkspace -scheme app -configuration Release \
  -destination "id=$DEVICE_ID" -derivedDataPath ios/build -allowProvisioningUpdates \
  build | (command -v xcbeautify >/dev/null && xcbeautify || cat)

APP=ios/build/Build/Products/Release-iphoneos/app.app
echo "📲 설치"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" || echo "⚠️  자동 실행 실패 — 폰에서 직접 여세요 (잠금 상태일 수 있음)"

echo "✅ 완료! 아이콘이 예전 것으로 보이면 폰에서 앱 삭제 후 재설치 (런처 캐시)."
