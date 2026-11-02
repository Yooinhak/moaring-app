# iOS 공유 확장 (Android 동일 바텀시트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iOS 에서 다른 앱(Safari 등) → 공유 → 모아링 선택 시, 앱 전환 없이 공유한 앱 위에 Android 와 같은 저장 바텀시트(`ShareApp` / `SaveLinkSheet`)가 뜨게 한다.

**Architecture:** `expo-share-extension` 으로 iOS Share Extension 타깃을 만들고, 그 안에서 별도 JS 번들(`index.share.js`)로 기존 `ShareApp` 을 렌더한다. 확장은 메인 앱과 **다른 프로세스**라 Android 처럼 JS 런타임을 공유하지 못하므로, 로그인 세션·현재 그룹·최근 폴더를 App Group `UserDefaults` 기반 로컬 Expo 모듈(`modules/shared-storage`)로 옮겨 두 프로세스가 같은 저장소를 본다. Apple Developer 멤버십이 없어 실기기에 App Group 을 프로비저닝할 수 없으므로 전부 `IOS_SHARE_EXT=1` 플래그 뒤에 두고 iOS 시뮬레이터에서 검증한다.

**Tech Stack:** Expo SDK 55 · RN 0.83 (New Arch) · expo-share-extension 5.0.6 · Expo Modules (Swift) · supabase-js v2 · @gorhom/bottom-sheet 5 · reanimated 4 · jest-expo

## Global Constraints

- 플래그 `IOS_SHARE_EXT=1` 일 때만 iOS 공유 확장 타깃 생성. 기본값 off → `bun run ios:release` (실기기, 무료 Personal Team) 는 지금처럼 빌드돼야 한다.
- App Group ID: `group.dev.inak.moaring` / 확장 bundle ID: `dev.inak.moaring.ShareExtension` (expo-share-extension 기본 규칙).
- Android 동작 불변: `SHARE_INTENT=1` + `ShareSheetActivity`(modules/share-sheet) 경로 그대로. Android 저장소는 AsyncStorage 폴백 → 키 동일 → 업데이트해도 로그아웃 없음.
- expo-share-extension 호환표는 SDK 54 까지만 명시 — SDK 55 동작은 Task 1 스파이크에서 확인한다. 실패 시 이 계획 중단 후 재논의.
- iOS 확장 메모리 한도 약 120MB. 시뮬레이터는 한도를 강제하지 않으므로 측정값만 기록하고, 실기기 측정은 Task 9(선택).
- 의존성은 `npx expo install` 로 추가 (bun.lock 자동 감지).
- 커밋 메시지 형식: `feat. 한국어 설명` / `fix. …` / `chore. …` / `test. …`. Co-Authored-By 트레일러 넣지 않는다.
- 작업 브랜치: `develop` 에서 `feature/ios-share-extension` 생성.

---

## 파일 구조

| 파일 | 역할 |
| --- | --- |
| `app.config.js` (수정) | `IOS_SHARE_EXT` 플래그 → expo-share-extension·폰트 임베드 플러그인 추가, scheme 정규화. expo-share-intent 는 Android 전용(`disableIOS`) |
| `metro.config.js` (수정) | `withShareExtension` 래핑 (디버그에서 확장 번들 서빙) |
| `index.share.js` (생성) | 확장 JS 엔트리 — `AppRegistry 'shareExtension'` |
| `src/share/ShareExtensionRoot.tsx` (생성) | 확장 루트. `InitialProps{url,text}` → `ShareApp` |
| `src/share/shareHost.{ios,android,}.ts` (생성) | 시트 닫기/메인 앱 열기 플랫폼 브리지 |
| `src/share/ShareApp.tsx` (수정) | 플랫폼 중립화 (닫기·토스트·비링크 안내) |
| `src/utils/extractUrl.ts` (생성) | 공유 텍스트 → 첫 URL (ShareApp·useShareIntent 공용) |
| `modules/shared-storage/` (생성) | iOS App Group UserDefaults 키-값 Expo 모듈 |
| `src/utils/storage/createAppStorage.ts` (생성) | 네이티브 있으면 공유 저장소, 없으면 폴백 — 순수 로직(테스트 대상) |
| `src/utils/storage/appStorage.ts` (생성) | 실제 인스턴스 (SharedStorage ↔ AsyncStorage) |
| `src/utils/supabase/client.ts`, `src/contexts/GroupContext.tsx`, `src/components/sheets/SaveLinkSheet.tsx`, `src/components/EmojiPicker.tsx`, `src/hooks/useAuth.ts` (수정) | 공유가 필요한 키를 `appStorage` 로 |
| `src/components/sheetOverlay.ts` (생성), `src/components/BottomSheet.tsx`, `src/components/Toast.tsx` (수정) | 확장에서 토스트를 시트(Modal) 위에 띄우는 오버레이 |
| `scripts/rename-ios-fonts.py`, `assets/fonts/ios/*.ttf` (생성) | 확장용 임베드 폰트 (PostScript 이름 = 코드의 fontFamily) |
| `scripts/build-ios-sim-share.sh`, `scripts/build-ios-device-share-smoke.sh` (생성) | 시뮬레이터 빌드 / 실기기 스모크(선택) |
| `docs/superpowers/specs/2026-11-01-ios-share-extension-spike.md` (생성) | 스파이크 결과 기록 |

공유 저장소로 옮기는 키: supabase 세션(`sb-<ref>-auth-token`), `moaring.currentGroupId`, `moaring.recentFolderId`, `moaring.recentEmojis`. 나머지(`moaring.groupLastSeen` 등)는 AsyncStorage 유지.

---

### Task 1: 플래그 설정 + 확장 골격 + 스파이크 (go / no-go)

가장 큰 리스크(SDK 55 호환, 확장 안 gorhom 시트·Modal·제스처, 텍스트 렌더)를 실제 코드 붙이기 전에 확인한다.

**Files:**
- Modify: `app.config.js`
- Modify: `metro.config.js`
- Modify: `package.json` (scripts, dependency)
- Create: `index.share.js`
- Create: `src/share/ShareExtensionRoot.tsx` (스파이크 버전 — Task 5 에서 교체)
- Create: `scripts/build-ios-sim-share.sh`
- Create: `docs/superpowers/specs/2026-11-01-ios-share-extension-spike.md`

**Interfaces:**
- Produces: 환경변수 `IOS_SHARE_EXT=1`, AppRegistry 이름 `'shareExtension'`, `bun run ios:sim:share[:prebuild]`

- [ ] **Step 1: 브랜치 생성**

```bash
git checkout develop && git pull && git checkout -b feature/ios-share-extension
```

- [ ] **Step 2: 의존성 설치**

```bash
npx expo install expo-share-extension
```
Expected: `package.json` dependencies 에 `"expo-share-extension": "^5.0.6"` 추가.

- [ ] **Step 3: `app.config.js` 수정** — 파일 전체를 아래로 교체

