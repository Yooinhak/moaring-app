#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 모아링 iOS 시뮬레이터 빌드 — 공유 확장(IOS_SHARE_EXT=1) 포함
#
# 사용법:
#   bun run ios:sim:share                   # 빌드 → 설치 → 실행 (기본 Release: 번들 내장, Metro 불필요)
#   bun run ios:sim:share:prebuild          # app.config/플러그인/네이티브 모듈 바꿨을 때
#   CONFIG=Debug bun run ios:sim:share      # Debug — 다른 터미널에서 `npx expo start` 필요
#   SIM="iPhone Air" bun run ios:sim:share  # 시뮬레이터 기종 변경 (기본: iPhone 17 Pro)
#
# expo run:ios 를 쓰지 않는 이유: Xcode 27 에서 Simulator.app 이 사라져(DeviceHub 로 통합)
# Expo CLI 가 "Can't determine id of Simulator app" 으로 실패한다. xcodebuild + simctl 로 직접 처리.
#
# ⚠️ ios/ 가 확장 포함으로 재생성된다. 실기기 빌드로 돌아갈 땐 반드시
#    bun run ios:release:clean (무료 Personal Team 은 App Group 프로비저닝 불가)
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/check-env.js

export IOS_SHARE_EXT=1
MODE="${1:-run}" # run | prebuild
CONFIG="${CONFIG:-Release}"
SIM="${SIM:-iPhone 17 Pro}"
BUNDLE_ID="dev.inak.moaring"

if [[ "$MODE" == "prebuild" ]]; then
  echo "🧹 IOS_SHARE_EXT=1 prebuild --clean (ios/ 재생성)"
  npx expo prebuild -p ios --clean
  # build-ios-device.sh 와 동일 — --clean 이 지우는 소스 빌드 플래그 복구
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

UDID=$(xcrun simctl list devices available -j | node -e "
  const name = process.argv[1];
  const { devices } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const d = Object.values(devices).flat().find((x) => x.name === name);
  if (!d) { console.error('시뮬레이터 없음: ' + name); process.exit(1); }
  console.log(d.udid);
" "$SIM")

echo "📱 $SIM ($UDID) 부팅"
xcrun simctl boot "$UDID" 2>/dev/null || true # 이미 부팅돼 있으면 무시

# 번들에 들어갈 EXPO_PUBLIC_* 를 .env 에서 주입 (expo run:ios 가 하던 일)
set -a; source .env; set +a

echo "🔨 xcodebuild $CONFIG (iphonesimulator)"
xcodebuild -workspace ios/app.xcworkspace -scheme app -configuration "$CONFIG" \
  -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath ios/build build -quiet

APP="ios/build/Build/Products/$CONFIG-iphonesimulator/app.app"
echo "📦 설치 + 실행"
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" "$BUNDLE_ID"
open -a DeviceHub 2>/dev/null || true # 화면 보기 (Xcode 27)

echo "✅ 완료"
