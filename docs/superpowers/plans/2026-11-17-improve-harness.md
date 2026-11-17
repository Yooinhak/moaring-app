# 개선 사이클 하네스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** moaring-app 저장소에 "주간 개선 후보 스캔 → 선택 → superpowers 설계·구현 → 검증 → 출시" 사이클을 돌리는 Claude Code 하네스(CLAUDE.md, 공유 설정·훅, 저장소 스킬 3개, BACKLOG, PR 템플릿, 주간 클라우드 스케줄)를 만든다.

**Architecture:** superpowers 플러그인이 설계→계획→구현→마무리를 담당하고, 이 저장소에는 얇은 층만 추가한다. 스킬은 `.claude/skills/<name>/SKILL.md` 마크다운 지시문이고, 상태는 `docs/improve/BACKLOG.md` 표 하나에 누적된다. 주간 실행은 `/schedule` 클라우드 에이전트가 `improve-scan` 을 돌려 PR 로 결과를 낸다.

**Tech Stack:** Claude Code (skills, hooks, settings.json), bash + jq, gh CLI, git.

Spec: `docs/superpowers/specs/2026-11-17-improve-harness-design.md`

## Global Constraints

- 응답·문서 언어: 한국어.
- 커밋 형식: `feat. …` / `fix. …` / `chore. …` / `test. …` (한국어 설명). **Co-Authored-By 트레일러 넣지 않음.**
- 브랜치: 작업 `feature/improve-harness` (develop 기준), 스캔 산출물 `improve/YYYY-MM-DD`, PR 대상 `develop`.
- `.env*`, `*.keystore`, `*.jks`, `*.p8`, `*.p12` 는 읽기·편집·커밋 금지.
- `.claude/settings.json` 에 토큰·키 등 비밀값 금지.
- 점수 = 영향×2 − 노력 − 위험 (각 1~5). 회당 후보 3~5개, 각 1~3일 규모, 출처 없는 후보 제외.
- BACKLOG 상태값: `open` / `picked` / `done` / `rejected` / `parked`. ID 형식 `I-NNN`.
- 클라우드 실행은 문서·PR 만. 앱 코드 수정·빌드·외부 콘솔 접근 없음.
- Play 업로드·게시는 사용자 확인 후에만. 프로덕션 기본 단계별 20%.

## File Structure

| 파일 | 책임 |
|---|---|
| `.gitignore` (수정) | 하네스 파일·docs 마크다운을 추적 대상으로 |
| `CLAUDE.md` | 저장소 규칙·명령·사이클 요약 (모든 세션 공통 컨텍스트) |
| `.claude/settings.json` | 공유 권한 allow/deny, PreToolUse 훅 등록 |
| `.claude/hooks/guard-secrets.sh` | Edit/Write 대상이 비밀 파일이면 차단 |
| `.claude/hooks/test-guard-secrets.sh` | 훅 스크립트 자체 테스트 |
| `docs/improve/BACKLOG.md` | 개선 항목 누적 표 (단일 진실 원천) |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 검증 체크리스트 |
| `.claude/skills/improve-scan/SKILL.md` | 코드·UX·경쟁 앱 스캔 → 후보 문서 + BACKLOG + PR |
| `.claude/skills/improve-signals/SKILL.md` | 로컬: Play Console·Sentry 신호 → 후보 문서 |
| `.claude/skills/release-android/SKILL.md` | 버전 올림 → AAB → 서명 검증 → 업로드 체크리스트 |

---

### Task 1: .gitignore 정리 + CLAUDE.md

**Files:**
- Modify: `.gitignore:51-54`
- Create: `CLAUDE.md`

**Interfaces:**
- Produces: `CLAUDE.md` 의 섹션 이름 "개선 사이클" — 이후 스킬들이 이 흐름을 참조.

- [ ] **Step 1: 현재 무시 상태 확인 (실패 기대)**

```bash
cd /Users/yuinhag/git-inhak/moaring-app
mkdir -p .claude/skills/x .claude/hooks docs/improve .github
touch .claude/settings.json .claude/settings.local.json .claude/skills/x/SKILL.md .claude/hooks/a.sh docs/improve/BACKLOG.md .github/PULL_REQUEST_TEMPLATE.md
for f in CLAUDE.md .claude/settings.json .claude/skills/x/SKILL.md .claude/hooks/a.sh docs/improve/BACKLOG.md .github/PULL_REQUEST_TEMPLATE.md; do git check-ignore -q "$f" && echo "IGNORED $f" || echo "tracked $f"; done
```
Expected: 전부 `IGNORED`.

