#!/usr/bin/env bash
# guard-secrets.sh 테스트 — 비밀 파일은 exit 2, 그 외는 exit 0 이어야 한다.
# 깨진 입력·jq 부재는 fail-closed(exit 2).
set -u
HOOK="$(dirname "$0")/guard-secrets.sh"
fail=0

report() { # $1=라벨 $2=실제 $3=기대 $4=출력
  if [[ "$2" == "$3" ]]; then echo "ok   $1 -> $2"; else echo "FAIL $1 -> $2 (기대 $3) $4"; fail=1; fi
}

check() { # $1=경로 $2=기대 exit
  local out code
  out=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1" | bash "$HOOK" 2>&1)
  code=$?
  report "$1" "$code" "$2" "$out"
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

# 대소문자 무시
check "/repo/.ENV" 2
check "/repo/KEY.P12" 2
check "/repo/.ENV.EXAMPLE" 0

# file_path 없는 입력은 통과
code=$(printf '{"tool_name":"Write","tool_input":{}}' | bash "$HOOK" >/dev/null 2>&1; echo $?)
report "(no path)" "$code" 0 ""

# NotebookEdit 은 notebook_path 키를 쓴다
out=$(printf '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"/repo/.env"}}' | bash "$HOOK" 2>&1)
code=$?
report "(notebook_path .env)" "$code" 2 "$out"

# 깨진 stdin 은 fail-closed
out=$(printf 'not json' | bash "$HOOK" 2>&1)
code=$?
report "(malformed stdin)" "$code" 2 "$out"

# jq 부재 시 fail-closed (PATH 에서 jq 를 숨긴다)
out=$(printf '{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts"}}' | env PATH=/nonexistent /bin/bash "$HOOK" 2>&1)
code=$?
report "(jq missing)" "$code" 2 "$out"

exit $fail
