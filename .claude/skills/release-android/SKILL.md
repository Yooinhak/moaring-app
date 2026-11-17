---
name: release-android
description: 모아링 Android 릴리스. 버전·versionCode 올림 → 서명된 AAB 빌드 → 서명·버전 검증 → 출시 노트 초안 → (사용자 확인 후) Play Console 업로드·단계별 출시. "안드로이드 출시", "릴리스", "AAB 빌드" 때 사용. 인자로 새 버전(예: 0.0.9) 을 받을 수 있음.
---

# release-android

Play Console 업로드·게시는 **사용자가 문구·트랙·비율을 확인한 뒤에만** 한다.

## 1. 사전 확인
- 현재 브랜치 `develop`, 작업 트리 깨끗(`git status --porcelain` 비어 있음, `supabase/.temp/` 제외).
- `bunx tsc --noEmit -p .` 와 `bun run lint` 통과.
- 현재 버전: `jq -r '.expo.version, .expo.android.versionCode' app.json`.
- Play Console 에 이미 올라간 최고 versionCode 보다 커야 한다 (모르면 사용자에게 확인).

## 2. 버전 올림
새 버전 V(인자 또는 patch+1), 새 versionCode N(현재+1):
```bash
jq --arg v "$V" --argjson n "$N" '.expo.version=$v | .expo.android.versionCode=$n' app.json > app.json.tmp && mv app.json.tmp app.json
jq --arg v "$V" '.version=$v' package.json > package.json.tmp && mv package.json.tmp package.json
sed -i '' "s/모아링 v[0-9.]*/모아링 v$V/" src/screens/ProfileScreen.tsx
git diff --stat   # 3 files
git add app.json package.json src/screens/ProfileScreen.tsx
git commit -m "chore. $V 릴리스 — 버전·versionCode $N 반영"
```
(이미 올려둔 상태면 이 단계 생략.)
주의: `jq` 가 app.json 들여쓰기를 2칸으로 다시 쓴다 — 기존과 같으면 diff 는 두 줄뿐이어야 한다. 더 바뀌면 되돌리고 sed 로 두 줄만 수정.

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
keytool -printcert -jarfile $AAB | grep SHA256                            # 업로드 키 지문
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
