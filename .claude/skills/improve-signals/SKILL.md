---
name: improve-signals
description: (로컬 전용) Play Console 의 비정상 종료·ANR·리뷰와 Sentry 이슈를 Chrome 으로 읽어 가장 최근 개선 후보 문서의 "신호" 섹션을 채우고, 새 문제는 BACKLOG 에 추가한다. "신호 확인", "크래시 리뷰 확인", "improve signals" 때 사용.
---

# improve-signals

콘솔에서는 **읽기만** 한다. 답글, 설정 변경, 업로드 금지.

## 1. 대상 문서와 브랜치
1. 작업 트리 확인: `git status --porcelain` 출력이 `supabase/.temp/` 외에 비어 있어야 한다. 아니면 멈추고 사용자에게 알린다.
2. `git fetch origin --prune` 실행. 실패해도 로컬 상태로 계속한다.
3. 후보 브랜치: `git for-each-ref --format='%(refname:short)' refs/heads/improve refs/remotes/origin/improve` 결과 중 이름의 날짜(YYYY-MM-DD)가 가장 최신인 것. `-dryrun` 등 접미사가 붙은 브랜치는 제외한다.
4. develop 의 최신 문서: `git ls-tree --name-only origin/develop docs/improve/ | grep -- '-candidates.md$' | sort | tail -1` (origin/develop 이 없으면 `develop`).
5. 날짜가 더 최신인 쪽을 대상으로 한다.
   - improve 브랜치 쪽이면 그 브랜치로 `git switch` (원격에만 있으면 `git switch -c <name> --track origin/<name>`). 커밋도 그 브랜치에 한다.
   - 이미 develop 에 머지된 문서 쪽이면 develop 에서 `git switch -c improve/<문서날짜>-signals` 로 새 브랜치를 만들고 거기에 커밋한다.
6. 둘 다 없으면 "후보 문서 없음 — /improve-scan 먼저" 보고 후 종료. develop·main 에 직접 커밋하지 않는다.

## 2. Play Console (claude-in-chrome)
- 시작 시 로그인·2단계 인증이 필요하면 멈추고 사용자에게 알린다.
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
- 대상 문서에 `## 신호` 섹션이 있으면 `## 신호` 제목부터 문서 끝까지를 아래로 교체한다 (improve-scan 이 신호를 항상 맨 끝에 둔다).
- 없으면 문서 끝에 추가한다.
- 헤딩 날짜는 확인한 날(오늘)이다.

```markdown
## 신호 (YYYY-MM-DD 확인)
### Play Console
- 비정상 종료율 x.x% / ANR x.x% (28일)
- 상위 비정상 종료: <예외> @ <프레임> — 사용자 N명
- 리뷰: <별점 분포>, 주요 불만 "<15단어 이하 인용>"
### Sentry
- <이슈 제목> — 이벤트 N, 사용자 N, 릴리스 x.y.z
```

신호 중 기존 후보·BACKLOG 에 없는 실제 문제(재현 가능한 크래시, 반복 불만)는 대상 브랜치의 BACKLOG 에 행을 추가한다.
- 새 ID = 대상 브랜치 BACKLOG 의 최대 `I-NNN` + 1.
- 기존 행 중 취지가 같은 것이 있으면 추가하지 않는다.
- 행 형식: `| I-NNN | <제목> | open | 신호 YYYY-MM-DD | <근거> |`

## 5. 커밋
- 대상 브랜치에서 커밋한다.
- 커밋 메시지의 날짜도 확인한 날(오늘)이다.
```bash
git add docs/improve/
git commit -m "chore. YYYY-MM-DD 개선 신호 (Play Console·Sentry)"
```
- 푸시는 사용자 확인 후에만 한다. improve 브랜치면 기존 PR 에 반영된다.
