---
name: improve-scan
description: 모아링 주간 개선 후보 스캔. 코드·UX·경쟁 앱을 훑어 근거 있는 개선 후보 3~5개를 점수 매겨 docs/improve/YYYY-MM-DD-candidates.md 로 쓰고 BACKLOG 에 추가한 뒤 develop 대상 PR 을 연다. "개선 후보 찾아줘", "improve scan", 주간 스케줄 실행 때 사용. 인자 --no-pr 이면 PR 없이 로컬 커밋까지만.
---

# improve-scan

앱 코드는 절대 수정하지 않는다. 빌드하지 않는다. 산출물은 문서 2개(후보 문서, BACKLOG)뿐이다.

## 1. 준비
1. 작업 트리 확인: `git status --porcelain` 출력이 `supabase/.temp/` 외에 비어 있어야 한다. 아니면 멈추고 사용자에게 알린다.
2. `git fetch origin && git switch develop && git pull --ff-only` (클라우드면 이미 develop 체크아웃 상태일 수 있음 — 그 경우 생략).
3. 이전 스캔 미처리 확인: `gh` 가 동작하면 오직 열린 PR 로만 판정한다 — `gh pr list --base develop --state open --json headRefName --jq '.[].headRefName' | grep -E '^improve/'` 에 한 줄이라도 나오면 아무것도 하지 않고 "이전 스캔 PR 미처리 — 먼저 고르거나 닫아 주세요" 보고 후 종료. 스캔 PR 뿐 아니라 `-signals` PR 도 의도적으로 막는다 (신호 PR 의 BACKLOG 행도 ID 가 겹칠 수 있다). `gh` 를 쓸 수 없거나 인증이 안 된 경우에만 git 확인으로 대체한다: 접미사 유무와 관계없이 `origin/improve/*` 중 `git merge-base --is-ancestor <브랜치> origin/develop` 가 실패하는 것이 있으면 같은 보고 후 종료하고, 스쿼시 머지·닫힌 PR 의 남은 브랜치는 오탐 중단을 일으킬 수 있으니 오래된 `improve/*` 브랜치를 삭제하라고 보고에 덧붙인다.
4. 날짜 `D=$(TZ=Asia/Seoul date +%F)`. 먼저 로컬 `git rev-parse --verify --quiet improve/$D` 와 원격 `git ls-remote --exit-code --heads origin improve/$D` 를 둘 다 확인. 하나라도 존재하면 아무것도 커밋·푸시하지 않고 종료, "이번 주 스캔 이미 있음" 보고. 둘 다 없으면 develop 에서 `git switch -c improve/$D`.
5. `docs/improve/BACKLOG.md` 읽기. 모든 행의 제목·메모를 "제외 목록"으로 기억. 마지막 ID 번호 확인.

## 2. 코드·UX 스캔 (출처 = 파일:줄)
- 화면 흐름: `src/screens/*.tsx`, `src/components/sheets/*.tsx` 를 읽고 빈 상태, 로딩, 에러 처리, 되돌리기 불가 동작, 접근성(라벨·터치 영역) 빈틈 찾기.
- `grep -rn "TODO\|FIXME" src modules supabase/functions`.
- `bun install --frozen-lockfile` 후 `bun run lint` 경고 수집 (lint 는 .env 불필요). lint 가 경고로 exit 1 해도 "lint 실행" 으로 치고 경고 수를 기록한다. 설치나 lint 를 아예 실행할 수 없을 때만 건너뛰고 문서 "스캔 범위"에 "lint 미실행" 표기.
- 파일:줄 은 `grep -n` 결과나 실제로 읽은 줄 번호만 쓴다. 어림짐작 금지.
- `git log --since="4 weeks ago" --oneline` 로 최근 변경 영역 — 막 만든 기능의 마감 손질 거리 찾기.
- (있으면) `docs/superpowers/HANDOFF-*.md` 의 "남은 일", "미해결" 류 항목.

## 3. 경쟁 앱·시장 (출처 = URL)
- 웹 검색으로 링크 저장·북마크·공유 컬렉션 앱 3~5개 (예: Raindrop.io, Pocket 대체 앱, 국내 링크 모음 앱) 의 기능과 스토어 리뷰 불만 조사. 앱마다 검색 스니펫만 보지 말고 최소 한 페이지는 직접 읽는다. 3곳 미만이면 실제 조사한 수를 "스캔 범위"에 적는다. 후보는 코드 출처만으로도 가능하다.
- 모아링에 없고 "그룹으로 함께 모으기" 정체성에 맞는 것만 후보로. 인용은 15단어 이하.

## 4. 후보 선정
- 후보마다 영향·노력·위험 1~5 매기고 `점수 = 영향×2 − 노력 − 위험`.
- 제외: 출처 없음, BACKLOG 제외 목록과 같은 취지, 3일 초과(쪼갤 수 있으면 첫 조각만 제안).
- 상위 3~5개. 새 후보 0개면 `git switch develop && git branch -D improve/$D`, 아무것도 커밋·푸시하지 않고 PR 도 없이 "새 후보 없음" 보고 후 종료.
- ID 는 BACKLOG 마지막 번호 + 1 부터.

## 5. 후보 문서 작성
경로 `docs/improve/$D-candidates.md`, 형식:

```markdown
# 개선 후보 — YYYY-MM-DD

스캔 범위: 코드(커밋 <short-sha>), 경쟁 앱 N곳(실제 조사한 수). lint: 실행/미실행.

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

## 스캔 메모 (선택)
- 실행 못 한 단계, 제외한 후보와 이유 등.

## 신호
(로컬에서 /improve-signals 로 채움)
```

`## 신호` 는 항상 문서 맨 끝에 둔다 (improve-signals 가 이 섹션부터 끝까지 교체). 스캔 메모는 그 앞에.

## 6. BACKLOG 갱신
표 끝에 후보마다 `| I-NNN | <제목> | open | $D #<번호> | |` 추가. `#<번호>` 는 후보 문서 안의 후보 번호(PR 번호 아님). 기존 행은 건드리지 않는다.

## 7. 커밋·PR
```bash
git add docs/improve/
git commit -m "chore. $D 개선 후보 스캔"
```
- 인자 `--no-pr` 이면 여기서 끝.
- 아니면 PR 본문을 저장소 밖 임시 파일 `${TMPDIR:-/tmp}/improve-$D-pr-body.md` 에 실제 줄바꿈으로 쓴다 (요약 표 그대로 + 빈 줄 + "고를 항목을 PR 코멘트로 남기거나 로컬에서 BACKLOG 상태를 picked 로 바꾸세요."). 그 뒤:
  `git push -u origin improve/$D`
  `gh pr create --base develop --title "chore. $D 개선 후보" --body-file "${TMPDIR:-/tmp}/improve-$D-pr-body.md"`
- `git push` 나 `gh pr create` 가 실패하면 재시도하지 말고, 실패 내용과 브랜치명·비교 URL `https://github.com/Yooinhak/moaring-app/compare/develop...improve/$D` 를 보고한다.
- PR 본문·커밋에 Co-Authored-By 넣지 않음.

## 8. 보고
후보 요약 표 + PR 링크. 실행 못 한 단계(lint, 웹 검색 등)는 그대로 밝힌다.
