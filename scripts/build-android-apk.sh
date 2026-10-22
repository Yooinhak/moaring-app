#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 모아링 Android Release APK 빌드 (친구 배포용)
#
# 사용법:
#   bun run android:apk              # 평소 (JS/스타일만 바꿨을 때)
#   bun run android:apk:prebuild     # app.json/아이콘/스플래시 바꿨을 때
#   bun run android:apk:clean        # applicationId/스킴 바꿨을 때
#
# 특징:
#   - prebuild 에 SHARE_INTENT=1 자동 포함 (누락 시 '공유하기로 받기' 소실 방지)
#   - Sentry 소스맵 업로드 기본 비활성 (auth token 없이 빌드 가능).
#     업로드하려면: SENTRY_UPLOAD=1 bun run android:apk
#   - 완료 시 APK 경로 출력 + Finder 에서 열기
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

# .env 누락 시 실행 즉시 죽는 빌드가 나오므로 먼저 막는다 (scripts/check-env.js 참고)
node scripts/check-env.js

MODE="${1:-run}" # run | prebuild | clean

if [[ "$MODE" == "clean" ]]; then
  echo "🧹 SHARE_INTENT=1 prebuild --clean (android/ 재생성)"
  SHARE_INTENT=1 npx expo prebuild -p android --clean
elif [[ "$MODE" == "prebuild" ]]; then
  echo "🔧 SHARE_INTENT=1 prebuild (설정 동기화)"
  SHARE_INTENT=1 npx expo prebuild -p android
fi

# ── Android SDK 위치 확보 ──────────────────────────────────────
# prebuild 가 android/ 를 재생성하면서 local.properties(=sdk.dir)를 지운다.
# 그래서 매 빌드마다 SDK 경로를 찾아 다시 주입한다 ("SDK location not found" 방지).
ANDROID_SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$ANDROID_SDK_DIR" ]]; then
  for cand in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/usr/local/share/android-sdk"; do
    if [[ -d "$cand" ]]; then ANDROID_SDK_DIR="$cand"; break; fi
  done
fi
if [[ -z "$ANDROID_SDK_DIR" || ! -d "$ANDROID_SDK_DIR" ]]; then
  echo "❌ Android SDK 를 찾지 못했어요."
  echo "   Android Studio 설치 시 보통 ~/Library/Android/sdk 에 있습니다."
  echo "   해결) 셸에 한 줄 추가 후 새 터미널:"
  echo "         echo 'export ANDROID_HOME=\$HOME/Library/Android/sdk' >> ~/.zshrc"
  echo "   또는) 이번만:  ANDROID_HOME=/경로/Android/sdk bun run android:apk:prebuild"
  exit 1
fi
if [[ ! -f android/local.properties ]] || ! grep -q '^sdk.dir=' android/local.properties 2>/dev/null; then
  echo "sdk.dir=$ANDROID_SDK_DIR" > android/local.properties
  echo "📝 android/local.properties 에 sdk.dir 설정: $ANDROID_SDK_DIR"
fi
export ANDROID_HOME="$ANDROID_SDK_DIR"

echo "🤖 Release APK 빌드"
if [[ "${SENTRY_UPLOAD:-}" == "1" ]]; then
  (cd android && ./gradlew assembleRelease)
else
  (cd android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease)
fi

APK="android/app/build/outputs/apk/release/app-release.apk"
echo ""
echo "✅ APK 완성: $APK ($(du -h "$APK" | cut -f1))"

# macOS 면 Finder 에서 위치 열기
if [[ "$(uname)" == "Darwin" ]]; then
  open -R "$APK"
fi
