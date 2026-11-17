# 개선 사이클 하네스 설계 (Claude Code)

- 날짜: 2026-11-17
- 상태: 설계 승인됨 → 구현 계획 대기
- 범위: moaring-app 저장소에서 "무엇을 개선할지 찾기 → 설계 → 구현 → 검증 → 출시" 를 주기적으로 매끄럽게 돌리는 Claude Code 작업 틀

## 1. 목표와 비목표

**목표**
- 매주 자동으로 개선 후보 3~5개(각 1~3일 규모)가 근거와 함께 제안된다.
- 사용자는 두 번만 개입한다: ① 후보 고르기 ② PR 머지.
- 그 사이(설계·계획·구현·검증)는 기존 superpowers 흐름을 그대로 쓴다.
- 결정 이력(채택·보류·거절과 이유)이 저장소에 남아 같은 제안이 반복되지 않는다.
- 저장소 규칙(언어, 커밋 형식, 릴리스 정책, 검증 명령)이 한 곳(`CLAUDE.md`)에 있어 어느 세션이든 같은 방식으로 일한다.

**비목표 (이번 범위 밖, BACKLOG 에 후보로 등록)**
- Jest 단위 테스트, Maestro E2E 도입
- iOS 릴리스 스킬 (Apple 멤버십 가입 후)
- 클라우드에서의 앱 코드 수정·빌드
- 자동 포맷 훅

## 2. 접근

superpowers 플러그인을 설계→계획→구현→마무리 엔진으로 그대로 쓰고, 그 위에 얇은 저장소 전용 층만 추가한다.
(대안: 자체 `/cycle` 스킬 일체형 — superpowers 와 중복·유지보수 부담 / GitHub Issues+Actions — API 키·CI 필요, 1인 프로젝트에 과함. 둘 다 기각.)

## 3. 파일 구성

```
CLAUDE.md                              저장소 규칙 (한국어, ~60줄)
.claude/
  settings.json                        공유 권한·훅 (비밀값 금지)
  hooks/guard-secrets.sh               비밀 파일 편집 차단 훅
  skills/
    improve-scan/SKILL.md              코드·UX·경쟁 앱 스캔 → 후보 문서 + BACKLOG 갱신
    improve-signals/SKILL.md           (로컬 전용) Play Console·Sentry 신호 → 후보 문서에 추가
    release-android/SKILL.md           버전 올림 → AAB → 서명 검증 → Play 업로드 체크리스트
docs/improve/
  BACKLOG.md                           단일 누적 목록
  YYYY-MM-DD-candidates.md             스캔 1회당 1개
docs/superpowers/{specs,plans}/        superpowers 산출물 (기존 위치 유지)
.github/PULL_REQUEST_TEMPLATE.md       검증 체크리스트
```

### 3.1 CLAUDE.md 내용
- 응답 언어: 한국어.
- 커밋 형식: `feat. 한국어 설명` / `fix.` / `chore.` / `test.` — Co-Authored-By 트레일러 넣지 않음.
- 브랜치: `develop` 기준, 작업은 `feature/<slug>`, 스캔은 `improve/YYYY-MM-DD`, PR 대상은 `develop`.
- 비밀: `.env*`, 키스토어, `~/.gradle/gradle.properties` 의 `MOARING_UPLOAD_*` 는 읽지도 커밋하지도 않음.
- Expo 패키지는 `npx expo install` 로만 추가.
- 검증 명령: `bunx tsc --noEmit -p .`, `bun run lint`, `bun test supabase/functions/link-preview`.
- 시뮬레이터 검증 절차: AXe (`axe touch -x -y --down --up --delay 0.15`, 드래그는 `axe drag ... --pre-delay 0.15`, 텍스트는 `simctl pbcopy` + 붙여넣기).
- 빌드 명령표: README 의 `ios:release*`, `android:apk*`, `android:aab*`.
- 릴리스 정책: Play 업로드·게시는 사용자 확인 후에만. 프로덕션은 단계별 출시(기본 20%)로 시작.
- 사이클 흐름 요약 (§4) 과 각 스킬 이름.

## 4. 사이클 흐름