```js
/**
 * 동적 Expo 설정 — app.json 을 기반으로 조건부 플러그인을 추가한다.
 *
 * 공유하기로 링크 받기:
 *   - Android: expo-share-intent + ShareSheetActivity(modules/share-sheet).
 *     SHARE_INTENT=1 npx expo prebuild -p android  (빌드 스크립트가 자동 포함)
 *   - iOS: expo-share-extension — Share Extension 안에서 RN 바텀시트(ShareApp)를 띄운다.
 *     App Group entitlement 가 필요해 Apple Developer Program(유료) 없이는 실기기 빌드가 깨진다.
 *     → IOS_SHARE_EXT=1 일 때만 타깃을 만든다. 멤버십 전에는 시뮬레이터 전용
 *       (bun run ios:sim:share). 실기기 ios:release 는 플래그 없이 기존과 동일.
 *   - Apple 멤버십 가입 후: IOS_SHARE_EXT 기본 활성화 + app.json 의
 *     usesAppleSignIn/expo-apple-authentication 복원 (_disabled_plugins_TODO 참고)
 */

const ENABLE_BY_DEFAULT = false; // Android expo-share-intent 기본 활성화 여부

// Android release 빌드를 업로드 키로 서명하도록 build.gradle 을 손보는 config plugin.
// (설정/키가 없으면 플러그인이 알아서 debug 키로 폴백 → 항상 안전하게 켜둬도 됨)
const withReleaseSigning = require('./plugins/withReleaseSigning');
// Android 공유 수신을 MainActivity → ShareSheetActivity(투명, modules/share-sheet)로 옮긴다.
// 앱 전환 없이 공유한 앱 위에 저장 시트만 뜨게 하는 핵심. expo-share-intent 뒤에 적용돼야 함.
const withShareSheet = require('./plugins/withShareSheet');

module.exports = ({ config }) => {
  const enableShareIntent = ENABLE_BY_DEFAULT || process.env.SHARE_INTENT === '1';
  const enableIosShareExt = process.env.IOS_SHARE_EXT === '1';

  if (enableShareIntent) {
    config.plugins = [
      ...(config.plugins ?? []),
      // iOS 는 expo-share-extension 이 담당 — 둘 다 Share Extension 타깃을 만들면 충돌한다.
      ['expo-share-intent', { disableIOS: true, androidIntentFilters: ['text/*'] }],
    ];
  }

  if (enableIosShareExt) {
    // expo-share-extension 은 config.scheme 을 그대로 HostAppScheme(문자열)로 쓴다.
    // 배열이면 openHostApp 이 조용히 무시되므로 단일 문자열로 정규화.
    if (Array.isArray(config.scheme)) config.scheme = config.scheme[0];

    config.plugins = [
      ...(config.plugins ?? []),
      [
        'expo-share-extension',
        {
          activationRules: [{ type: 'url', max: 1 }, { type: 'text' }],
          // 투명 배경 — 공유한 앱 위에 바텀시트만 보이게 (Android 투명 Activity 와 동일)
          backgroundColor: { red: 0, green: 0, blue: 0, alpha: 0 },
          excludedPackages: ['expo-dev-client', 'expo-splash-screen', 'expo-share-intent'],
        },
      ],
    ];
  }

  return withShareSheet(withReleaseSigning(config));
};
```

- [ ] **Step 4: `metro.config.js` 수정** — 파일 전체 교체

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withShareExtension } = require('expo-share-extension/metro');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// 디버그 빌드에서 iOS 공유 확장이 ?shareExtension=true 로 요청하면 index.share 번들을 내준다.
module.exports = withNativeWind(withShareExtension(config), { input: './global.css' });
```

- [ ] **Step 5: 스파이크 루트 `src/share/ShareExtensionRoot.tsx` 생성**

```tsx
import React from 'react';

import { Text, View } from 'react-native';

import { close, type InitialProps } from 'expo-share-extension';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import BottomSheet from '../components/BottomSheet';
import Button from '../components/Button';

/** 스파이크 전용 — 확장 안에서 gorhom 시트·Modal·텍스트·폰트가 뜨는지만 본다 (Task 5 에서 교체). */
export default function ShareExtensionRoot({ url, text }: InitialProps) {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: 'transparent' }}>
      <SafeAreaProvider>
        <BottomSheet visible onClose={close} title="스파이크">
          <View style={{ gap: 12 }}>
            <Text style={{ fontFamily: 'LINESeedKR', fontSize: 16 }}>LINESeedKR: {url ?? text ?? '(없음)'}</Text>
            <Text style={{ fontSize: 16 }}>시스템 폰트 텍스트</Text>
            <Button onPress={close}>닫기</Button>
          </View>
        </BottomSheet>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

- [ ] **Step 6: `index.share.js` 생성** (레포 루트)

```js
import { AppRegistry } from 'react-native';

import ShareExtensionRoot from './src/share/ShareExtensionRoot';

// iOS 공유 확장 번들 엔트리. 이름은 반드시 'shareExtension' (expo-share-extension 네이티브가 이 이름으로 띄움).
AppRegistry.registerComponent('shareExtension', () => ShareExtensionRoot);
```

- [ ] **Step 7: `scripts/build-ios-sim-share.sh` 생성 + 실행 권한**

> 실행 메모 (2026-11-03): Xcode 27.2 에는 Simulator.app 이 없어 `expo run:ios` 가 실패한다. 실제 스크립트는 `xcodebuild` + `simctl` 로 빌드·설치하고 기본 `CONFIG=Release` (Debug 는 `npx expo start` 필요). Pods 보정은 `plugins/withPodsDeploymentTarget.js`. 확장 번들 ID 는 `dev.inak.moaring.ShareExtension`. 스파이크 D2 에서 미등록 폰트 텍스트가 **보이지 않음** → Task 6 필수. 상세는 스파이크 문서.

```bash
#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 모아링 iOS 시뮬레이터 빌드 — 공유 확장(IOS_SHARE_EXT=1) 포함
#
# 사용법:
#   bun run ios:sim:share                   # 평소 (JS 만 바꿨을 때)
#   bun run ios:sim:share:prebuild          # app.config/플러그인/네이티브 모듈 바꿨을 때
#   CONFIG=Release bun run ios:sim:share    # 메모리 측정용 Release
#
# ⚠️ ios/ 가 확장 포함으로 재생성된다. 실기기 빌드로 돌아갈 땐 반드시
#    bun run ios:release:clean (무료 Personal Team 은 App Group 프로비저닝 불가)
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/check-env.js

export IOS_SHARE_EXT=1
MODE="${1:-run}" # run | prebuild
CONFIG="${CONFIG:-Debug}"

if [[ "$MODE" == "prebuild" ]]; then
  echo "🧹 IOS_SHARE_EXT=1 prebuild --clean (ios/ 재생성)"
  npx expo prebuild -p ios --clean
  # build-ios-device.sh 와 동일 — --clean 이 지우는 소스 빌드 플래그 복구
  echo "🩹 Podfile.properties.json 에 buildReactNativeFromSource 복구"
  node -e "
    const fs = require('fs');
    const f = 'ios/Podfile.properties.json';
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j['ios.buildReactNativeFromSource'] = 'true';
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  "
  npx pod-install
fi

echo "📱 시뮬레이터 $CONFIG 빌드"
npx expo run:ios --configuration "$CONFIG"
```

```bash
chmod +x scripts/build-ios-sim-share.sh
```

`package.json` scripts 에 추가 (`ios:release:clean` 줄 아래):
```json
    "ios:sim:share": "bash scripts/build-ios-sim-share.sh",
    "ios:sim:share:prebuild": "bash scripts/build-ios-sim-share.sh prebuild",
```

