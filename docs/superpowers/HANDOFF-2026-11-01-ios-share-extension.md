# 인계: iOS 공유 확장 (2026-11-01)

다른 컴퓨터/다른 Claude 세션이 이어받기 위한 문서. 레포에 없는 맥락(결정 사항, 진행 중인 외부 일정, 작업 규칙)을 모아둔다.

## 바로 할 일

1. `git pull` (develop)
2. 이 문서 → 구현 계획 `docs/superpowers/plans/2026-11-01-ios-share-extension.md` 순서로 읽기
3. 계획 **Task 1 (스파이크, go/no-go)** 부터 시작. 실행 방식은 사용자에게 확인 (서브에이전트 방식 추천했음, 아직 답 없음)
4. 스파이크 결과(통과/실패, 메모리 값)는 다음 작업 전에 사용자에게 먼저 보고

## 목표와 확정된 결정

- **목표:** iOS 에서 다른 앱 → 공유 → 모아링 선택 시, 앱 전환 없이 공유한 앱 위에 **Android 와 같은 저장 바텀시트**가 떠야 한다. 사용자가 이 UX 를 가장 중요하게 봄 → "B안(확장 안에서 RN 시트)" 확정. 앱을 여는 방식(A안)은 스파이크 실패 시 대안일 뿐.
- **Apple Developer 멤버십 없음** (비용 부담). Android 를 먼저 안정적으로 출시한 뒤 가입 예정. 그때까지:
  - App Group / Sign in with Apple 은 실기기 프로비저닝 불가 → 공유 확장은 `IOS_SHARE_EXT=1` 플래그 뒤에, **iOS 시뮬레이터에서만** 검증
  - 실기기 `bun run ios:release` (플래그 없음) 는 계속 빌드돼야 함
  - App Store Connect / TestFlight / 심사 준비는 지금 하지 않음
- 이 Mac 에는 iPhone 17 Pro 등 시뮬레이터가 있었음. 새 컴퓨터에서는 `xcrun simctl list devices available` 로 확인.

## 계획 요약 (상세는 plan 문서)

`expo-share-extension@5.0.6` 으로 Share Extension 타깃 생성 → `index.share.js` 별도 번들에서 기존 `src/share/ShareApp.tsx` 렌더. 확장은 별도 프로세스라 세션·현재 그룹·최근 폴더를 App Group UserDefaults 로컬 모듈(`modules/shared-storage`)로 공유.

조사로 확인된 함정 (계획에 반영됨):
- 라이브러리 호환표가 SDK 54 까지만 명시 — 우리는 SDK 55. 스파이크가 먼저인 이유.
- `app.json` 의 `scheme` 이 배열(`["moaring"]`)이면 확장의 `openHostApp` 이 조용히 무시됨 → 플래그 시 문자열로 정규화.
- 확장은 런타임 폰트 로드 불가. 원본 폰트 PostScript 이름(`LINESeedSansKR-Regular/Bold`) ≠ 코드의 `fontFamily`(`LINESeedKR`, `LINESeedKR-Bold`) → 이름 바꾼 사본 임베드 (Task 6).
- 확장 메모리 한도 ~120MB, 시뮬레이터는 강제 안 함 → 실기기 측정은 Task 9(선택, App Group 제외 설치).
- 확장에서 RN `Text` 폰트 스케일 문제 가능 → 스파이크 D1 실패 시에만 Task 7.

## 작업 규칙 (사용자 선호)

- 커밋 메시지: `feat. 한국어 설명` / `fix.` / `chore.` / `test.` 형식. **Co-Authored-By 트레일러 넣지 않음** (사용자가 명시적으로 요청).
- 작업 브랜치: `develop` 에서 `feature/ios-share-extension`.
- 패키지 매니저 bun (`bun.lock`). 네이티브 의존성은 `npx expo install`.
- `.gitignore` 가 README 외 모든 `*.md` 를 무시한다. 계획/스파이크/인계 문서는 `git add -f <파일>` 로 개별 추가 (규칙 자체는 건드리지 않음 — 사용자 설정).
- 사용자는 한국어로 소통.
- `.env` 는 커밋 안 됨 → 새 컴퓨터에서 사용자에게 받아야 함 (`.env.example` 참고). 빌드 스크립트가 `scripts/check-env.js` 로 먼저 검사함.

## 병행 중인 외부 일정 — Android Play 비공개 테스트 (건드리지 말 것)

- 앱 `dev.inak.moaring` v0.0.7 (versionCode 7) 이 Play Console **Alpha 비공개 테스트 트랙**에 게시됨 (2026-10-28).
- 프로덕션 신청 조건: 참여 테스터 12명 이상 × 14일 연속. 2026-10-30 기준 "현재 1일 동안 참여를 선택한 테스터 12명" → **가장 빠른 신청 ~2026-11-12**. 12명 딱 맞아 여유 없음 (2026-10-31 테스터 1명 추가 등록, 참여 여부 미확인).
- 테스터 공급: 크몽 판매자 Zardu (이메일 목록 "zardu" 44명) + "유인학" 목록 2명.
- **테스트 기간 중 Alpha 외 트랙(내부/공개/프로덕션)에 빌드 업로드 금지** (Zardu 경고). 이 작업은 iOS 전용이라 해당 없지만, Android 쪽 코드를 바꾸게 되면(Task 4·5 의 Android 회귀 확인 포함) **로컬 APK 확인만** 하고 Play 업로드는 하지 말 것.
- 프로덕션 신청 설문 예시 답변은 Zardu 의 Notion 가이드에 있음.

## 현재 상태 (2026-11-01)

- develop 깨끗함. 이번 커밋은 계획 + 인계 문서뿐, 코드 변경 없음.
- 구현 시작 전. Task 1 Step 1(브랜치 생성)부터.