- [ ] **Step 2: .gitignore 수정**

`.gitignore` 에서 다음 4줄

```gitignore
.claude
.claude/
!README.md
*.md
```

을 아래로 교체:

```gitignore
# Claude Code — 공유 하네스만 추적, 개인 설정(settings.local.json 등)은 무시
.claude/*
!.claude/settings.json
!.claude/skills/
!.claude/hooks/

# 마크다운 — 기본 무시, 문서·하네스는 추적
*.md
!README.md
!CLAUDE.md
!.claude/**/*.md
!docs/**/*.md
!.github/**/*.md
```

- [ ] **Step 3: 다시 확인 (통과 기대)**

```bash
for f in CLAUDE.md .claude/settings.json .claude/skills/x/SKILL.md .claude/hooks/a.sh docs/improve/BACKLOG.md .github/PULL_REQUEST_TEMPLATE.md; do git check-ignore -q "$f" && echo "IGNORED $f" || echo "tracked $f"; done
for f in .claude/settings.local.json .env node_modules/x.md; do git check-ignore -q "$f" && echo "IGNORED $f" || echo "tracked $f"; done
rm -rf .claude/skills/x .claude/hooks/a.sh .claude/settings.local.json
rm -f .claude/settings.json docs/improve/BACKLOG.md .github/PULL_REQUEST_TEMPLATE.md
```
Expected: 첫 루프 전부 `tracked`, 둘째 루프 전부 `IGNORED`.
(`.claude/settings.local.json` 이 원래 있었다면 지우지 말 것 — Step 1 전에 `ls .claude` 로 확인하고 원래 없던 것만 정리.)

- [ ] **Step 4: CLAUDE.md 작성**

```markdown
# 모아링 (moaring-app) — Claude Code 작업 규칙

## 기본
- 응답은 한국어.
- 패키지 매니저 bun. Expo 관련 패키지는 반드시 `npx expo install` (bun add 금지 — SDK 비호환 버전이 조용히 들어감).
- 스택: Expo SDK 55, RN 0.83, Supabase(Auth·Postgres RLS·Edge Functions), React Query v5. 상세는 README.md, research.md.

## 커밋·브랜치
- 커밋 메시지: `feat. 한국어 설명` / `fix. …` / `chore. …` / `test. …`
- Co-Authored-By 트레일러 넣지 않음.
- 기준 브랜치 `develop`. 작업 `feature/<slug>`, 주간 스캔 `improve/YYYY-MM-DD`. PR 대상은 `develop`, 릴리스 때 `develop → main`.

## 비밀
- `.env*`, `*.keystore`, `*.jks`, `*.p8`, `*.p12`, `~/.gradle/gradle.properties` 의 `MOARING_UPLOAD_*` 는 읽지도 수정·커밋하지도 않는다 (훅이 편집을 막음).
- `.claude/settings.json` 에 토큰·키를 넣지 않는다.

## 검증 명령
- 타입: `bunx tsc --noEmit -p .`
- 린트: `bun run lint` (경고 0 목표)
- Edge Function 테스트: `bun test supabase/functions/link-preview`
- RN 자동 테스트는 아직 없다 → spec 의 "검증" 섹션에 적은 시뮬레이터 체크로 대신한다.

## 시뮬레이터 검증 (iOS, AXe)
- 시뮬레이터: iPhone 17 Pro (iOS 26.5). Xcode 27 에 Simulator.app 없음 → `xcrun simctl` + AXe.
- 탭: `axe touch -x <x> -y <y> --down --up --delay 0.15 --udid <UDID>` (`axe tap` 은 안 먹힘)
- 스와이프·시트 닫기: `axe drag ... --pre-delay 0.15`
- 텍스트 입력: `xcrun simctl pbcopy <UDID>` 후 붙여넣기 메뉴 (`axe type` 안 먹힘)
- 화면 구조: `axe describe-ui --udid <UDID>`

## 빌드
| 상황 | iOS 실기기 | Android APK | Play 업로드용 AAB |
|---|---|---|---|
| JS만 | `bun run ios:release` | `bun run android:apk` | `bun run android:aab` |
| app.json·아이콘 | `bun run ios:release:prebuild` | `bun run android:apk:prebuild` | `bash scripts/build-android-aab.sh prebuild` |
| 번들ID·스킴 | `bun run ios:release:clean` | `bun run android:apk:clean` | `bun run android:aab:clean` |
- iOS 공유 확장은 Apple 유료 멤버십 전까지 시뮬레이터 전용.

## 릴리스 정책
- Play Console 업로드·게시는 사용자 확인 후에만.
- 프로덕션은 단계별 출시 20% 로 시작, 비정상 종료 없으면 확대.
- 절차: `/release-android` 스킬.

## 개선 사이클
1. 매주 월 09:00 KST 클라우드가 `/improve-scan` 실행 → `docs/improve/YYYY-MM-DD-candidates.md` + `docs/improve/BACKLOG.md` 갱신 → `develop` 대상 PR.
2. (선택, 로컬) `/improve-signals` → Play Console·Sentry 신호를 같은 문서에 추가.
3. 사용자가 후보 1개 선택 → BACKLOG 상태 `picked`. ← 게이트 ①
4. `superpowers:brainstorming` → spec (`docs/superpowers/specs/`, **"검증" 섹션 필수**: 화면·조작·기대 결과).
5. `superpowers:writing-plans` → plan (`docs/superpowers/plans/`).
6. `superpowers:executing-plans` 또는 `subagent-driven-development` → `feature/<slug>` 에서 구현.
7. 검증: tsc + lint + 관련 bun test + spec 검증 섹션 시뮬레이터 체크.
8. `superpowers:finishing-a-development-branch` → `develop` 대상 PR. ← 게이트 ②
9. 머지 후 BACKLOG 상태 `done` + PR 링크.
10. done 항목이 쌓이면 `/release-android`.

BACKLOG 상태값: `open` / `picked` / `done` / `rejected` / `parked` (rejected·parked 는 한 줄 이유 필수).
```