- [ ] **Step 8: 시뮬레이터 빌드**

Run: `bun run ios:sim:share:prebuild`
Expected: 빌드 성공, 시뮬레이터에 모아링 실행. `ios/ShareExtension/` 디렉터리 존재.
실패 시: 에러 원문을 스파이크 문서에 기록하고 **중단** (Global Constraints — SDK 55 비호환).

- [ ] **Step 9: 스파이크 체크 (시뮬레이터)**

Safari 에서 `https://example.com` → 공유 버튼 → (처음엔 "더 보기"에서 모아링 켜기) → 모아링.

| # | 확인 | 통과 기준 |
| --- | --- | --- |
| A | 빌드 | Step 8 성공 |
| B | 공유 목록 | 공유 시트에 모아링 노출 |
| C | 시트 렌더 | Safari 가 비치는 투명 배경 위에 바텀시트, 아래로 끌어 닫기 동작 |
| D1 | 시스템 폰트 텍스트 | "시스템 폰트 텍스트" 가 정상 크기로 보임 |
| D2 | 커스텀 폰트 | "LINESeedKR: https://example.com" 이 LINE Seed 글꼴인지 (예상: 시스템 폰트로 폴백 — Task 6 에서 해결) |
| E | 닫기 | 닫기 버튼 → Safari 로 복귀 |
| F | 메모리 | `CONFIG=Release bun run ios:sim:share` 후 공유 시트 띄운 상태에서 Xcode → Debug → Attach to Process → `ShareExtension` → Debug navigator Memory 값 기록 |

디버그 빌드에서 확장이 빈 화면/번들 로드 에러면 Release(`CONFIG=Release`)로 재확인 — Release 는 `index.share.js` 를 직접 번들한다.

- [ ] **Step 10: 결과 기록** — `docs/superpowers/specs/2026-11-01-ios-share-extension-spike.md` 생성

```markdown
# iOS 공유 확장 스파이크 결과 (2026-11-01)

환경: Expo SDK 55 · RN 0.83 · expo-share-extension 5.0.6 · Xcode <버전> · 시뮬레이터 <기기/iOS 버전>

| # | 결과 | 메모 |
| --- | --- | --- |
| A 빌드 | ✅/❌ | |
| B 공유 목록 | ✅/❌ | |
| C 시트 렌더 | ✅/❌ | |
| D1 시스템 폰트 | ✅/❌ | ❌ 이면 Task 7 수행 |
| D2 커스텀 폰트 | ✅/❌ | |
| E 닫기 | ✅/❌ | |
| F 메모리 (Release) | <N> MB | 100MB 이상이면 중단 후 재논의 |

결론: GO / NO-GO
```

**Gate:** A·B·C·E 중 하나라도 ❌ 또는 F ≥ 100MB → 여기서 멈추고 사용자에게 보고 (대안: 앱 전환 방식 A안).

- [ ] **Step 11: 실기기 회귀** — 플래그 없는 빌드가 그대로인지

Run: `bun run ios:release:clean` (iPhone 연결)
Expected: 빌드·설치 성공, `ios/ShareExtension/` 없음.

- [ ] **Step 12: 커밋**

```bash
git add app.config.js metro.config.js package.json bun.lock index.share.js src/share/ShareExtensionRoot.tsx scripts/build-ios-sim-share.sh docs/superpowers/specs/2026-11-01-ios-share-extension-spike.md
git commit -m "feat. iOS 공유 확장 골격 — IOS_SHARE_EXT 플래그 + 시뮬레이터 스파이크"
```

---

### Task 2: 테스트 환경 + `extractUrl` 공용화

**Files:**
- Modify: `package.json` (devDependencies, `test` 스크립트, `jest` 설정)
- Modify: `.eslintrc.json`
- Create: `src/utils/extractUrl.ts`
- Create: `src/utils/__tests__/extractUrl.test.ts`
- Modify: `src/share/ShareApp.tsx` (로컬 `extractUrl` 제거 → import)
- Modify: `src/hooks/useShareIntent.ts`

**Interfaces:**
- Produces: `extractUrl(text: string | null | undefined): string | null` (`src/utils/extractUrl.ts`), `bun run test`

- [ ] **Step 1: jest 설치**

```bash
npx expo install jest-expo jest @types/jest -- --dev
```

`package.json` 에 추가:
```json
  "scripts": { "test": "jest" },
  "jest": { "preset": "jest-expo" }
```
(`scripts` 는 기존 객체에 `"test": "jest"` 한 줄만 추가)

`.eslintrc.json` 최상위에 overrides 추가 (이미 `overrides` 가 있으면 배열에 항목만 추가):
```json
  "overrides": [{ "files": ["**/__tests__/**"], "env": { "jest": true } }]
```

- [ ] **Step 2: 실패하는 테스트 작성** — `src/utils/__tests__/extractUrl.test.ts`

```ts
import { extractUrl } from '../extractUrl';

describe('extractUrl', () => {
  it('URL 만 있으면 그대로 반환', () => {
    expect(extractUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('앞뒤 공백 제거', () => {
    expect(extractUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('문장 속 첫 링크 추출', () => {
    expect(extractUrl('이거 봐 https://youtu.be/abc #꿀팁 https://other.com')).toBe('https://youtu.be/abc');
  });

  it('링크가 없으면 null', () => {
    expect(extractUrl('그냥 텍스트')).toBeNull();
  });

  it('http(s) 가 아니면 null', () => {
    expect(extractUrl('ftp://example.com')).toBeNull();
  });

  it('빈 값이면 null', () => {
    expect(extractUrl(undefined)).toBeNull();
    expect(extractUrl(null)).toBeNull();
    expect(extractUrl('')).toBeNull();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `bun run test -- src/utils/__tests__/extractUrl.test.ts`
Expected: FAIL — `Cannot find module '../extractUrl'`

- [ ] **Step 4: 구현** — `src/utils/extractUrl.ts`

```ts
import { isValidUrl } from './validateUrl';

/** 공유 텍스트에서 첫 http(s) 링크를 뽑는다 — "이거 봐 https://… #태그" 같은 문장 대응. */
export function extractUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (isValidUrl(trimmed)) return trimmed;
  const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  return match && isValidUrl(match[0]) ? match[0] : null;
}
```

- [ ] **Step 5: 통과 확인**

Run: `bun run test -- src/utils/__tests__/extractUrl.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: 사용처 교체**

`src/share/ShareApp.tsx`: 로컬 `function extractUrl(...) {...}` 블록(주석 포함)과 `import { isValidUrl } from '../utils/validateUrl';` 삭제, 대신
```ts
import { extractUrl } from '../utils/extractUrl';
```

`src/hooks/useShareIntent.ts`: `import { isValidUrl } from '../utils/validateUrl';` → `import { extractUrl } from '../utils/extractUrl';` 로 바꾸고 effect 본문을
```ts
    const url = extractUrl(shareIntent.webUrl || shareIntent.text);

    if (!url) {
      resetShareIntent();
      return;
    }
```
로 교체 (`setPendingUrl(url); resetShareIntent();` 이하는 그대로).

- [ ] **Step 7: 정적 검사**

Run: `bun run lint && npx tsc --noEmit && bun run test`
Expected: 모두 통과

- [ ] **Step 8: 커밋**