```
[매주 월 09:00 KST, 클라우드]  /improve-scan
   → docs/improve/YYYY-MM-DD-candidates.md + BACKLOG.md 갱신
   → 브랜치 improve/YYYY-MM-DD 커밋 → develop 대상 PR
[로컬, 선택]  /improve-signals → 같은 문서에 "신호" 섹션 추가
[사용자]  후보 1개 선택 → BACKLOG 상태 picked            ← 게이트 ①
superpowers:brainstorming → spec (검증 섹션 필수)
superpowers:writing-plans → plan
superpowers:executing-plans → feature/<slug> 에서 구현
검증: tsc + lint + 관련 bun test + spec 검증 섹션의 시뮬레이터 체크
superpowers:finishing-a-development-branch → develop 대상 PR   ← 게이트 ②
BACKLOG 상태 done + PR 링크
(여러 개 모이면) /release-android
```

원칙
- 게이트 사이에서는 설계 승인 1회 외에 멈추지 않는다.
- 모든 spec 에 "검증" 섹션(화면·조작·기대 결과)을 둔다 — RN 자동 테스트 부재를 대신한다.
- 클라우드 실행은 문서·PR 만 만든다. 앱 코드 수정, 빌드, 외부 콘솔 접근 없음.
- 스캔은 BACKLOG 를 먼저 읽고 done·rejected·parked 와 같은 제안을 하지 않는다.

## 5. 후보 문서와 BACKLOG

### 5.1 후보 문서 형식
```markdown
# 개선 후보 — YYYY-MM-DD

## 요약
| # | ID | 제목 | 종류 | 영향 | 노력 | 위험 | 점수 |

## <#>. <제목> (I-NNN)
- 종류: 기능 / UX / 버그 / 성능 / 기술부채
- 근거: 출처 필수 (파일:줄, 경쟁 앱 이름과 URL, 리뷰 인용 15단어 이하)
- 제안: 2~4줄
- 규모: 1~3일, 건드릴 파일
- 검증 아이디어: 시뮬레이터에서 확인할 것
- 위험·의존: DB 마이그레이션, 플랫폼 차이 등

## 신호 (/improve-signals)
- Play Console: 비정상 종료·ANR·새 리뷰
- Sentry: 상위 이슈
```

### 5.2 점수
`점수 = 영향×2 − 노력 − 위험` (각 1~5). 출처 없는 후보는 제외. 회당 3~5개. 3일 초과 작업은 쪼개서 제안.

### 5.3 BACKLOG.md
```markdown
| ID | 제목 | 상태 | 출처 | 링크·메모 |
```
- 상태: `open` / `picked` / `done` / `rejected` / `parked`.
- ID 는 `I-NNN` 일련번호, 스캔이 마지막 번호 다음부터 부여.
- rejected·parked 는 한 줄 이유 필수.
- 초기 항목: 토스트 상단 겹침(iOS 공유 확장), iOS 공유 확장 develop 병합, Supabase 개발/운영 DB 분리, Google·Kakao 네이티브 로그인, Jest 도입, Maestro 도입.

## 6. 스킬 세부

### 6.1 improve-scan
입력: 저장소, `docs/improve/BACKLOG.md`, 최근 `git log` 4주, 웹 검색.
절차:
1. BACKLOG 읽기 → 제외 목록.
2. 코드·UX 스캔: 화면 흐름(`src/screens`, `src/components/sheets`), 빈 상태·에러 처리, TODO/FIXME, `bun run lint` 경고, 최근 변경 영역.
3. 경쟁 앱·시장: 링크 저장·북마크 앱 3~5개의 기능과 스토어 리뷰 불만 (웹 검색, 출처 URL 기록).
4. 후보 정리·점수·상위 3~5개 선택 → 후보 문서 작성, BACKLOG 에 open 으로 추가.
5. 브랜치 `improve/YYYY-MM-DD` 커밋, `develop` 대상 PR 생성 (gh).
산출물이 없으면(새 후보 0개) PR 대신 BACKLOG 변경 없이 종료.