- [ ] **Step 5: 커밋**

```bash
git add .gitignore CLAUDE.md
git commit -m "chore. 하네스 파일·docs 마크다운 추적 + CLAUDE.md 작업 규칙"
```

---

### Task 2: 공유 설정 + 비밀 파일 차단 훅

**Files:**
- Create: `.claude/hooks/guard-secrets.sh`
- Create: `.claude/hooks/test-guard-secrets.sh`
- Create: `.claude/settings.json`

**Interfaces:**
- Consumes: Claude Code PreToolUse 훅 입력 — stdin JSON `{"tool_name":"Edit","tool_input":{"file_path":"/abs/path"}}`.
- Produces: exit 0 = 허용, exit 2 = 차단(stderr 메시지가 Claude 에게 전달).

- [ ] **Step 1: 테스트 스크립트 작성**

`.claude/hooks/test-guard-secrets.sh`:

```bash
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
```

- [ ] **Step 2: 실패 확인**

Run: `bash .claude/hooks/test-guard-secrets.sh`
Expected: `guard-secrets.sh` 가 없어 FAIL 다수, exit 1.

- [ ] **Step 3: 훅 구현**

`.claude/hooks/guard-secrets.sh`:

```bash
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
```

```bash
chmod +x .claude/hooks/guard-secrets.sh .claude/hooks/test-guard-secrets.sh
```

- [ ] **Step 4: 통과 확인**

Run: `bash .claude/hooks/test-guard-secrets.sh`
Expected: 모든 줄 `ok`, exit 0.

- [ ] **Step 5: settings.json 작성**

`.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(bunx tsc --noEmit*)",
      "Bash(bun run lint*)",
      "Bash(bun run format*)",
      "Bash(bun test*)",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git branch*)",
      "Bash(axe *)",
      "Bash(xcrun simctl *)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Edit(./.env)",
      "Edit(./.env.*)",
      "Bash(supabase db reset*)",
      "Bash(git push --force*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secrets.sh\""
          }
        ]
      }
    ]
  }
}
```

검증: `jq . .claude/settings.json >/dev/null && echo valid` → `valid`.
주의: `Read(./.env.*)` 가 `.env.example` 읽기도 막는다 — 의도된 보수적 선택(예시 파일은 `cat` 대신 사용자가 보여주면 됨). 막히면 BACKLOG 에 parked 로 메모.

- [ ] **Step 6: 커밋**

```bash
git add .claude/settings.json .claude/hooks/guard-secrets.sh .claude/hooks/test-guard-secrets.sh
git commit -m "chore. Claude 공유 권한 설정 + 비밀 파일 편집 차단 훅"
```