```bash
git add package.json bun.lock .eslintrc.json src/utils/extractUrl.ts src/utils/__tests__/extractUrl.test.ts src/share/ShareApp.tsx src/hooks/useShareIntent.ts
git commit -m "test. jest 도입 + 공유 텍스트 URL 추출(extractUrl) 공용화"
```

---

### Task 3: App Group 공유 저장소 (`modules/shared-storage` + `appStorage`)

**Files:**
- Create: `modules/shared-storage/package.json`
- Create: `modules/shared-storage/expo-module.config.json`
- Create: `modules/shared-storage/index.ts`
- Create: `modules/shared-storage/ios/SharedStorage.podspec`
- Create: `modules/shared-storage/ios/SharedStorageModule.swift`
- Create: `src/utils/storage/createAppStorage.ts`
- Create: `src/utils/storage/__tests__/createAppStorage.test.ts`
- Create: `src/utils/storage/appStorage.ts`

**Interfaces:**
- Produces:
  - `APP_GROUP = 'group.dev.inak.moaring'`
  - `interface KeyValueStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void>; multiRemove(keys: string[]): Promise<void>; }`
  - `interface SharedStorageNative { getItem(suite: string, key: string): string | null; setItem(suite: string, key: string, value: string): void; removeItem(suite: string, key: string): void; }`
  - `createAppStorage(native: SharedStorageNative | null, suite: string, fallback: KeyValueStorage): KeyValueStorage`
  - `appStorage: KeyValueStorage` (`src/utils/storage/appStorage.ts`)

- [ ] **Step 1: 실패하는 테스트** — `src/utils/storage/__tests__/createAppStorage.test.ts`

```ts
import { createAppStorage, type KeyValueStorage, type SharedStorageNative } from '../createAppStorage';

function fakeNative(): SharedStorageNative & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (suite, key) => data.get(`${suite}/${key}`) ?? null,
    setItem: (suite, key, value) => void data.set(`${suite}/${key}`, value),
    removeItem: (suite, key) => void data.delete(`${suite}/${key}`),
  };
}

function fakeFallback(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
    multiRemove: async (keys) => keys.forEach((k) => data.delete(k)),
  };
}

describe('createAppStorage', () => {
  it('네이티브가 있으면 suite 로 네이티브에 읽고 쓴다', async () => {
    const native = fakeNative();
    const fallback = fakeFallback();
    const storage = createAppStorage(native, 'group.test', fallback);

    await storage.setItem('k', 'v');
    expect(native.data.get('group.test/k')).toBe('v');
    expect(fallback.data.size).toBe(0);
    expect(await storage.getItem('k')).toBe('v');

    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
  });

  it('multiRemove 는 모든 키를 지운다', async () => {
    const native = fakeNative();
    const storage = createAppStorage(native, 'g', fakeFallback());
    await storage.setItem('a', '1');
    await storage.setItem('b', '2');
    await storage.setItem('c', '3');

    await storage.multiRemove(['a', 'b']);

    expect(await storage.getItem('a')).toBeNull();
    expect(await storage.getItem('b')).toBeNull();
    expect(await storage.getItem('c')).toBe('3');
  });

  it('네이티브가 없으면(Android·웹) 폴백을 그대로 쓴다', async () => {
    const fallback = fakeFallback();
    const storage = createAppStorage(null, 'g', fallback);

    await storage.setItem('k', 'v');

    expect(fallback.data.get('k')).toBe('v');
    expect(storage).toBe(fallback);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun run test -- src/utils/storage`
Expected: FAIL — `Cannot find module '../createAppStorage'`

- [ ] **Step 3: 구현** — `src/utils/storage/createAppStorage.ts`

```ts
/**
 * 키-값 저장소 선택 로직 (RN 의존 없음 → 단위 테스트 대상).
 *
 * iOS 공유 확장은 메인 앱과 다른 프로세스라 AsyncStorage(앱 전용 컨테이너)를 공유하지 못한다.
 * App Group UserDefaults 네이티브 모듈이 있으면 그걸 쓰고, 없으면(Android·웹) 폴백을 그대로 쓴다.
 */

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
}

/** modules/shared-storage 의 iOS 네이티브 함수 (동기) */
export interface SharedStorageNative {
  getItem(suite: string, key: string): string | null;
  setItem(suite: string, key: string, value: string): void;
  removeItem(suite: string, key: string): void;
}

export function createAppStorage(
  native: SharedStorageNative | null,
  suite: string,
  fallback: KeyValueStorage,
): KeyValueStorage {
  if (!native) return fallback;

  return {
    getItem: async (key) => native.getItem(suite, key),
    setItem: async (key, value) => native.setItem(suite, key, value),
    removeItem: async (key) => native.removeItem(suite, key),
    multiRemove: async (keys) => keys.forEach((key) => native.removeItem(suite, key)),
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `bun run test -- src/utils/storage`
Expected: PASS (3 tests)

- [ ] **Step 5: 네이티브 모듈 생성**

`modules/shared-storage/package.json`:
```json
{
  "name": "shared-storage",
  "version": "0.1.0",
  "private": true,
  "main": "index.ts"
}
```

`modules/shared-storage/expo-module.config.json`:
```json
{
  "platforms": ["apple"],
  "apple": {
    "modules": ["SharedStorageModule"]
  }
}
```

`modules/shared-storage/ios/SharedStorage.podspec`:
```ruby
Pod::Spec.new do |s|
  s.name           = 'SharedStorage'
  s.version        = '0.1.0'
  s.summary        = 'App Group UserDefaults key-value storage (main app <-> share extension)'
  s.description    = s.summary
  s.author         = ''
  s.homepage       = 'https://github.com/inak/moaring-app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
```

`modules/shared-storage/ios/SharedStorageModule.swift`:
```swift
import ExpoModulesCore

/// App Group UserDefaults 키-값 저장소 — 메인 앱과 공유 확장(별도 프로세스)이 같은 값을 본다.
/// App Group entitlement 가 없으면(무료 Personal Team 실기기) suite 가 앱 전용으로 동작해
/// 공유만 안 될 뿐 읽기/쓰기는 정상이다.
public class SharedStorageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SharedStorage")

    Function("getItem") { (suite: String, key: String) -> String? in
      UserDefaults(suiteName: suite)?.string(forKey: key)
    }

    Function("setItem") { (suite: String, key: String, value: String) in
      UserDefaults(suiteName: suite)?.set(value, forKey: key)
    }

    Function("removeItem") { (suite: String, key: String) in
      UserDefaults(suiteName: suite)?.removeObject(forKey: key)
    }
  }
}
```

`modules/shared-storage/index.ts`:
```ts
import { requireOptionalNativeModule } from 'expo';

import type { SharedStorageNative } from '../../src/utils/storage/createAppStorage';

/** iOS 전용. Android/웹에는 네이티브 모듈이 없어 null. */
export const SharedStorage = requireOptionalNativeModule<SharedStorageNative>('SharedStorage');
```

- [ ] **Step 6: 인스턴스** — `src/utils/storage/appStorage.ts`

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

import { SharedStorage } from '../../../modules/shared-storage';
import { createAppStorage } from './createAppStorage';

/** expo-share-extension 기본 규칙(group.<bundleId>)과 같아야 한다. */
export const APP_GROUP = 'group.dev.inak.moaring';

/**
 * 메인 앱·iOS 공유 확장이 함께 읽는 값(세션·현재 그룹·최근 폴더·최근 이모지) 전용 저장소.
 * iOS → App Group UserDefaults, Android/웹 → AsyncStorage (기존 키 그대로라 마이그레이션 불필요).
 */
export const appStorage = createAppStorage(SharedStorage, APP_GROUP, AsyncStorage);
```

