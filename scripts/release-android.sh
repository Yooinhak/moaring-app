#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 모아링 Android 원커맨드 릴리스
#   버전 세팅 → APK(release) 빌드 → 구글 드라이브 자동 업로드
#
# 사용법:
#   bun run release:android 0.0.3               # 기본: clean prebuild + 빌드 + 업로드
#   MODE=prebuild bun run release:android 0.0.3 # 빠르게(네이티브 설정만 동기화)
#   MODE=run      bun run release:android 0.0.3 # 네이티브 재생성 없이 빌드만(버전코드 반영 안 됨)
#
# 최초 1회 준비:
#   1) Android SDK (Android Studio)  → 보통 ~/Library/Android/sdk
#   2) rclone + 구글 드라이브 remote:  brew install rclone && rclone config
#      (remote 이름은 아래 DRIVE_REMOTE 와 동일해야 함, 기본 'gdrive')
#
# 조절용 환경변수(선택):
#   DRIVE_REMOTE=gdrive     # rclone remote 이름 (기본 gdrive)
#   DRIVE_DIR="찌낙이"       # 업로드할 드라이브 폴더 (기본 '찌낙이', 없으면 자동 생성)
#   DRIVE_LABEL="찌낙이"     # 출력에 표시할 계정 라벨
#   MODE=clean|prebuild|run # 빌드 모드 (기본 clean)
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

# .env 누락 시 실행 즉시 죽는 빌드가 나오므로 먼저 막는다 (scripts/check-env.js 참고)
node scripts/check-env.js

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "❌ 버전을 넘겨주세요.  예:  bun run release:android 0.0.3"
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ 버전 형식이 MAJOR.MINOR.PATCH 가 아니에요:  $VERSION"
  exit 1
fi

MODE="${MODE:-clean}"
DRIVE_REMOTE="${DRIVE_REMOTE:-gdrive}"
DRIVE_DIR="${DRIVE_DIR:-찌낙이}"       # 기본: 구글 드라이브의 '찌낙이' 폴더
DRIVE_LABEL="${DRIVE_LABEL:-찌낙이}"
APP_NAME="모아링"

# versionCode = MAJOR*10000 + MINOR*100 + PATCH  (0.0.2 → 2, 0.1.0 → 100, 1.0.0 → 10000)
IFS='.' read -r MJ MN PT <<< "$VERSION"
VERSION_CODE=$(( 10#$MJ * 10000 + 10#$MN * 100 + 10#$PT ))

# ── Android SDK 위치 확보 ──────────────────────────────────────
ANDROID_SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$ANDROID_SDK_DIR" ]]; then
  for cand in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/usr/local/share/android-sdk"; do
    [[ -d "$cand" ]] && { ANDROID_SDK_DIR="$cand"; break; }
  done
fi
if [[ -z "$ANDROID_SDK_DIR" || ! -d "$ANDROID_SDK_DIR" ]]; then
  echo "❌ Android SDK 를 찾지 못했어요. ANDROID_HOME 을 설정해주세요."
  echo "   예)  echo 'export ANDROID_HOME=\$HOME/Library/Android/sdk' >> ~/.zshrc"
  exit 1
fi
export ANDROID_HOME="$ANDROID_SDK_DIR"
echo "🤖 Android SDK: $ANDROID_SDK_DIR"

# ── 버전 반영 (app.json · package.json · 프로필 표시) ──────────
# JSON 전체 재직렬화는 손으로 맞춘 포맷(scheme 배열 등)을 흐트러뜨리므로,
# 필요한 필드만 외과적으로 치환한다(포맷 보존 → 깔끔한 diff).
CUR=$(node -p "require('./app.json').expo.version" 2>/dev/null || echo '?')
echo "🔖 버전: $CUR → $VERSION   (versionCode → $VERSION_CODE)"
perl -0pi -e 's/("version":\s*)"[0-9]+\.[0-9]+\.[0-9]+"/${1}"'"$VERSION"'"/' app.json package.json
if grep -q '"versionCode"' app.json; then
  perl -0pi -e 's/("versionCode":\s*)[0-9]+/${1}'"$VERSION_CODE"'/' app.json
else
  # android.package 뒤에 versionCode 추가 (6-스페이스 들여쓰기 유지)
  perl -0pi -e 's/("package":\s*"dev\.inak\.moaring")/$1,\n      "versionCode": '"$VERSION_CODE"'/' app.json
fi
if [[ -f src/screens/ProfileScreen.tsx ]]; then
  perl -0pi -e 's/모아링 v[0-9]+\.[0-9]+\.[0-9]+/모아링 v'"$VERSION"'/g' src/screens/ProfileScreen.tsx
fi

# ── 네이티브 준비 ──────────────────────────────────────────────
echo "🏗️  빌드 모드: $MODE"
if [[ "$MODE" == "clean" ]]; then
  echo "🧹 SHARE_INTENT=1 prebuild --clean (android/ 재생성)"
  SHARE_INTENT=1 npx expo prebuild -p android --clean
elif [[ "$MODE" == "prebuild" ]]; then
  echo "🔧 SHARE_INTENT=1 prebuild (설정 동기화)"
  SHARE_INTENT=1 npx expo prebuild -p android
fi

# prebuild 가 android/local.properties(sdk.dir)를 지우므로 재주입
if [[ ! -f android/local.properties ]] || ! grep -q '^sdk.dir=' android/local.properties 2>/dev/null; then
  echo "sdk.dir=$ANDROID_SDK_DIR" > android/local.properties
fi

# ── Release APK 빌드 ──────────────────────────────────────────
echo "🤖 Release APK 빌드"
(cd android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease)

APK="android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || { echo "❌ APK 를 못 찾았어요: $APK"; exit 1; }
echo "✅ APK 완성: $APK ($(du -h "$APK" | cut -f1 | tr -d ' '))"

# ── 구글 드라이브 업로드 (rclone) ─────────────────────────────
DEST_NAME="${APP_NAME}_${VERSION}.apk"
LABEL_SUFFIX=""
[[ -n "$DRIVE_LABEL" ]] && LABEL_SUFFIX="($DRIVE_LABEL)"
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q "^${DRIVE_REMOTE}:"; then
  echo "☁️  Google Drive${LABEL_SUFFIX} 업로드: $DEST_NAME"
  rclone copyto "$APK" "${DRIVE_REMOTE}:${DRIVE_DIR}/${DEST_NAME}" -P
  echo "✅ 업로드 완료: $DEST_NAME (v$VERSION, versionCode $VERSION_CODE)"
else
  echo "⚠️  rclone remote '${DRIVE_REMOTE}' 를 못 찾아 업로드는 건너뜁니다."
  echo "    설정)  brew install rclone && rclone config   → Google Drive, 이름 '${DRIVE_REMOTE}'"
  echo "    APK 는 로컬에 있어요:  $APK"
fi

echo "🎉 릴리스 v$VERSION 완료!"
echo "   (버전 파일이 바뀌었어요 — 커밋하려면:  git add app.json package.json src/screens/ProfileScreen.tsx && git commit -m \"chore. $VERSION 릴리스\")"
if [[ "$(uname)" == "Darwin" ]]; then open -R "$APK" 2>/dev/null || true; fi
