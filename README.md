<div align="center">

# 🔗 모아링 (Moaring)

**링크를 모아, 사람을 잇다 — 흩어진 링크를 한 곳에, 친구와 함께 반짝이게**

<br />

[![React Native](https://img.shields.io/badge/React_Native-0.83-61DAFB?logo=react&logoColor=white)](https://reactnative.dev/)
[![Expo](https://img.shields.io/badge/Expo-SDK_55-000020?logo=expo&logoColor=white)](https://expo.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-Auth_&_DB-3FCF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

<br />

## 📖 소개

**모아링**은 인스타·유튜브·웹에서 발견한 링크를 폴더로 정리하고, **친구와 그룹으로 함께 모을 수 있는** 링크 아카이빙 앱입니다.

혼자 쓰는 **나의 서랍**에 차곡차곡 모으다가, 여행·맛집·위시리스트 같은 주제는 **공유 그룹**을 만들어 친구를 초대하세요. 누가 어떤 링크를 추가했는지까지 한눈에 보입니다.

<br />

## ✨ 주요 기능

### 👥 그룹 공유 (핵심 기능)
- 이모지로 꾸미는 공유 그룹 생성, 상단 채널 레일로 빠른 공간 전환
- **초대 링크**로 친구 초대 (7일 유효 · 최대 10명 · 딥링크로 즉시 참여)
- 역할 기반 권한 — `owner` / `편집` / `보기 전용` (viewer에겐 편집 UI 자체가 비노출)
- 링크마다 "누가 추가했는지" 아바타·상대시간 표시
- 개인 공간은 라벤더, 공유 그룹은 웜 톤 — **배경색이 지금 어느 공간인지 말해줍니다**

### 🔗 링크 저장 & 미리보기
- 다른 앱에서 **공유하기 → 모아링**으로 바로 저장 (Android Share Intent)
- 자동 메타데이터 추출 (제목·설명·썸네일) + 도메인 파비콘 배지
- 큰 카드 / 컴팩트 리스트 전환, 검색·정렬, 💬 개인 메모

### 📁 폴더 관리
- 그룹별 폴더 그리드, 6색 팔레트, 스와이프 삭제(iOS Mail 패턴)
- 최근 저장 폴더 기억 — "어디에 저장할까요?" 시트에서 원탭 저장

### 🔐 소셜 로그인
- Google · Kakao OAuth (Supabase Auth, PKCE)
- 계정 삭제(2단계 확인) 등 개인정보 보호 대응

<br />

## 🎨 디자인 — "인디고 글래스"

LINE Seed KR 서체 + 소프트 인디고 팔레트 + 프로스트 유리 질감의 커스텀 디자인 시스템.

| 토큰 | 값 | 용도 |
|------|-----|------|
| `primary` | `#8B7EF2` | 채워진 버튼, FAB, 활성 탭 |
| `primaryDeep` | `#6D5EF0` | 텍스트 액센트, 강조 |
| 개인 공기 | `#E2DDFF →` | 나의 서랍 배경 그라디언트 |
| 웜 공기 | `#FFE9D6 →` | 공유 그룹 배경 그라디언트 |

- SVG 그라디언트 배경 + 반투명 유리 카드 (추가 의존성 없이 `react-native-svg`로 구현)
- 플로팅 필 탭바 (홈 · ＋ · 프로필), Android edge-to-edge 완전 대응
- iOS 18 다크/틴티드 아이콘, Android 13+ 테마 아이콘(모노크롬) 지원

<br />

## 🛠 기술 스택

| 분류 | 기술 |
|------|------|
| **Framework** | React Native 0.83 (New Architecture) + Expo SDK 55 |
| **Language** | TypeScript 5.9 |
| **Backend** | Supabase — Auth, PostgreSQL(RLS), Edge Functions |
| **Server State** | TanStack React Query v5 |
| **Navigation** | React Navigation v7 (커스텀 플로팅 탭바) |
| **UI/모션** | @gorhom/bottom-sheet 5 · Reanimated 4 · react-native-svg |
| **Font** | LINE Seed KR (expo-font) |
| **관측** | Sentry (@sentry/react-native) |

<br />

## 📂 프로젝트 구조

```
src/
├── components/           # 공용 UI
│   ├── GlassBackground.tsx   # 공기 배경 (그라디언트 + 라이트 오브)
│   ├── GroupRail.tsx         # 채널 레일 (그룹 전환)
│   ├── BottomSheet.tsx       # gorhom 인라인 시트 래퍼 (키보드/스냅 처리)
│   ├── LinkPreviewCard.tsx   # 링크 카드 (large/compact)
│   ├── AvatarStack.tsx · RoleBadge.tsx · MemberRow.tsx
│   └── sheets/               # CreateGroup · Invite · InviteAccept · SaveLink
├── screens/              # Login · Home(폴더 그리드) · FolderDetail · MemberManage · Profile
├── navigation/           # RootNavigator(인증 분기) · MainStack · TabNavigator(플로팅 필)
├── contexts/             # GroupContext (현재 공간 + 역할)
├── hooks/
│   ├── queries/              # useGroups · useFolders · usePosts (React Query)
│   ├── useInviteDeepLink.ts  # moaring://invite/<token> 수신
│   └── useShareIntent.ts     # 공유하기로 링크 받기
├── utils/                # inviteLink · parseMetadata · supabase · haptics ...
└── constants/theme.ts    # 디자인 토큰 (인디고 글래스)

scripts/                  # 실기기/배포 빌드 스크립트 (아래 참고)
handoff/                  # 디자인 핸드오프 (아이콘 원본 등)
research.md               # 아키텍처·의사결정·트러블슈팅 상세 기록 ★
```

> 데이터 모델(그룹 > 폴더 > 링크, RLS 정책, 초대 토큰 흐름)과 그동안의 트러블슈팅 기록은 **`research.md`** 에 정리되어 있습니다.

<br />

## 🚀 시작하기

```bash
git clone https://github.com/Yooinhak/moaring-app.git
cd moaring-app

bun install          # 패키지 매니저: bun
npx expo start       # 개발 서버
```

> ⚠️ **Expo 관련 패키지 추가는 반드시 `npx expo install`** 로 하세요. `bun add`는 SDK 비호환 버전을 조용히 설치하고, autolinking이 해당 모듈을 빌드에서 말없이 제외합니다.

### 환경 변수

```env
# .env
EXPO_PUBLIC_SUPABASE_URL=your_supabase_url
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Supabase 설정

1. [Supabase](https://supabase.com) 프로젝트 생성 후 테이블/RLS 구성 (`research.md` §데이터 모델 참고)
2. Authentication → URL Configuration에 리다이렉트 URL 추가: `moaring://auth/callback`
3. Google, Kakao OAuth Provider 활성화

<br />

## 📦 빌드 & 배포

상황별 원커맨드 스크립트 (`scripts/`):

| 상황 | iOS 실기기 (Release) | Android APK |
|------|------|------|
| JS/스타일만 수정 | `bun run ios:release` | `bun run android:apk` |
| app.json·아이콘·스플래시 수정 | `bun run ios:release:prebuild` | `bun run android:apk:prebuild` |
| 번들ID·스킴 변경 | `bun run ios:release:clean` | `bun run android:apk:clean` |

스크립트가 알아서 처리하는 것들:

- iOS: clean 후 `ios.buildReactNativeFromSource` 자동 복구 (프리빌트 RN 코어의 dev 심볼 누락 → "No script URL" 방지)
- Android: prebuild에 `SHARE_INTENT=1` 상시 포함 (공유하기 인텐트 필터 유지)
- Sentry 소스맵 업로드 기본 비활성 (`SENTRY_UPLOAD=1`로 활성화)
- APK 완성 시 경로 출력 + Finder 표시

### iOS 공유 확장 (Apple Developer 멤버십 전: 시뮬레이터 전용)

| 상황 | 명령 |
| --- | --- |
| 최초 / 플러그인·네이티브 모듈 변경 | `bun run ios:sim:share:prebuild` |
| JS 만 수정 | `bun run ios:sim:share` |
| Debug 빌드 (Metro 필요) | `npx expo start` 띄운 뒤 `CONFIG=Debug bun run ios:sim:share` |

- `IOS_SHARE_EXT=1` 일 때만 Share Extension 타깃 생성. 실기기 `ios:release` 로 돌아갈 땐 `bun run ios:release:clean` 필수 (무료 Personal Team 은 App Group 불가).
- Xcode 27 에는 Simulator.app 이 없어(DeviceHub) `expo run:ios` 대신 `xcodebuild` + `simctl` 로 빌드·설치한다. 시뮬레이터 기본값 `SIM="iPhone 17 Pro"`.
- 세션·현재 그룹·최근 폴더는 `appStorage`(iOS: App Group `group.dev.inak.moaring`)에 저장 — 확장과 공유.
- 확장 폰트는 `assets/fonts/ios/` 임베드본 (`scripts/rename-ios-fonts.py`).
- 테스트: `bun run test` (jest-expo)

<br />

## 📄 라이선스

이 프로젝트는 MIT 라이선스를 따릅니다. 서체는 [LINE Seed KR](https://seed.line.me/index_kr.html) (OFL)을 사용합니다.
