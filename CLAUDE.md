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
