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

echo "📱 Release 빌드 → \"$DEVICE\""
npx expo run:ios --device "$DEVICE" --configuration Release

echo "✅ 완료! 아이콘이 예전 것으로 보이면 폰에서 앱 삭제 후 재설치 (런처 캐시)."