- [ ] **Step 7: 검사 + 네이티브 빌드 확인**

Run: `bun run lint && npx tsc --noEmit && bun run test && bun run ios:sim:share:prebuild`
Expected: 통과, 시뮬레이터 빌드 성공 (`SharedStorage` pod 설치 로그 확인)

- [ ] **Step 8: 커밋**

```bash
git add modules/shared-storage src/utils/storage
git commit -m "feat. App Group 공유 저장소 모듈(shared-storage) + appStorage"
```

---

### Task 4: 공유 대상 키를 `appStorage` 로 + 포그라운드 토큰 갱신

**Files:**
- Modify: `src/utils/supabase/client.ts`
- Modify: `src/contexts/GroupContext.tsx:3,47,54`
- Modify: `src/components/sheets/SaveLinkSheet.tsx:5,109,199,276`
- Modify: `src/components/EmojiPicker.tsx` (`AsyncStorage` import 및 37·40·54행 사용처)
- Modify: `src/hooks/useAuth.ts` (`clearAccountScopedData`)

**Interfaces:**
- Consumes: `appStorage` (Task 3)

- [ ] **Step 1: supabase 클라이언트** — `src/utils/supabase/client.ts` 전체 교체

```ts
import { AppState } from 'react-native';

import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

import { appStorage } from '../storage/appStorage';
import { Database } from './types';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// 세션은 appStorage(iOS: App Group) 에 둔다 — iOS 공유 확장(별도 프로세스)이 같은 로그인을 쓴다.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: appStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// 포그라운드일 때만 자동 갱신 — 백그라운드에서 공유 확장과 갱신이 겹치지 않게 하고,
// 복귀 시 확장이 갱신해 둔 세션을 저장소에서 다시 읽는다 (supabase-js 는 매 조회마다 storage 를 읽음).
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
```

- [ ] **Step 2: GroupContext / SaveLinkSheet / EmojiPicker**

세 파일 모두:
- `import AsyncStorage from '@react-native-async-storage/async-storage';` → 각 파일 위치 기준 상대경로로 `import { appStorage } from '<상대경로>/utils/storage/appStorage';`
  - `src/contexts/GroupContext.tsx` → `'../utils/storage/appStorage'`
  - `src/components/sheets/SaveLinkSheet.tsx` → `'../../utils/storage/appStorage'`
  - `src/components/EmojiPicker.tsx` → `'../utils/storage/appStorage'`
- 파일 안의 `AsyncStorage.getItem` / `AsyncStorage.setItem` 을 `appStorage.getItem` / `appStorage.setItem` 으로 (시그니처 동일).
- `GroupContext.tsx:12` 주석 "선택은 AsyncStorage에 영속" → "선택은 appStorage(iOS 는 공유 확장과 공유)에 영속".

확인: `grep -n "AsyncStorage" src/contexts/GroupContext.tsx src/components/sheets/SaveLinkSheet.tsx src/components/EmojiPicker.tsx` → 출력 없음.

- [ ] **Step 3: useAuth 로그아웃 정리 분리** — `clearAccountScopedData` 본문의 `AsyncStorage.multiRemove([...]).catch(...)` 를 아래로 교체하고 상단에 `import { appStorage } from '../utils/storage/appStorage';` 추가

```ts
  // 공유 확장과 같이 쓰는 키 (iOS: App Group)
  appStorage
    .multiRemove([
      'moaring.currentGroupId', // GroupContext
      'moaring.recentFolderId', // SaveLinkSheet
    ])
    .catch(() => {
      // 스토리지 정리 실패가 로그아웃을 막을 이유는 없다
    });
  AsyncStorage.multiRemove(['moaring.groupLastSeen' /* useActivityUnread */]).catch(() => {});
```

- [ ] **Step 4: 검사**

Run: `bun run lint && npx tsc --noEmit && bun run test`
Expected: 통과

- [ ] **Step 5: iOS 시뮬레이터 확인 (메인 앱)**

Run: `bun run ios:sim:share`
확인: 로그인 → 앱 종료(스와이프) → 재실행 시 로그인 유지 / 그룹 전환 후 재실행 시 그 그룹 유지.
(기존 iOS 기기 세션은 AsyncStorage 에 있어 1회 재로그인 필요 — 출시 전이라 마이그레이션 생략)

- [ ] **Step 6: Android 회귀**

Run: `bun run android:apk` → 기존 설치 위에 덮어 설치
확인: **로그아웃되지 않음**(같은 AsyncStorage 키), 현재 그룹 유지, Chrome → 공유 → 시트 저장 정상.

- [ ] **Step 7: 커밋**

```bash
git add src/utils/supabase/client.ts src/contexts/GroupContext.tsx src/components/sheets/SaveLinkSheet.tsx src/components/EmojiPicker.tsx src/hooks/useAuth.ts
git commit -m "feat. 세션·현재 그룹·최근 폴더를 공유 저장소로 — iOS 공유 확장과 로그인 공유"
```

---

### Task 5: ShareApp 플랫폼 중립화 + 확장 루트 연결

**Files:**
- Create: `src/share/shareHost.ts`, `src/share/shareHost.ios.ts`, `src/share/shareHost.android.ts`
- Create: `src/components/sheetOverlay.ts`
- Modify: `src/components/BottomSheet.tsx`
- Modify: `src/components/Toast.tsx`
- Modify: `src/share/ShareApp.tsx`
- Modify: `src/share/ShareExtensionRoot.tsx` (스파이크 → 실제)

**Interfaces:**
- Consumes: `extractUrl` (Task 2), `appStorage` 경유 세션 (Task 4)
- Produces: `closeShareHost(): void`, `openMainApp(): void`, `SheetOverlayContext`, `useSheetOverlay(): ReactNode`, `ExtensionToastProvider`

- [ ] **Step 1: 호스트 브리지 3종**

`src/share/shareHost.android.ts`:
```ts
import { Linking } from 'react-native';

import { closeShareSheet } from '../../modules/share-sheet';

/** 공유 시트 Activity 를 닫고 공유한 앱으로 돌아간다. */
export function closeShareHost() {
  closeShareSheet();
}

/** 메인 앱을 열고 시트를 닫는다. */
export function openMainApp() {
  Linking.openURL('moaring://').catch(() => {});
  closeShareSheet();
}
```

`src/share/shareHost.ios.ts`:
```ts
import { close, openHostApp } from 'expo-share-extension';

/** 공유 확장을 닫고 공유한 앱으로 돌아간다. */
export function closeShareHost() {
  close();
}

/** 메인 앱(moaring://)을 연다 — 확장은 네이티브가 함께 닫는다. */
export function openMainApp() {
  openHostApp('');
}
```

`src/share/shareHost.ts` (웹/타입 해석용 — Metro 는 .ios/.android 를 우선):
```ts
/** 공유 시트는 iOS/Android 전용 — 웹에서는 no-op. */
export function closeShareHost() {}

export function openMainApp() {}
```

