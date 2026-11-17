#!/usr/bin/env bash
# PreToolUse(Edit|Write) 훅 — 비밀 파일 편집을 막는다.
# 입력: stdin JSON (tool_input.file_path). 차단 시 exit 2 + stderr 이유.
set -u
path=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[[ -z "$path" ]] && exit 0

name=$(basename "$path")
case "$name" in
  .env.example) exit 0 ;;
  .env|.env.*|*.keystore|*.jks|*.p8|*.p12)
    echo "차단: 비밀 파일($name)은 Claude 가 편집하지 않습니다. 필요하면 사용자가 직접 수정하세요." >&2
    exit 2 ;;
esac
exit 0
