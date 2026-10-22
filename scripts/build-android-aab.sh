#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 모아링 Android Release AAB 빌드 (Google Play 업로드용)
#
# 사용법:
#   bun run android:aab              # 평소 (JS/스타일만 바꿨을 때)
#   bun run android:aab:clean        # applicationId/스킴 바꿨을 때 (android/ 재생성)
#
# APK 스크립트와의 차이:
#   - assembleRelease 가 아니라 bundleRelease → .aab 산출물 (Play 는 AAB 만 받음)
#   - release 를 "업로드 키"로 서명 (plugins/withReleaseSigning.js 가 build.gradle 에 연결)
#   - 업로드 키 미설정 시 debug 키로 폴백되므로, 빌드 전에 설정 여부를 확인해 경고함
#
# 전제: 최초 1회 docs/android-signing-guide.md 대로
#   ① ~/keystores/moaring-upload.keystore 생성
#   ② ~/.gradle/gradle.properties 에 MOARING_UPLOAD_* 4줄 추가
#
# 특징:
#   - prebuild 에 SHARE_INTENT=1 자동 포함 (누락 시 '공유하기로 받기' 소실 방지)
#   - Sentry 소스맵 업로드 기본 비활성 (auth token 없이 빌드 가능).
#     업로드하려면: SENTRY_UPLOAD=1 bun run android:aab
#   - 완료 시 AAB 경로 출력 + Finder 에서 열기
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

# ── 업로드 키 설정 사전 점검 ──────────────────────────────────
# 없으면 build.gradle 이 debug 키로 폴백해 Play 에 못 올리는 AAB 가 나온다.
# (여기선 경고만; env/-P 로 넘길 수도 있으니 빌드는 막지 않는다.)
GRADLE_PROPS="$HOME/.gradle/gradle.properties"
if ! grep -q '^MOARING_UPLOAD_STORE_FILE=' "$GRADLE_PROPS" 2>/dev/null; then
  echo "⚠️  ~/.gradle/gradle.properties 에 MOARING_UPLOAD_* 설정이 안 보입니다."
  echo "    이대로 빌드하면 release 가 debug 키로 서명돼 Play 업로드가 불가합니다."
  echo "    설정 절차: docs/android-signing-guide.md (최초 1회)"
  echo ""
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
  echo "   또는) 이번만:  ANDROID_HOME=/경로/Android/sdk bun run android:aab:clean"
  exit 1
fi
if [[ ! -f android/local.properties ]] || ! grep -q '^sdk.dir=' android/local.properties 2>/dev/null; then
  echo "sdk.dir=$ANDROID_SDK_DIR" > android/local.properties
  echo "📝 android/local.properties 에 sdk.dir 설정: $ANDROID_SDK_DIR"
fi
export ANDROID_HOME="$ANDROID_SDK_DIR"

echo "📦 Release AAB 빌드 (bundleRelease)"
if [[ "${SENTRY_UPLOAD:-}" == "1" ]]; then
  (cd android && ./gradlew bundleRelease)
else
  (cd android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew bundleRelease)
fi

AAB="android/app/build/outputs/bundle/release/app-release.aab"
echo ""
echo "✅ AAB 완성: $AAB ($(du -h "$AAB" | cut -f1))"
echo "   Play Console → 새 버전 만들기 → 이 파일 업로드 (docs/android-signing-guide.md §4)"

# macOS 면 Finder 에서 위치 열기
if [[ "$(uname)" == "Darwin" ]]; then
  open -R "$AAB"
fi