- [ ] **Step 2: 시트 오버레이 컨텍스트** — `src/components/sheetOverlay.ts`

```ts
import { createContext, useContext, type ReactNode } from 'react';

/**
 * BottomSheet 의 Modal 안쪽 최상단에 그릴 노드.
 * iOS 공유 확장에는 시트 밖에 그릴 화면이 없어(시스템 토스트도 없음) 토스트를 시트 위에 띄우는 용도.
 */
export const SheetOverlayContext = createContext<ReactNode>(null);

export const useSheetOverlay = () => useContext(SheetOverlayContext);
```

- [ ] **Step 3: BottomSheet 에 오버레이 렌더**

`src/components/BottomSheet.tsx`:
- import 추가: `import { useSheetOverlay } from './sheetOverlay';`
- 컴포넌트 본문, `const [rendered, setRendered] = useState(visible);` 바로 아래에 `const overlay = useSheetOverlay();`
- JSX 에서 `</BottomSheetInline>` 다음 줄, `</GestureHandlerRootView>` 바로 앞에 `{overlay}` 추가.

- [ ] **Step 4: `ExtensionToastProvider`** — `src/components/Toast.tsx`

import 추가: `import { SheetOverlayContext } from './sheetOverlay';`
`NativeToastProvider` 정의 바로 아래에 추가:
```tsx
/**
 * iOS 공유 확장 전용 — 토스트를 BottomSheet(Modal) 안 오버레이로 띄운다.
 *
 * 일반 ToastProvider 는 시트(Modal) 아래에 깔려 안 보이고, iOS 에는 시스템 토스트가 없다.
 * toastBridge 에는 등록하지 않는다 — 확장 안에는 메인 앱 ToastProvider 가 없어 대상이 없음.
 */
export function ExtensionToastProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((type: ToastType, message: string, options?: { action?: ToastAction; duration?: number }) => {
    if (type === 'success') successTap();
    else warningTap();
    setToasts((prev) => [...prev, { id: ++toastId, type, message, action: options?.action, duration: options?.duration }]);
  }, []);

  const handleDone = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const overlay = toasts.length ? (
    <View style={[styles.container, { top: insets.top + 8 }]} pointerEvents="box-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDone={handleDone} />
      ))}
    </View>
  ) : null;

  return (
    <ToastContext.Provider value={{ showToast }}>
      <SheetOverlayContext.Provider value={overlay}>{children}</SheetOverlayContext.Provider>
    </ToastContext.Provider>
  );
}
```

- [ ] **Step 5: ShareApp 수정** — `src/share/ShareApp.tsx`

import 변경:
```ts
import { Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';
...
import { ExtensionToastProvider, NativeToastProvider } from '../components/Toast';
import { closeShareHost, openMainApp } from './shareHost';
```
- `import { closeShareSheet } from '../../modules/share-sheet';` 삭제
- `const OPEN_APP_URL = 'moaring://';` 삭제

파일 상단 주석 첫 줄 `공유 시트 루트 (Android \`ShareSheetActivity\` 전용, AppRegistry 이름 'share').` 를 아래로:
```
 * 공유 시트 루트 — Android `ShareSheetActivity`(AppRegistry 'share') / iOS 공유 확장(ShareExtensionRoot).
```
그리고 "메인 앱과 같은 JS 런타임이라…" 문단 끝에 추가:
```
 * iOS 확장은 별도 프로세스 — 세션·현재 그룹·최근 폴더는 appStorage(App Group)로 공유한다.
```

상수 추가 (`CLOSE_DELAY_MS` 아래):
```ts
// Android: 시스템 토스트(시트 닫힌 뒤에도 남음) / iOS 확장: 시트 위 오버레이
const ShareToastProvider = Platform.OS === 'ios' ? ExtensionToastProvider : NativeToastProvider;
// iOS 확장은 런타임 폰트 로드 불가 → 네이티브 임베드(Task 6). Android 는 기존대로 로드.
const FONT_MAP =
  Platform.OS === 'ios'
    ? {}
    : {
        LINESeedKR: require('../../assets/fonts/LINESeedKR-Rg.ttf'),
        'LINESeedKR-Bold': require('../../assets/fonts/LINESeedKR-Bd.ttf'),
      };
```
`useFonts({...})` 호출 인자를 `useFonts(FONT_MAP)` 로, JSX 의 `<NativeToastProvider>…</NativeToastProvider>` 를 `<ShareToastProvider>…</ShareToastProvider>` 로.

`ShareContent` 를 아래로 교체:
```tsx
function ShareContent({ sharedText }: ShareAppProps) {
  const { session, loading } = useAuth();
  const url = useMemo(() => extractUrl(sharedText), [sharedText]);
  const [visible, setVisible] = useState(true);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(closeShareHost, CLOSE_DELAY_MS);
  }, []);

  // Android: 링크가 아닌 텍스트 → 시트 없이 시스템 토스트 후 종료
  useEffect(() => {
    if (url || Platform.OS !== 'android') return;
    ToastAndroid.show('링크만 모아링에 저장할 수 있어요', ToastAndroid.SHORT);
    closeShareHost();
  }, [url]);

  if (!url) {
    // iOS: 시스템 토스트가 없어 안내 시트로 대신한다
    if (Platform.OS !== 'ios') return null;
    return (
      <BottomSheet visible={visible} onClose={close} title="링크만 저장할 수 있어요">
        <View style={styles.loginBody}>
          <Text style={styles.loginText}>{'공유한 내용에서 링크를 찾지 못했어요.\nhttp(s) 링크를 공유해주세요.'}</Text>
          <Button onPress={close}>닫기</Button>
        </View>
      </BottomSheet>
    );
  }

  // 세션 복원 중 — 투명 화면 유지 (보통 수십 ms)
  if (loading) return null;

  if (!session) {
    return (
      <BottomSheet visible={visible} onClose={close} title="로그인이 필요해요">
        <View style={styles.loginBody}>
          <Text style={styles.loginText}>{'모아링에 로그인하면\n공유한 링크를 바로 저장할 수 있어요.'}</Text>
          <Button onPress={openMainApp}>모아링 열기</Button>
        </View>
      </BottomSheet>
    );
  }

  return <SaveLinkSheet visible={visible} onClose={close} initialUrl={url} />;
}
```
(`Linking` import 는 더 이상 안 쓰므로 제거됨)

- [ ] **Step 6: 확장 루트 교체** — `src/share/ShareExtensionRoot.tsx` 전체

```tsx
import React from 'react';

import type { InitialProps } from 'expo-share-extension';

import ShareApp from './ShareApp';

/**
 * iOS 공유 확장 루트 (AppRegistry 'shareExtension', index.share.js).
 * Safari 공유 → url, 메모·메신저 텍스트 공유 → text. 이후 흐름은 Android 와 같은 ShareApp.
 */
export default function ShareExtensionRoot({ url, text }: InitialProps) {
  return <ShareApp sharedText={url ?? text} />;
}
```

- [ ] **Step 7: 검사**

Run: `bun run lint && npx tsc --noEmit && bun run test`
Expected: 통과

- [ ] **Step 8: 시뮬레이터 확인**

Run: `bun run ios:sim:share` → 메인 앱 로그인 → Safari `https://example.com` 공유 → 모아링
Expected: Safari 위에 **SaveLinkSheet**(현재 그룹 폴더 목록) 표시 → 폴더 선택·저장 → 시트 내려가고 Safari 복귀 → 앱에서 링크 확인.

