---
name: release-android
description: 모아링 Android 릴리스. 버전·versionCode 올림 → 서명된 AAB 빌드 → 서명·버전 검증 → 출시 노트 초안 → (사용자 확인 후) Play Console 업로드·단계별 출시. "안드로이드 출시", "릴리스", "AAB 빌드" 때 사용. 인자로 새 버전(예: 0.0.9) 을 받을 수 있음.
---

# release-android

Play Console 업로드·게시는 **사용자가 문구·트랙·비율을 확인한 뒤에만** 한다.

## 1. 사전 확인
- 현재 브랜치 `develop`, 작업 트리 깨끗(`git status --porcelain` 비어 있음, `supabase/.temp/` 제외).
- `bunx tsc --noEmit -p .` 통과. `bun run lint` 는 `--max-warnings 0` 이라 경고 1개도 exit 1 — 새 경고가 아니면(알려진: Toast.tsx:60) 기록만 하고 진행, 새 경고·에러면 중단.
- 현재 버전: `jq -r '.expo.version, .expo.android.versionCode' app.json`.
- Play Console 에 올라간 최고 versionCode 를 사용자에게 확인받는다 (기록: 0.0.7 = 7 Alpha 업로드; 0.0.8 = 8 미업로드 — 2026-11-17 기준).

## 2. 버전 올림
새 버전 V(인자 또는 patch+1), 새 versionCode N(현재+1):
```bash
OLD_V=$(jq -r .expo.version app.json); OLD_N=$(jq -r .expo.android.versionCode app.json)
sed -i '' "s/\"version\": \"$OLD_V\"/\"version\": \"$V\"/; s/\"versionCode\": $OLD_N/\"versionCode\": $N/" app.json
sed -i '' "s/\"version\": \"$OLD_V\"/\"version\": \"$V\"/" package.json
sed -i '' "s/모아링 v[0-9.]*/모아링 v$V/" src/screens/ProfileScreen.tsx
git diff --stat   # 3 files, app.json 은 정확히 2줄 변경
git add app.json package.json src/screens/ProfileScreen.tsx
git commit -m "chore. $V 릴리스 — 버전·versionCode $N 반영"
```
(이미 올려둔 상태면 이 단계 생략.)
주의: app.json 은 jq 로 다시 쓰지 않는다 (인라인 `"scheme": ["moaring"]` 이 펼쳐져 diff 가 커진다).

## 3. AAB 빌드
로그는 scratchpad 에:
```bash
bash scripts/build-android-aab.sh prebuild > <scratchpad>/aab.log 2>&1; echo EXIT $?
tail -5 <scratchpad>/aab.log
```
백그라운드 실행 권장 (20분 이상). 실패 시 `grep -n "What went wrong" -A5` 만 보고.

## 4. 검증
```bash
AAB=android/app/build/outputs/bundle/release/app-release.aab
grep -n "versionCode\|versionName" android/app/build.gradle | head -2     # N, "V"
keytool -printcert -jarfile $AAB | grep "SHA256:"                         # 기대값 DE:60:5B:C0:F9:4E:34:79:3A:52:4F:C4:FA:33:ED:67:E2:5F:F1:BC:ED:3C:1B:0B:F8:84:F6:F5:D7:3F:08:AE (공개 인증서 지문). 다르면 중단하고 보고
keytool -printcert -jarfile $AAB | grep -ci "android debug"               # 0 이어야 함
ls -la "dist/모아링_$V.aab"
```
debug 키면 중단하고 `docs/android-signing-guide.md` 안내.

## 5. 출시 노트 초안
- `git log <이전 태그 또는 이전 릴리스 커밋>..HEAD --oneline` 과 BACKLOG `done` 항목에서 사용자 체감 변화만 골라 3~5줄.
- 형식:
```
<ko-KR>
- …
</ko-KR>
```
- 500자 이내. 내부 용어(마이그레이션, 리팩터) 금지.

## 6. 사용자 확인 → 업로드
사용자에게 제시: AAB 경로, versionCode, 서명 지문, 출시 노트, 트랙(기본 프로덕션), 비율(기본 20%).
확인을 받으면 claude-in-chrome 으로 Play Console → 프로덕션 → 새 버전 만들기 → AAB 업로드(file_upload) → 출시 노트 입력 → 단계별 출시 비율 입력 → 검토 화면까지.
**"출시 시작" 직전 요약을 다시 보여주고 명시적 확인을 받은 뒤 클릭.**

## 7. 마무리
- `git tag v$V && git push origin develop --tags` (사용자 확인 후).
- `develop → main` PR 생성 여부 사용자에게 확인.
- 보고: 게시 상태, 비율, 다음 확대 시점(2~3일 후 비정상 종료율 확인).
