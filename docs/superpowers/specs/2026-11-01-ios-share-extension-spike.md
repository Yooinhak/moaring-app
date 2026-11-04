# iOS 공유 확장 스파이크 결과 (2026-11-01 ~ 11-03)

환경: Expo SDK 55 · RN 0.83 · expo-share-extension 5.0.6 · Xcode 27.2 (27B52) · 시뮬레이터 iPhone 17 Pro / iOS 26.5 · Release 빌드

| # | 결과 | 메모 |
| --- | --- | --- |
| A 빌드 | ✅ | Xcode 27 대응 2건 필요 (아래). 확장 번들 ID `dev.inak.moaring.ShareExtension`, 타깃명 `appShareExtension` |
| B 공유 목록 | ✅ | Safari 공유 시트에 모아링 노출 |
| C 시트 렌더 | ✅ | Safari 가 비치는 투명 배경 위 gorhom 바텀시트, 아래로 끌어 닫기 동작 |
| D1 시스템 폰트 | ✅ | "시스템 폰트 텍스트" 정상 크기 (스파이크 화면 한정 — 아래 D2 참고) |
| D2 커스텀 폰트 | ❌ | 폴백이 아니라 **글자가 안 보임**. `fontFamily: 'LINESeedKR'` 텍스트, 시트 제목, 버튼 라벨 모두 공백 → Task 6 필수 |
| E 닫기 | ✅ | 아래로 끌어 닫으면 Safari 로 복귀 |
| F 메모리 (Release) | 49 MB | `footprint` phys_footprint 49MB (peak 50MB), RSS 30MB. 시트 띄운 상태 |

결론: **GO**

### D2 후속 (Task 6 이후)

폰트 임베드(Task 6) 후에도 실제 SaveLinkSheet 글자가 안 보였다. 원인은 확장 안 RN 폰트 스케일 계산 → **Task 7 필요**.
`src/share/patchTextForExtension.tsx` 가 확장 번들에서만 `react-native` 의 `Text`/`TextInput` getter 를 `allowFontScaling={false}` 래퍼로 교체
(`Libraries/Text/Text` 의 `default` 는 getter 전용이라 대입 불가). 수정 후 LINE Seed 로 전부 표시, 메모리 62MB.

## E2E (시뮬레이터, Release)

| # | 시나리오 | 결과 |
| --- | --- | --- |
| 1 | Safari 공유 → 폴더 선택 → 저장 | ✅ 시트 닫히고 Safari 복귀, 앱에 링크 반영 |
| 2 | 로그인 세션 공유 (App Group) | ✅ 확장에서 나의 서랍 폴더 목록 로드 |
| 3 | "+ 새 폴더" 빈 이름 → 에러 토스트가 시트 위에 | 미확인 (UI 자동화 도구 없음) |
| 4 | 앱 완전 종료 상태에서 공유 → 저장 | 미확인 |
| 5 | 메모 "hello" 공유 → "링크만 저장할 수 있어요" | 미확인 (`extractUrl` 단위 테스트 통과) |
| 6 | URL 포함 텍스트 공유 → URL 추출 | 미확인 (`extractUrl` 단위 테스트 통과) |
| 7 | 로그아웃 상태 공유 → "로그인이 필요해요" → "모아링 열기" | 미확인 |
| 8 | 하루 뒤 토큰 갱신 | 미확인 (장기) |

## Xcode 27 대응 (실기기 빌드에도 해당)

1. **Simulator.app 없음** — Xcode 27.2 는 DeviceHub.app 으로 대체. `expo run:ios` 가 `CommandError: Can't determine id of Simulator app` 로 실패 → `scripts/build-ios-sim-share.sh` 는 `xcodebuild` + `simctl` 로 직접 빌드·설치·실행.
2. **Pods 컴파일 실패** — `plugins/withPodsDeploymentTarget.js` 가 Podfile `post_install` 에서 보정.
   - 배포 타깃 < 15.1 이 에러로 바뀜 (Sentry 11.0, RNSVGFilters 12.4, SDWebImage 9.0, RNCAsyncStorage 리소스 13.4) → 15.1 로 올림.
   - fmt 11.0.2 `call to consteval function ... is not a constant expression` → fmt 타깃만 C++17.

## 측정 방법

Xcode attach 대신 확장 프로세스가 뜨길 기다려 `footprint <pid>` 로 측정 (Debug navigator Memory 와 같은 지표).