- [ ] **Step 9: Android 회귀**

Run: `bun run android:apk`
확인: Chrome 공유 → 시트 저장 / 일반 텍스트 공유 → "링크만 모아링에 저장할 수 있어요" 토스트 / 로그아웃 상태 공유 → "모아링 열기" 로 앱 열림.

- [ ] **Step 10: 커밋**

```bash
git add src/share src/components/sheetOverlay.ts src/components/BottomSheet.tsx src/components/Toast.tsx
git commit -m "feat. iOS 공유 확장에서 Android 와 같은 저장 바텀시트 — ShareApp 플랫폼 중립화"
```

---

### Task 6: 확장용 폰트 임베드

iOS 확장은 런타임 폰트 로드(`useFonts`)를 지원하지 않는다(expo-share-extension README). 네이티브 임베드 폰트만 확장 타깃에 복사되는데, 원본 PostScript 이름은 `LINESeedSansKR-Regular` / `LINESeedSansKR-Bold` 라 코드의 `fontFamily: 'LINESeedKR' | 'LINESeedKR-Bold'` 와 다르다 → PostScript 이름을 바꾼 사본을 임베드한다 (RN iOS 는 `UIFont fontWithName:` 으로 PostScript 이름 매칭).

**Files:**
- Create: `scripts/rename-ios-fonts.py`
- Create: `assets/fonts/ios/LINESeedKR.ttf`, `assets/fonts/ios/LINESeedKR-Bold.ttf` (생성물, 커밋)
- Modify: `app.config.js`

- [ ] **Step 1: 스크립트** — `scripts/rename-ios-fonts.py`

```python
"""iOS 임베드용 LINE Seed 사본 생성 — PostScript 이름을 코드의 fontFamily 와 맞춘다.

사용: (레포 루트에서) python -I scripts/rename-ios-fonts.py   # fontTools 필요
원본 PostScript 이름(LINESeedSansKR-Regular/Bold) ≠ 코드의 'LINESeedKR'/'LINESeedKR-Bold'.
iOS 공유 확장은 런타임 폰트 로드가 안 돼 임베드 폰트를 PostScript 이름으로 찾는다.
"""
from pathlib import Path

from fontTools.ttLib import TTFont

SOURCES = {
    "assets/fonts/LINESeedKR-Rg.ttf": "LINESeedKR",
    "assets/fonts/LINESeedKR-Bd.ttf": "LINESeedKR-Bold",
}
OUT_DIR = Path("assets/fonts/ios")

OUT_DIR.mkdir(parents=True, exist_ok=True)
for src, name in SOURCES.items():
    font = TTFont(src)
    table = font["name"]
    # 타이포그래픽 패밀리(16/17)가 남으면 두 파일이 한 패밀리로 묶여 이름 매칭이 흔들린다
    table.names = [n for n in table.names if n.nameID not in (16, 17)]
    for name_id, value in ((1, name), (2, "Regular"), (3, name), (4, name), (6, name)):
        table.setName(value, name_id, 3, 1, 0x409)  # Windows
        table.setName(value, name_id, 1, 0, 0)  # Mac
    out = OUT_DIR / f"{name}.ttf"
    font.save(out)
    print(f"{src} -> {out} (PostScript: {name})")
```

- [ ] **Step 2: 생성 (스크래치 venv)**

```bash
python3 -m venv "$TMPDIR/fontenv" && "$TMPDIR/fontenv/bin/pip" install -q fonttools
"$TMPDIR/fontenv/bin/python" -I scripts/rename-ios-fonts.py
"$TMPDIR/fontenv/bin/python" -I -c "from fontTools.ttLib import TTFont; [print(f, TTFont(f)['name'].getDebugName(6)) for f in ('assets/fonts/ios/LINESeedKR.ttf','assets/fonts/ios/LINESeedKR-Bold.ttf')]"
```
Expected:
```
assets/fonts/ios/LINESeedKR.ttf LINESeedKR
assets/fonts/ios/LINESeedKR-Bold.ttf LINESeedKR-Bold
```

- [ ] **Step 3: 임베드** — `app.config.js` 의 `if (enableIosShareExt) {` 블록에서 `'expo-share-extension'` 항목 **앞에** 추가 (expo-share-extension 이 expo-font 플러그인의 `fonts` 를 읽어 확장 타깃에 복사)

```js
      // 확장 타깃은 임베드 폰트만 쓸 수 있다 (scripts/rename-ios-fonts.py 참고)
      ['expo-font', { fonts: ['./assets/fonts/ios/LINESeedKR.ttf', './assets/fonts/ios/LINESeedKR-Bold.ttf'] }],
```

- [ ] **Step 4: 확인**

Run: `bun run ios:sim:share:prebuild`
확인:
1. 공유 확장 시트 제목·폴더명이 LINE Seed 글꼴 (스파이크 D2 와 비교 스크린샷).
2. **메인 앱**도 정상 글꼴 + Metro 로그에 폰트 에러로 앱이 멈추지 않음. (임베드 폰트와 `App.tsx` 의 `useFonts` 별칭이 같은 이름 — `useFonts` 가 "already registered" 류 에러를 내도 `App.tsx:28` 이 `fontsError` 시 진행하므로 렌더는 정상이어야 함. 에러 로그가 보이면 스파이크 문서에 기록.)

- [ ] **Step 5: 커밋**

```bash
git add scripts/rename-ios-fonts.py assets/fonts/ios app.config.js
git commit -m "feat. iOS 공유 확장용 LINE Seed 임베드 폰트 (PostScript 이름 정렬)"
```

---

### Task 7 (조건부): 확장 텍스트 크기 보정 — 스파이크 D1 이 ❌ 일 때만

expo-share-extension README: 확장 안에서 RN 기본 `Text`/`TextInput` 이 폰트 스케일링 문제로 깨진다(`allowFontScaling={false}` 필요). 앱 전체 `Text` import 를 바꾸지 않고, 확장 번들에서만 RN 의 Text/TextInput 기본 export 를 감싼다.

**Files:**
- Create: `src/share/patchTextForExtension.tsx`
- Modify: `index.share.js`

- [ ] **Step 1: 패치 모듈** — `src/share/patchTextForExtension.tsx`

```tsx
import React, { forwardRef } from 'react';

/**
 * iOS 공유 확장 전용 — RN Text/TextInput 기본 export 를 allowFontScaling={false} 로 감싼다.
 * 확장에는 UIApplication 이 없어 폰트 스케일 계산이 깨진다 (expo-share-extension README).
 * react-native 의 `Text` getter 는 매 접근마다 이 모듈의 default 를 읽으므로,
 * 다른 모듈이 import 하기 전에(index.share.js 최상단) 바꿔치기하면 전체에 적용된다.
 */
function patch(modulePath: { default: React.ComponentType<any> }) {
  const Original = modulePath.default;
  const Patched = forwardRef<unknown, any>((props, ref) => <Original {...props} ref={ref} allowFontScaling={false} />);
  Patched.displayName = Original.displayName;
  modulePath.default = Patched;
}

patch(require('react-native/Libraries/Text/Text'));
patch(require('react-native/Libraries/Components/TextInput/TextInput'));
```

