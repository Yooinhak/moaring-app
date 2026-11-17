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
- (있으면) `research.md`, `docs/superpowers/HANDOFF-*.md` 의 "남은 일", "미해결" 류 항목.

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