- [ ] **Step 7: 실제 훅 동작 확인 (새 세션 필요)**

훅은 세션 시작 시 로드된다. 다음 세션에서 Claude 에게 "`.env.test-guard` 파일을 Write 로 만들어줘" 요청 → 차단 메시지가 나오면 통과. 결과를 Task 7 보고에 포함.

---

### Task 3: BACKLOG + PR 템플릿

**Files:**
- Create: `docs/improve/BACKLOG.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Produces: BACKLOG 표 열 `| ID | 제목 | 상태 | 출처 | 링크·메모 |`, 마지막 ID `I-006` — improve-scan 이 다음 번호(`I-007`)부터 부여.

- [ ] **Step 1: BACKLOG.md 작성**

```markdown
# 개선 BACKLOG

모든 개선 항목의 단일 목록. `/improve-scan` 이 새 후보를 `open` 으로 추가하고, 이미 있는 항목(특히 done·rejected·parked)은 다시 제안하지 않는다.

- 상태: `open` 제안됨 / `picked` 진행 중 / `done` 머지됨 / `rejected` 안 함 / `parked` 나중에
- rejected·parked 는 "링크·메모"에 한 줄 이유 필수.
- ID 는 `I-NNN` 일련번호. 새 항목은 마지막 번호 + 1.
- 출처: 후보 문서 날짜와 번호(`2026-11-24 #2`) 또는 `수동`.

| ID | 제목 | 상태 | 출처 | 링크·메모 |
|----|------|------|------|-----------|
| I-001 | iOS 공유 확장 토스트가 상태바와 겹침 (상단 inset) | open | 수동 | docs/superpowers/specs/2026-11-01-ios-share-extension-spike.md E2E 3번 |
| I-002 | feature/ios-share-extension 을 develop 에 병합 + Android 로그인 유지 회귀 확인 | open | 수동 | 세션 저장소 이동으로 기존 사용자 1회 로그아웃 가능성 |
| I-003 | Supabase 개발/운영 프로젝트 분리 + .env 분리 + 릴리스 빌드 운영 값 강제 | open | 수동 | 현재 프로젝트 yvhyjx… 를 운영으로 유지 |
| I-004 | Google·Kakao 네이티브 로그인 (signInWithIdToken) — 로그인 화면 supabase.co 도메인 노출 제거 | open | 수동 | I-003 과 OAuth 클라이언트 설정 겹침 |
| I-005 | Jest(jest-expo) 단위 테스트 도입 | parked | 수동 | 하네스 1차 범위 밖 |
| I-006 | Maestro E2E 도입 | parked | 수동 | 하네스 1차 범위 밖, 빌드 시간 부담 |
```

- [ ] **Step 2: PR 템플릿 작성**

`.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## 무엇을 / 왜
<!-- BACKLOG ID (예: I-007) 와 한두 줄 요약 -->

## 관련 문서
- spec:
- plan:

## 검증
- [ ] `bunx tsc --noEmit -p .`
- [ ] `bun run lint`
- [ ] 관련 `bun test` (해당 시)
- [ ] spec "검증" 섹션 시뮬레이터/실기기 체크 — 결과:
- [ ] DB 마이그레이션 있음 → 적용 순서 기재 / 없음

