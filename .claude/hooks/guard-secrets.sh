#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit|NotebookEdit) 훅 — 비밀 파일 편집을 막는다.
# 입력: stdin JSON (tool_input.file_path 또는 notebook_path). 차단 시 exit 2 + stderr 이유.
# fail-closed: jq 부재·깨진 JSON 은 검사 불가이므로 차단한다.
set -u
block() { echo "차단: $1" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || block "jq 가 없어 비밀 파일 검사를 할 수 없습니다."

input=$(cat)
[[ -z "$input" ]] && exit 0

path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null) \
  || block "입력 JSON 을 해석할 수 없어 비밀 파일 검사를 할 수 없습니다."
[[ -z "$path" ]] && exit 0

name=${path##*/}
lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
case "$lower" in
  .env.example) exit 0 ;;
  .env|.env.*|*.keystore|*.jks|*.p8|*.p12)
    block "비밀 파일($name)은 Claude 가 편집하지 않습니다. 필요하면 사용자가 직접 수정하세요." ;;
esac
exit 0