### 6.2 improve-signals (로컬 전용)
Chrome 확장으로 Play Console(Android vitals 비정상 종료·ANR, 평점·리뷰)과 Sentry 이슈 목록을 읽고, 가장 최근 후보 문서의 "신호" 섹션에 추가. 신호에서 새 후보가 나오면 BACKLOG 에 open 으로 추가. 콘솔에서는 읽기만 한다.

### 6.3 release-android
1. `app.json` version·versionCode, `package.json` version, `ProfileScreen` 표시 버전 올림 → `chore. X.Y.Z 릴리스 — 버전·versionCode N 반영`.
2. `bash scripts/build-android-aab.sh prebuild` (로그는 scratchpad).
3. 검증: `android/app/build.gradle` versionCode, `keytool -printcert -jarfile` 로 debug 키 아님 확인.
4. 출시 노트 초안 (ko-KR, BACKLOG done 항목 기반) 제시.
5. Play 업로드·트랙·비율은 사용자 확인 후 진행. 기본: 프로덕션 단계별 20%.

## 7. 클라우드 스케줄
- `/schedule` 로 등록: 매주 월 09:00 KST, 저장소 `Yooinhak/moaring-app`, 기준 브랜치 `develop`, 프롬프트 = `/improve-scan` 실행.
- 클라우드 환경에는 `.env` 없음 → Supabase·Play·Sentry 접근 없음 (의도된 제한).
- 실패 시 PR 없음, 재시도 없음 (다음 주 실행).
- 전제: 클라우드 에이전트의 GitHub 저장소 접근 권한. 등록 시 확인.

## 8. .gitignore 와 설정

### 8.1 .gitignore
```gitignore
.claude/*
!.claude/settings.json
!.claude/skills/
!.claude/hooks/
*.md
!README.md
!CLAUDE.md
!docs/**/*.md
!.github/**/*.md
```
`settings.local.json` 은 계속 무시. 이후 `docs` 문서는 `git add -f` 불필요.

### 8.2 .claude/settings.json
- allow: `Bash(bunx tsc --noEmit*)`, `Bash(bun run lint*)`, `Bash(bun run format*)`, `Bash(bun test*)`, `Bash(git status*)`, `Bash(git diff*)`, `Bash(git log*)`, `Bash(git branch*)`, `Bash(axe *)`, `Bash(xcrun simctl *)`
- deny: `Read(./.env*)`, `Edit(./.env*)`, `Bash(supabase db reset*)`, `Bash(git push --force*)`
- PreToolUse 훅 (matcher `Edit|Write`): `.claude/hooks/guard-secrets.sh` — 대상 경로가 `.env*`, `*.keystore`, `*.jks`, `*.p8`, `*.p12` 이면 exit 2 로 차단하고 이유 출력.
- 비밀값(토큰·키)은 이 파일에 넣지 않는다.

## 9. 검증 (이 하네스 자체)
1. `git check-ignore` 로 `CLAUDE.md`, `.claude/settings.json`, `.claude/skills/improve-scan/SKILL.md`, `docs/improve/BACKLOG.md` 가 무시되지 않고 `.claude/settings.local.json`, `.env` 는 무시됨을 확인.
2. 훅: `.env` 대상 Write 시도 → 차단 메시지, 일반 파일 Write → 통과. 스크립트에 샘플 JSON 을 stdin 으로 넣어 exit code 확인.
3. `/improve-scan` 로컬 1회 실행 → 후보 문서 형식(§5.1)·점수·출처 존재, BACKLOG 에 open 추가, PR 생성(드라이런은 PR 생략 옵션).
4. `/improve-signals` 로컬 1회 → 신호 섹션 추가.
5. `/schedule` 등록 후 수동 1회 트리거 → PR 생성 확인.
6. `release-android` 는 실제 업로드 전 단계(버전·빌드·서명 검증)까지 v0.0.8 로 확인.

## 10. 보안 메모 (범위 밖 권장)
`~/.claude/settings.json` 의 `env.GH_TOKEN` 에 GitHub 토큰이 평문으로 있다. 저장소에는 없지만 세션 기록에 노출됐으므로 폐기 후 `gh auth login`(키체인) 전환 권장.
