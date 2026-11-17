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
대상 문서 `## 신호` 제목부터 문서 끝까지를 다음으로 교체 (improve-scan 이 신호를 항상 맨 끝에 둔다):

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