## 머지 후
- [ ] BACKLOG 상태 `done` + 이 PR 링크
```

- [ ] **Step 3: 커밋**

```bash
git add docs/improve/BACKLOG.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "chore. 개선 BACKLOG 초기 항목 + PR 검증 템플릿"
```

---

### Task 4: improve-scan 스킬

**Files:**
- Create: `.claude/skills/improve-scan/SKILL.md`

**Interfaces:**
- Consumes: `docs/improve/BACKLOG.md` (Task 3 형식).
- Produces: `docs/improve/YYYY-MM-DD-candidates.md` (아래 형식), BACKLOG 새 `open` 행, 브랜치 `improve/YYYY-MM-DD`, develop 대상 PR. improve-signals 가 "## 신호" 섹션을 찾아 채운다.

- [ ] **Step 1: SKILL.md 작성**

````markdown
---
name: improve-scan
description: 모아링 주간 개선 후보 스캔. 코드·UX·경쟁 앱을 훑어 근거 있는 개선 후보 3~5개를 점수 매겨 docs/improve/YYYY-MM-DD-candidates.md 로 쓰고 BACKLOG 에 추가한 뒤 develop 대상 PR 을 연다. "개선 후보 찾아줘", "improve scan", 주간 스케줄 실행 때 사용. 인자 --no-pr 이면 PR 없이 로컬 커밋까지만.
---

# improve-scan

앱 코드는 절대 수정하지 않는다. 빌드하지 않는다. 산출물은 문서 2개(후보 문서, BACKLOG)뿐이다.

## 1. 준비
1. `git fetch origin && git switch develop && git pull --ff-only` (클라우드면 이미 develop 체크아웃 상태일 수 있음 — 그 경우 생략).
2. 날짜 `D=$(TZ=Asia/Seoul date +%F)`. 브랜치 `improve/$D` 생성. 이미 있으면 종료하고 "이번 주 스캔 이미 있음" 보고.
3. `docs/improve/BACKLOG.md` 읽기. 모든 행의 제목·메모를 "제외 목록"으로 기억. 마지막 ID 번호 확인.

## 2. 코드·UX 스캔 (출처 = 파일:줄)
- 화면 흐름: `src/screens/*.tsx`, `src/components/sheets/*.tsx` 를 읽고 빈 상태, 로딩, 에러 처리, 되돌리기 불가 동작, 접근성(라벨·터치 영역) 빈틈 찾기.
- `grep -rn "TODO\|FIXME" src modules supabase/functions`.
- `bun install --frozen-lockfile` 가능하면 `bun run lint` 경고 수집 (실패하면 건너뛰고 문서에 "lint 미실행" 표기).
- `git log --since="4 weeks ago" --oneline` 로 최근 변경 영역 — 막 만든 기능의 마감 손질 거리 찾기.
- `research.md`, `docs/superpowers/HANDOFF-*.md` 의 "남은 일", "미해결" 류 항목.

## 3. 경쟁 앱·시장 (출처 = URL)
- 웹 검색으로 링크 저장·북마크·공유 컬렉션 앱 3~5개 (예: Raindrop.io, Pocket 대체 앱, 국내 링크 모음 앱) 의 기능과 스토어 리뷰 불만 조사.
- 모아링에 없고 "그룹으로 함께 모으기" 정체성에 맞는 것만 후보로. 인용은 15단어 이하.

## 4. 후보 선정
- 후보마다 영향·노력·위험 1~5 매기고 `점수 = 영향×2 − 노력 − 위험`.
- 제외: 출처 없음, BACKLOG 제외 목록과 같은 취지, 3일 초과(쪼갤 수 있으면 첫 조각만 제안).
- 상위 3~5개. 새 후보 0개면 브랜치 삭제하고 "새 후보 없음" 보고 후 종료.
- ID 는 BACKLOG 마지막 번호 + 1 부터.

## 5. 후보 문서 작성
경로 `docs/improve/$D-candidates.md`, 형식:

```markdown
# 개선 후보 — YYYY-MM-DD

스캔 범위: 코드(커밋 <short-sha>), 경쟁 앱 N곳. lint: 실행/미실행.

## 요약
| # | ID | 제목 | 종류 | 영향 | 노력 | 위험 | 점수 |
|---|----|------|------|------|------|------|------|

## 1. <제목> (I-NNN)
- 종류: 기능 / UX / 버그 / 성능 / 기술부채
- 근거: <파일:줄 / URL / 인용>
- 제안: <2~4줄>
- 규모: <1~3일>, 건드릴 파일: <목록>
- 검증 아이디어: <시뮬레이터에서 확인할 것>
- 위험·의존: <DB 마이그레이션, 플랫폼 차이, 다른 BACKLOG 항목>

## 신호
(로컬에서 /improve-signals 로 채움)
```

## 6. BACKLOG 갱신
표 끝에 후보마다 `| I-NNN | <제목> | open | $D #<번호> | |` 추가. 기존 행은 건드리지 않는다.

## 7. 커밋·PR
```bash
git add docs/improve/
git commit -m "chore. $D 개선 후보 스캔"
```
- 인자 `--no-pr` 이면 여기서 끝.
- 아니면 `git push -u origin improve/$D` 후
  `gh pr create --base develop --title "chore. $D 개선 후보" --body "<요약 표 그대로> \n\n고를 항목을 PR 코멘트로 남기거나 로컬에서 BACKLOG 상태를 picked 로 바꾸세요."`
- PR 본문·커밋에 Co-Authored-By 넣지 않음.

## 8. 보고
후보 요약 표 + PR 링크. 실행 못 한 단계(lint, 웹 검색 등)는 그대로 밝힌다.
````

- [ ] **Step 2: 로컬 드라이런**

새 Claude 세션(스킬 로드 위해)에서 `/improve-scan --no-pr` 실행.
확인:
- `docs/improve/<오늘>-candidates.md` 존재, 요약 표 3~5행, 각 후보에 근거(파일:줄 또는 URL) 있음.
- BACKLOG 에 `I-007` 부터 open 행 추가, 기존 6행 그대로.
- `git diff develop --stat` 에 `docs/improve/` 외 파일 없음.
- 문제 있으면 SKILL.md 수정 후 재실행.

- [ ] **Step 3: 드라이런 산출물 정리 + 스킬 커밋**

드라이런 브랜치(`improve/<오늘>`)는 그대로 두고 사용자에게 보여준 뒤, 작업 브랜치로 돌아와 스킬만 커밋:

```bash
git switch feature/improve-harness
git add .claude/skills/improve-scan/SKILL.md
git commit -m "feat. improve-scan 스킬 — 주간 개선 후보 스캔·BACKLOG·PR"
```

---

### Task 5: improve-signals 스킬

**Files:**
- Create: `.claude/skills/improve-signals/SKILL.md`

**Interfaces:**
- Consumes: 최신 `docs/improve/*-candidates.md` 의 `## 신호` 섹션, BACKLOG.
- Produces: 신호 섹션 내용, 필요 시 BACKLOG 새 open 행.

- [ ] **Step 1: SKILL.md 작성**

````markdown
---
name: improve-signals
description: (로컬 전용) Play Console 의 비정상 종료·ANR·리뷰와 Sentry 이슈를 Chrome 으로 읽어 가장 최근 개선 후보 문서의 "신호" 섹션을 채우고, 새 문제는 BACKLOG 에 추가한다. "신호 확인", "크래시 리뷰 확인", "improve signals" 때 사용.
---

# improve-signals

콘솔에서는 **읽기만** 한다. 답글, 설정 변경, 업로드 금지.

## 1. 대상 문서
`ls docs/improve/*-candidates.md | sort | tail -1` → 대상. 없으면 "후보 문서 없음 — /improve-scan 먼저" 보고 후 종료.
그 문서가 들어 있는 브랜치(`improve/<날짜>`)로 전환. 없으면 현재 브랜치에서 진행.

## 2. Play Console (claude-in-chrome)
- 앱: 개발자 ID 6624764485354368879, 앱 ID 4973385565926299060.
- 새 탭에서 열기 (기존 탭 재사용 금지). 스크린샷이 멈추면 read_page·find·javascript_tool 로 텍스트 읽기.
- 읽을 곳:
  - Android vitals → 비정상 종료·ANR: 최근 28일 비율, 상위 클러스터 3개(예외 이름, 첫 스택 프레임, 영향 사용자 수).
  - 평점 및 리뷰: 최근 4주 리뷰 별점·요약(인용 15단어 이하).
  - 사전 출시 보고서가 있으면 경고 요약.

## 3. Sentry
- 브라우저로 Sentry 프로젝트(moaring) 이슈 목록, 최근 14일 이벤트 수 상위 3개: 제목, 이벤트 수, 사용자 수, 첫 발생 릴리스.
- 접근 안 되면 "Sentry 미확인" 으로 기록.

## 4. 기록
대상 문서 `## 신호` 섹션을 다음으로 교체:

```markdown
## 신호 (YYYY-MM-DD 확인)
### Play Console
- 비정상 종료율 x.x% / ANR x.x% (28일)
- 상위 비정상 종료: <예외> @ <프레임> — 사용자 N명
- 리뷰: <별점 분포>, 주요 불만 "<15단어 이하 인용>"
### Sentry
- <이슈 제목> — 이벤트 N, 사용자 N, 릴리스 x.y.z
```

신호 중 기존 후보·BACKLOG 에 없는 실제 문제(재현 가능한 크래시, 반복 불만)는 BACKLOG 에 `| I-NNN | <제목> | open | 신호 YYYY-MM-DD | <근거> |` 로 추가.

## 5. 커밋
```bash
git add docs/improve/
git commit -m "chore. YYYY-MM-DD 개선 신호 (Play Console·Sentry)"
```
푸시는 사용자에게 물어본 뒤.
````

- [ ] **Step 2: 로컬 실행 확인**

새 세션에서 `/improve-signals` 실행 (Task 4 드라이런 문서 대상).
확인: 신호 섹션 채워짐, Play Console 수치에 출처 화면 이름 포함, 콘솔에서 아무것도 변경하지 않음.

- [ ] **Step 3: 커밋**

```bash
git switch feature/improve-harness
git add .claude/skills/improve-signals/SKILL.md
git commit -m "feat. improve-signals 스킬 — Play Console·Sentry 신호 수집"
```

---

### Task 6: release-android 스킬

**Files:**
- Create: `.claude/skills/release-android/SKILL.md`

**Interfaces:**
- Consumes: `app.json`(`expo.version`, `expo.android.versionCode`), `package.json`(`version`), `src/screens/ProfileScreen.tsx`(`모아링 vX.Y.Z` 문자열), `scripts/build-android-aab.sh`, BACKLOG done 항목.
- Produces: 버전 커밋, `dist/모아링_X.Y.Z.aab`, 출시 노트 초안.

- [ ] **Step 1: SKILL.md 작성**

````markdown
---
name: release-android
description: 모아링 Android 릴리스. 버전·versionCode 올림 → 서명된 AAB 빌드 → 서명·버전 검증 → 출시 노트 초안 → (사용자 확인 후) Play Console 업로드·단계별 출시. "안드로이드 출시", "릴리스", "AAB 빌드" 때 사용. 인자로 새 버전(예: 0.0.9) 을 받을 수 있음.
---

# release-android

Play Console 업로드·게시는 **사용자가 문구·트랙·비율을 확인한 뒤에만** 한다.

## 1. 사전 확인
- 현재 브랜치 `develop`, 작업 트리 깨끗(`git status --porcelain` 비어 있음, `supabase/.temp/` 제외).
- `bunx tsc --noEmit -p .` 와 `bun run lint` 통과.
- 현재 버전: `jq -r '.expo.version, .expo.android.versionCode' app.json`.
- Play Console 에 이미 올라간 최고 versionCode 보다 커야 한다 (모르면 사용자에게 확인).

## 2. 버전 올림
새 버전 V(인자 또는 patch+1), 새 versionCode N(현재+1):
```bash
jq --arg v "$V" --argjson n "$N" '.expo.version=$v | .expo.android.versionCode=$n' app.json > app.json.tmp && mv app.json.tmp app.json
jq --arg v "$V" '.version=$v' package.json > package.json.tmp && mv package.json.tmp package.json
sed -i '' "s/모아링 v[0-9.]*/모아링 v$V/" src/screens/ProfileScreen.tsx
git diff --stat   # 3 files
git add app.json package.json src/screens/ProfileScreen.tsx
git commit -m "chore. $V 릴리스 — 버전·versionCode $N 반영"
```
(이미 올려둔 상태면 이 단계 생략.)
주의: `jq` 가 app.json 들여쓰기를 2칸으로 다시 쓴다 — 기존과 같으면 diff 는 두 줄뿐이어야 한다. 더 바뀌면 되돌리고 sed 로 두 줄만 수정.

## 3. AAB 빌드
로그는 scratchpad 에:
```bash
bash scripts/build-android-aab.sh prebuild > <scratchpad>/aab.log 2>&1; echo EXIT $?
tail -5 <scratchpad>/aab.log
```
백그라운드 실행 권장 (20분 이상). 실패 시 `grep -n "What went wrong" -A5` 만 보고.

## 4. 검증
```bash
AAB=android/app/build/outputs/bundle/release/app-release.aab
grep -n "versionCode\|versionName" android/app/build.gradle | head -2     # N, "V"
keytool -printcert -jarfile $AAB | grep SHA256                            # 업로드 키 지문
keytool -printcert -jarfile $AAB | grep -ci "android debug"               # 0 이어야 함
ls -la "dist/모아링_$V.aab"
```
debug 키면 중단하고 `docs/android-signing-guide.md` 안내.

## 5. 출시 노트 초안
- `git log <이전 태그 또는 이전 릴리스 커밋>..HEAD --oneline` 과 BACKLOG `done` 항목에서 사용자 체감 변화만 골라 3~5줄.
- 형식:
```
<ko-KR>
- …
</ko-KR>
```
- 500자 이내. 내부 용어(마이그레이션, 리팩터) 금지.

## 6. 사용자 확인 → 업로드
사용자에게 제시: AAB 경로, versionCode, 서명 지문, 출시 노트, 트랙(기본 프로덕션), 비율(기본 20%).
확인을 받으면 claude-in-chrome 으로 Play Console → 프로덕션 → 새 버전 만들기 → AAB 업로드(file_upload) → 출시 노트 입력 → 단계별 출시 비율 입력 → 검토 화면까지.
**"출시 시작" 직전 요약을 다시 보여주고 명시적 확인을 받은 뒤 클릭.**

## 7. 마무리
- `git tag v$V && git push origin develop --tags` (사용자 확인 후).
- `develop → main` PR 생성 여부 사용자에게 확인.
- 보고: 게시 상태, 비율, 다음 확대 시점(2~3일 후 비정상 종료율 확인).
````

- [ ] **Step 2: 업로드 직전까지 확인 (v0.0.8)**

새 세션에서 `/release-android` 실행 — 이미 0.0.8 로 올라가 있으므로 2단계 생략 확인, 3~5단계 수행, 6단계에서 사용자 확인 질문이 나오면 **업로드하지 않고 멈춤**.
주의: I-003(DB 분리) 이후 운영 값으로 다시 빌드해야 하므로 이번 AAB 는 업로드용이 아님.

- [ ] **Step 3: 커밋**

```bash
git add .claude/skills/release-android/SKILL.md
git commit -m "feat. release-android 스킬 — 버전·AAB·서명 검증·Play 업로드 절차"
```

---

### Task 7: 푸시 + PR + 주간 클라우드 스케줄

**Files:** 없음 (원격 작업)

**Interfaces:**
- Consumes: Task 1~6 커밋, `improve-scan` 스킬.

- [ ] **Step 1: develop 선행 커밋 확인 후 푸시**

`feature/improve-harness` 는 develop 의 미푸시 커밋 `dccced6`(0.0.8 버전) 위에 있다. 사용자 확인 후:
```bash
git push origin develop
git push -u origin feature/improve-harness
```

- [ ] **Step 2: PR 생성**

```bash
gh pr create --base develop --head feature/improve-harness \
  --title "chore. 개선 사이클 하네스 (CLAUDE.md·스킬 3종·BACKLOG·훅)" \
  --body-file .github/PULL_REQUEST_TEMPLATE.md
