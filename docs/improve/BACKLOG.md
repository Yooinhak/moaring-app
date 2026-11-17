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
