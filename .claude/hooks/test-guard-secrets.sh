#!/usr/bin/env bash
# guard-secrets.sh 테스트 — 비밀 파일은 exit 2, 그 외는 exit 0 이어야 한다.
set -u
HOOK="$(dirname "$0")/guard-secrets.sh"
fail=0

check() { # $1=경로 $2=기대 exit
  local out code
  out=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1" | bash "$HOOK" 2>&1)
  code=$?
  if [[ "$code" == "$2" ]]; then echo "ok   $1 -> $code"; else echo "FAIL $1 -> $code (기대 $2) $out"; fail=1; fi
}

check "/repo/.env" 2
check "/repo/.env.production" 2
check "/repo/android/app/release.jks" 2
check "/Users/me/keystores/moaring-upload.keystore" 2
check "/repo/AuthKey_ABC.p8" 2
check "/repo/cert.p12" 2
check "/repo/.env.example" 0
check "/repo/src/screens/HomeScreen.tsx" 0
check "/repo/docs/environment.md" 0

# file_path 없는 입력은 통과
code=$(printf '{"tool_name":"Write","tool_input":{}}' | bash "$HOOK" >/dev/null 2>&1; echo $?)
[[ "$code" == 0 ]] && echo "ok   (no path) -> 0" || { echo "FAIL (no path) -> $code"; fail=1; }

exit $fail