```
본문의 검증 칸에 Task 2 테스트, Task 4·5 드라이런, Task 6 업로드 직전 확인 결과를 채운다.

- [ ] **점검 (Step 3 전)**
  - (a) 클라우드 루틴에서 `improve/*` 브랜치 푸시 허용(unrestricted branch pushes) 확인.
  - (b) 수동 트리거에서 `command -v jq gh` 와 `gh auth status` 확인 — jq 없으면 루틴 설정 단계에서 설치(훅은 jq 없으면 모든 쓰기를 막음). 로컬도 `gh auth status` 확인 — 현재 로컬 gh 는 401 Bad credentials → `gh auth login` 필요.
  - (c) develop 의 0.0.8 버전 커밋(dccced6)을 먼저 푸시하거나 PR 본문에 포함 사실을 적기.
  - (d) 로컬 `improve/2026-11-17-dryrun` 브랜치 삭제(푸시 금지).
  - (e) GitHub 저장소 설정 "Automatically delete head branches" 켜기, 오래된 `improve/*` 브랜치 정리.

- [ ] **Step 3: 머지 후 스케줄 등록**

스케줄은 develop 의 스킬을 읽으므로 PR 머지 후에 등록. `/schedule` 스킬로:
- 이름: `moaring 주간 개선 스캔`
- 주기: 매주 월요일 09:00 Asia/Seoul (cron `0 0 * * 1` UTC)
- 저장소: `Yooinhak/moaring-app`, 브랜치 `develop`
- 프롬프트: `/improve-scan 을 실행해. 저장소 CLAUDE.md 규칙을 따른다.`
- 등록 시 GitHub 접근 권한 확인.

- [ ] **Step 4: 수동 1회 트리거**

스케줄 즉시 실행 → `improve/<오늘>` PR 이 열리는지 확인 (로컬 드라이런 브랜치와 날짜가 겹치면 로컬 브랜치를 먼저 지우거나 다음 날 실행).

- [ ] **Step 5: 메모리 갱신**

프로젝트 메모리에 "개선 사이클 하네스 도입 (2026-11-17), 주간 스캔 월 09:00, BACKLOG 위치" 기록.