- [ ] **Step 2: 엔트리 최상단에서 로드** — `index.share.js` 첫 줄에 추가

```js
import './src/share/patchTextForExtension'; // 반드시 첫 import (Task 7)
```

- [ ] **Step 3: 확인**

Run: `bun run ios:sim:share` → 공유 → 시트의 모든 텍스트·입력창(새 폴더 이름) 정상 크기.
패치가 적용 안 되면(`default` 가 읽기 전용이라 TypeError) 스파이크 문서에 에러 원문 기록 후 사용자와 재논의.

- [ ] **Step 4: 커밋**

```bash
git add src/share/patchTextForExtension.tsx index.share.js
git commit -m "fix. iOS 공유 확장에서 텍스트 크기 깨짐 — 확장 번들 한정 allowFontScaling 고정"
```

---

### Task 8: 시뮬레이터 E2E 검증 + 문서

**Files:**
- Modify: `README.md` (빌드 표, 공유 기능 설명)
- Modify: `docs/superpowers/specs/2026-11-01-ios-share-extension-spike.md` (E2E 결과 추가)

- [ ] **Step 1: Release 시뮬레이터 빌드**

Run: `CONFIG=Release bun run ios:sim:share`

- [ ] **Step 2: E2E 체크리스트** — 결과를 스파이크 문서 하단 "E2E" 표에 ✅/❌ 기록

| # | 시나리오 | 기대 결과 |
| --- | --- | --- |
| 1 | 앱에서 그룹 B 선택 → Safari 링크 공유 | 시트에 그룹 B 폴더, 최근 폴더 기본 선택 |
| 2 | 폴더 선택 → 저장 | 시트 내려가고 Safari 복귀, 앱에 링크 존재 |
| 3 | 메모 앱 "이거 봐 https://example.com" 공유 | 시트에 `https://example.com` |
| 4 | 메모 앱 "hello" 공유 | "링크만 저장할 수 있어요" 안내 시트 → 닫기 |
| 5 | 앱 로그아웃 → 공유 | "로그인이 필요해요" → "모아링 열기" 로 앱 열림 |
| 6 | 시트에서 새 폴더 → 이름 비우고 저장 | "폴더 이름을 입력해주세요" 토스트가 **시트 위에** 보임 |
| 7 | 시트에서 새 폴더 만들어 저장 | 앱 복귀 시 새 폴더·링크 보임 (React Query 는 앱 재조회로 반영) |
| 8 | 앱 완전 종료 상태에서 공유 → 저장 | 정상 (세션을 App Group 에서 읽음) |
| 9 | 메모리 (Release, 시나리오 1 시트 열린 상태) | Xcode Attach → 값 기록, 100MB 미만 |
| 10 | 다음 날(액세스 토큰 만료 후) 앱 열지 않고 공유 → 저장 | 정상 저장, 이후 앱 열어도 로그인 유지 (토큰 갱신 공유) |

- [ ] **Step 3: README 갱신**

`README.md` 빌드 표(144행 근처) 아래에 추가:
```markdown
### iOS 공유 확장 (Apple Developer 멤버십 전: 시뮬레이터 전용)

| 상황 | 명령 |
| --- | --- |
| 최초 / 플러그인·네이티브 모듈 변경 | `bun run ios:sim:share:prebuild` |
| JS 만 수정 | `bun run ios:sim:share` |
| 메모리 측정 | `CONFIG=Release bun run ios:sim:share` |

- `IOS_SHARE_EXT=1` 일 때만 Share Extension 타깃 생성. 실기기 `ios:release` 로 돌아갈 땐 `bun run ios:release:clean` 필수 (무료 Personal Team 은 App Group 불가).
- 세션·현재 그룹·최근 폴더는 `appStorage`(iOS: App Group `group.dev.inak.moaring`)에 저장 — 확장과 공유.
- 확장 폰트는 `assets/fonts/ios/` 임베드본 (`scripts/rename-ios-fonts.py`).
```

- [ ] **Step 4: 커밋**

```bash
git add README.md docs/superpowers/specs/2026-11-01-ios-share-extension-spike.md
git commit -m "chore. iOS 공유 확장 E2E 결과 + README 빌드 안내"
```

---

### Task 9 (선택): 실기기 스모크 — App Group 없이 메모리·표시 확인

시뮬레이터는 확장 메모리 한도를 강제하지 않는다. 멤버십 결제 전에 실기기에서 한도 안에 드는지 보려면 App Group entitlement 만 빼고 설치한다 (세션 공유는 안 되므로 "로그인이 필요해요" 시트까지만 확인 가능).

**Files:**
- Create: `scripts/build-ios-device-share-smoke.sh`
- Modify: `package.json` (scripts)

- [ ] **Step 1: 스크립트** — `scripts/build-ios-device-share-smoke.sh` (+ `chmod +x`)

```bash
#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# iOS 공유 확장 실기기 스모크 (선택) — App Group entitlement 를 빼고 무료 Personal Team 으로 설치.
# 목적: 실기기 메모리 한도(~120MB)·표시 확인. 세션 공유는 안 됨 → 로그인 필요 시트까지만.
# 끝나면 bun run ios:release:clean 으로 원복.
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/check-env.js

DEVICE="${DEVICE:-유인학의 iPhone}"
export IOS_SHARE_EXT=1

npx expo prebuild -p ios --clean
node -e "
  const fs = require('fs');
  const f = 'ios/Podfile.properties.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j['ios.buildReactNativeFromSource'] = 'true';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
"

echo "✂️  App Group entitlement 제거 (무료 팀 프로비저닝 불가)"
find ios -name '*.entitlements' -not -path 'ios/Pods/*' -print0 |
  while IFS= read -r -d '' f; do
    plutil -remove com.apple.security.application-groups "$f" 2>/dev/null || true
  done

npx pod-install
npx expo run:ios --device "$DEVICE" --configuration Release
```

`package.json` scripts 에 추가:
```json
    "ios:device:share-smoke": "bash scripts/build-ios-device-share-smoke.sh",
```

- [ ] **Step 2: 실행·측정**

Run: `bun run ios:device:share-smoke`
확인: Safari 공유 → 모아링 → (로그인 필요) 시트 표시. Xcode → Debug → Attach to Process → `ShareExtension` → Memory 값을 스파이크 문서에 기록.
주의: 실제 저장 시트(SaveLinkSheet)는 이보다 무겁다 — 로그인 시트 기준 80MB 이상이면 위험 신호로 기록.

- [ ] **Step 3: 원복 + 커밋**

```bash
bun run ios:release:clean
git add scripts/build-ios-device-share-smoke.sh package.json
git commit -m "chore. iOS 공유 확장 실기기 스모크 스크립트 (App Group 제외)"
```

---

## 멤버십 가입 후 (이 계획 범위 밖, 메모)

1. Apple Developer 에서 App ID `dev.inak.moaring`·`dev.inak.moaring.ShareExtension` 에 App Groups(`group.dev.inak.moaring`) 활성화.
2. `IOS_SHARE_EXT` 기본 활성화 → `build-ios-device.sh` 에서도 export.
3. 실기기에서 Task 8 체크리스트 재실행 (특히 9 메모리, 10 토큰 갱신).
4. Apple 로그인 복원 등 나머지 출시 준비 (이전 iOS 출시 계획).
