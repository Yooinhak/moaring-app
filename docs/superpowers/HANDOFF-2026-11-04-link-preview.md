# 인계·운영: 링크 미리보기 서버 수집 `link-preview` (2026-11-04)

이 문서 하나로 (1) 아직 안 한 수동 단계를 끝까지 수행하고, (2) 배포 뒤 무엇을 보고 무엇을 고칠지 판단할 수 있게 쓴 운영 문서.
설계 원문은 `docs/superpowers/plans/2026-11-04-link-preview-design.md` 에 있고(§4 의 SQL 전문은 실제 005 파일과 동기), 운영에 필요한 내용은 전부 여기에도 옮겼다.
코드는 모두 레포에 있고(아래 §1), 이 문서는 **실제 파일을 읽고** 썼다 — 설계와 코드가 다른 곳은 코드 기준으로 적고 §13 에 표시했다.

> `.gitignore` 가 README 외 모든 `*.md` 를 무시한다. 이 문서와 설계 문서는 `git add -f docs/superpowers/HANDOFF-2026-11-04-link-preview.md docs/superpowers/plans/2026-11-04-link-preview-design.md` 로 넣는다.

---

## 0. 바로 할 일 (요약)

현재 develop 작업 트리에 **미커밋** 변경이 있다(`git status`: 수정 19개 + 신규 5개). 라이브 Supabase 에는 아직 아무것도 적용되지 않았다.
2026-11-04 저녁 적대적 코드 리뷰(확정 38건)를 코드에 반영했고, 이 문서는 그 결과 기준이다 — 무엇이 바뀌었는지는 §13 "해결됨" 블록.

1. §4 체크리스트를 위에서부터. 순서가 중요하다: **005 SQL → 함수 배포 → (권장) 비밀 등록 → 타입 재생성 → 라이브 검증 → 커밋**. **새 앱은 005 를 요구한다**(§9 호환성) — 앱을 먼저 깔면 공유 텍스트 힌트가 있는 저장이 실패한다.
2. 로컬 검증은 이미 통과 상태 (2026-11-04 21:50 기준):
   - `bun test supabase/functions/link-preview` → 398 pass / 0 fail (14 파일)
   - `bunx tsc --noEmit -p .` → 통과
   - `bun run lint` → 경고 1개 (`src/components/Toast.tsx:60`, 이번 작업과 무관한 기존 경고 — §13)
3. §10 의 결정 4개는 사용자(개발자 본인) 몫. 기본값대로 가면 "비밀 등록 O, 인스타 캡션 전체 저장 X, WebView 러너 v2, pg_cron·Microlink 미사용".

---

## 1. 지금 레포에 있는 것 (파일 지도)

### DB
| 파일 | 내용 |
|---|---|
| `supabase/migrations/005_link_previews.sql` | ① `posts.preview_*` 16컬럼 + CHECK 3개(status 6값·https·길이) ② 큐/canonical 부분 인덱스 ③ **컬럼 단위 GRANT**(authenticated insert = url/description/folder_id/preview_title, update = description/folder_id) ④ RPC `claim_post_preview(p_post_id, p_force)` / `pick_preview_jobs(p_limit)` (service_role 전용; stale fetching 재선점은 **attempts < 5** 까지만, RETURNING 은 `id::bigint, url::text, folder_id::bigint` 전부 명시 캐스트, 스윕은 `needs:%`·`device_*` failed 제외) ⑤ `preview_image_tombstones` + 트리거 2개 ⑥ Storage 버킷 `link-previews`(공개, 3 MB, jpeg/png/webp/gif/avif) ⑦ `enqueue_link_preview()` AFTER INSERT 트리거(pg_net + Vault, 비밀 없으면 조용히 통과). 맨 아래 주석에 수동 1·2단계·검증·되돌리기 SQL(되돌리기는 `cron.unschedule` 부터 — **앱을 먼저 되돌린 뒤** 실행, §9 호환성) |

### Edge Function `supabase/functions/link-preview/` (Deno; 순수 모듈은 bun 으로 테스트)
| 파일 | 역할 |
|---|---|
| `index.ts` | 진입점(`@ts-nocheck`, std@0.224 `serve`, esm.sh supabase-js@2.45.4). 인증 두 갈래 + 모드 라우팅(`fetch`·`assist`·`webhook`·`sweep`) + 바디 캡(8 KB, assist 320 KB) + 응답 끝 tombstone GC 10건. fetch 에 `device`/`force` 가 실리면 assist 와 같은 **owner/editor 게이트**(`editorDenial` → 403 `forbidden`; `post_ids` 와 함께면 400), 단건 + device 가 선점 경합에 밀리면 `rescueDeviceHints`(≤10 s 폴링 → needs_client/failed 면 `applyAssist`) |
| `process.ts` | 처리 핵심 `processPost` / `processMany(WithBudget)` / `applyAssist`. claim → canonical 재활용(7일) → 어댑터 run → 폰 힌트 병합 → 제목 힌트 → 이미지 복사 → 단일 UPDATE. `applyCaptionPolicy`(인스타 `device.description` 은 `INSTAGRAM_STORE_CAPTION=full` 일 때만) · `isSameSiteUrl`(폰 canonical·제출 HTML og:url 은 posts.url 과 같은 사이트일 때만 — findDonor 오염 방지) |
| `types.ts` | 공유 계약: `PREVIEW_STATUSES`, `PREVIEW_SOURCES`, `SiteAdapter`(`serverFetch`, `imageHosts`), `DeviceHints`, `Req`/`Res`, `BUDGET`(HTML 1 MiB·10 s, 이미지 3 MiB·8 s, 단건 25 s, 배치 8·동시 2, 홉 8, force 쿨다운 60 s, stale 2분, 최대 attempts 5) |
| `fetch.ts` | `createPreviewIO` — 스트림 캡·`</head>` 조기중단·manual 리다이렉트(홉마다 SSRF)·`readCapped` |
| `ssrf.ts` | fail-closed SSRF: 스킴/포트/userinfo, 호스트 블록(localhost·*.internal·metadata·자기 supabase), `Deno.resolveDns` → DoH(cloudflare-dns) 폴백, 사설/링크로컬/NAT64 등 차단 |
| `image.ts` | 후보 순회 → SSRF → imageHosts → GET → 매직바이트(SVG 거부) → `posts/<post_id>/<sha256 16>.<ext>` upsert → public URL. `copyExistingImage`(canonical 재활용 storage.copy), `removeTombstones`(행 삭제 RETURNING 으로 선점 → `posts.preview_image_path` 가 아직 가리키는 경로는 건너뜀 → 나머지만 `storage.remove`; remove 실패는 재시도 없이 고아로 남고 로그만) |
| `html.ts` `charset.ts` `entities.ts` `canonical.ts` `placeholders.ts` | 메타 파서(속성 순서 무관, `findTagEnd` 가 따옴표 안의 `>` 를 건너뜀), charset(**BOM→헤더→meta**→utf-8 fatal→euc-kr, ms949/ksc5601 매핑), 엔티티 디코드, 추적 파라미터 제거, 플레이스홀더 이미지 목록, 차단 시그니처(`detectBlockPage`), SPA 셸 판정. 보일러플레이트 설명 제거는 명시 패턴(`BOILERPLATE_DESCRIPTION_PATTERNS`, 컬리)만 — "og:type=website 이고 og:description == meta description" 추론은 뺐다 |
| `sites/index.ts` | 어댑터 레지스트리 `ADAPTERS`(순서 = 우선순위, generic 마지막), `resolveAdapter`, 폰 HTML 파서 `PARSERS`(generic / instagram_embed / tiktok_ssr) |
| `sites/*.ts` | 어댑터. provider id ↓ |
| `__tests__/*.test.ts` | bun 테스트 14 파일 398 개 (`bun:test` import — deno 로는 돌리지 않음). `x.test.ts`·`misc.test.ts` 의 가짜 io 는 fetch.ts 의 리다이렉트 의미(홉 ≥1 이 hopAllow 밖이면 `ssrf:hop_host`, `firstHopOnly` 는 첫 Location 만 돌려줌)를 그대로 재현한다 |

provider id(= `posts.preview_provider`) 와 `serverFetch` 플래그:

| provider | 파일 | serverFetch | 메모 |
|---|---|---|---|
| `coupang` | coupang.ts | link.coupang.com 어댑터 **true**(Location 1홉만 읽음, 본문 0 B) / 상품 페이지 어댑터 **false** | 힌트 없으면 '쿠팡 상품 <pid>', `needs:webview` |
| `naver_me` `naver_blog` `naver_news` `naver_cafe` | naver.ts | true | naver.me 1홉 Location, 블로그 m. 재작성, 카페는 카페명만(euc-kr). 카페 글 폼: `/<cafe>/<id>` · `/ca-fe\|f-e/cafes/<clubid>/articles/<id>`(2024 PC 개편 주소창 폼, canonical 은 `ca-fe` 폼) · `ArticleRead.nhn?clubid&articleid`. 글이 아닌 카페 홈/게시판은 canonical = 자기 URL(호스트만 데스크톱, 추적 파라미터 제거) 이라 서로 donor 가 되지 않고, clubid 만 아는 게시판은 제목 null |
| `naver_map` | naver.ts | **false** | 지도 og 이미지 + '네이버 지도', 제목 없으면 `needs:webview` |
| `naver_shop` | naver.ts | **false** | `blocked:naver_shop` → 폰 fetch 1회 과제 |
| `instagram` `threads` | instagram.ts | true | `/p/<code>/embed/captioned/` 파싱, 캡션 전체는 `INSTAGRAM_STORE_CAPTION=full` 일 때만(폰 힌트의 description 도 같은 정책 — 서버가 버린다). `/reels/audio/<id>/` 등 예약어(audio·embed·explore·videos)는 shortcode 가 아니라 generic 으로 |
| `youtube` | youtube.ts | true | oEmbed + i.ytimg 썸네일 HEAD 200 만 |
| `x` | x.ts | true | t.co 는 **첫 Location 만**(firstHopOnly, hopAllow 없음) 읽고 호스트로 분기 — X 호스트면 status/profile 흐름, 외부 사이트면 `runGeneric`(SSRF·홉 검사는 generic fetch 가). t.co→t.co 는 3회까지(`tco_unresolved`), 404/410 → `gone`. 404 게이트, oEmbed 병행 |
| `tiktok` | tiktok.ts | true | SSR JSON, WAF 스텁 → needs_client |
| `kakao_place` `kakao_short` `brunch` `tistory` `velog` `daum_cafe` `ohou` `kurly` `daangn` | kakao.ts | true | generic + 사이트별 remap |
| `blocked` | misc.ts | **false** | 무신사·29CM: 슬러그 제목 + `blocked:cloudflare` |
| `slug` | misc.ts | **false** | Medium·*.notion.site: 슬러그 제목으로 ready |
| `reddit` `pinterest` `facebook` `linkedin` `oembed`(vimeo/spotify/soundcloud/flickr) | misc.ts | true | Reddit 앱 공유 링크 `/r/<sub>/s/<id>` 는 첫 Location 으로 permalink 를 얻어 canonical 로(같은 글이 하나로 모임; reddit 밖이면 `offsite_redirect`, 404/410 `gone`, 리다이렉트 없음 `reddit_unresolved`). `lnkd.in` 도 첫 Location 만 — LinkedIn 호스트면 LinkedIn 흐름, 외부 기사면 `runGeneric`, lnkd.in→lnkd.in/무응답 `lnkd_unresolved` |
| `generic` | generic.ts | true | 그 외 전부 (match `() => true`) |

### Edge Function `supabase/functions/delete-account/index.ts`
- 신규 `cleanupPreviewImages()` — 계정 삭제 전에 그 사용자 posts 의 `preview_image_path` 를 1000건 페이지로 읽어 `link-previews` 버킷에서 100개씩 remove. 실패해도 계속(005 미적용이면 select 실패 → 그냥 통과). **재배포 필요**(§4-6).

### 앱 (`src/`)
| 파일 | 변경 |
|---|---|
| `utils/preview/types.ts` (신규) | `PREVIEW_STATUSES`, `DeviceHints`/`DeviceAssistHints`, `PreviewResult`/`PreviewResponse`, `isPreviewLoading`(pending 10분·fetching 2분 창), `canRetryPreview`(= failed 만), `TRANSIENT_PREVIEW_ERRORS`(timeout·http_5xx·dns_failed·**network·fetch_failed**·unexpected) + `isTransientFailure`, `normalizeForCompare`(중복 저장 검사 전용) |
| `utils/preview/invoke.ts` (신규) | `requestPreviewFetch(postId, device?, force?)`, `requestPreviewBatch(ids, onChunk)`(8개씩 순차, 청크 error 에서 멈추고 `onChunk(result, ids)` 로 알림), `requestPreviewAssist(postId, device)` — 전부 `supabase.functions.invoke('link-preview')`, 바디에 URL 없음 |
| `hooks/queries/usePreview.ts` (신규) | `useRefreshPreview(folderId)` — `onMutate` 에서 `forgetPreviewRetryState(postId)` + fetching 낙관 갱신 → 폰 `parseOnDevice`(4 s) → **요청 직전에 낙관 행을 한 번 더 세움**(폴링이 되돌렸을 수 있음) → `fetch force`. 토스트는 `results[0]` 으로 가른다: `ready` → '미리보기를 다시 불러왔어요', `in_progress`/fetching/pending → '이미 불러오는 중이에요'(폴링이 채움), failed·unsupported·needs_client·not_found → '미리보기를 불러오지 못했어요'. 429/`cooldown` → '잠시 후 다시 시도해주세요', 403/`forbidden` → '미리보기를 다시 불러올 권한이 없어요'. onError 는 그 행만 되돌리고 `onSettled` 가 POST_LIST + GROUP_ACTIVITY invalidate. `PreviewCooldownError`/`PreviewForbiddenError` |
| `hooks/usePreviewCatchUp.ts` (신규) | 폴더 진입 catch-up(**유일한 백필·재시도 경로**). (1) pending·일시 failed(attempts<3)·stale fetching → `fetch post_ids` 최신순 최대 24건(8×3), 청크마다 invalidate — **폴더당 배치 하나**(`fetchInFlight`), 끝나면 invalidate 로 다음 24건을 잇는다 (2) `canEdit` 이면 needs_client → `parseOnDevice`(8 s, 동시 2, 8건, 폴더당 묶음 하나) → `assist`(빈 결과도 보냄 — 단 폰 타임아웃(`timedOut`)·화면 이탈로 끊긴 빈 결과는 보내지 않음). `needs:webview`/provider ∈ {coupang, naver_map} 은 건너뜀(스마트스토어 `blocked:naver_shop` 은 설계대로 폰 fetch 1회 시도). 모듈 Set 은 **서버에 닿은 요청만** 기억 — 전송 실패(오프라인·401·미배포)한 id 는 빼서 다음 평가에 다시 보내고, `forgetPreviewRetryState(postId)` 로 수동 재시도 뒤 다시 대상이 된다. invalidate 는 POST_LIST + GROUP_ACTIVITY |
| `utils/parseMetadata.ts` (전면 재작성) | `parseMetadata`(SaveLinkSheet 저장 전 미리보기) + `parseOnDevice`(assist/재시도) + `toDeviceHints`. Microlink 제거, UA 미설정, euc-kr 라벨이면 텍스트 null. 쿠팡·Medium·Notion·네이버 지도/플레이스/카페는 즉시 빈 결과, YouTube 는 oEmbed, 인스타는 임베드 파싱(html 동봉, description 에 캡션을 보내지만 서버가 §10-2 정책으로 버린다), TikTok 은 **영상 URL(/video/<id>·vm/vt·/t/) 만** SSR, 그 외 *.tiktok.com 은 generic og. 상한: content-length 2 MB 를 `text()` 전에 확인, 스캔 1 MiB, 태그 속성 16 KB(ATTR_RE 선형), 인스타 캡션 64 KB + CaptionComments 없으면 첫 `</div>`, URL 힌트 2048자, 자르기는 코드포인트 단위(서로게이트 안 깨짐), 결과 `timedOut` 플래그 |
| `components/LinkPreviewCard.tsx` | 네트워크 호출 제거. `preview*` props 만 그림. 스켈레톤은 `isPreviewLoading` 창 안에서만, 그 외 전부 도메인 카드(`previewSiteName || domainInfo 라벨`, `previewTitle || domain`, 부제 `description || author`). https 외 이미지 미렌더. failed 카드에 '미리보기 다시 불러오기' 링크. `React.memo` — 부모 콜백이 안정적이어야 한다 |
| `hooks/queries/usePosts.ts` | `usePostsQuery.refetchInterval` = 로딩 행 있으면 3000 아니면 false. `useCreatePost` 가 `insert({url, description, folder_id, …(preview_title 힌트가 있을 때만 그 키)}).select('id').single()` 뒤 `void requestPreviewFetch(id, deviceHints)`(await 안 함) → 끝나면 POST_LIST + GROUP_ACTIVITY invalidate |
| `hooks/queries/useFolders.ts` | `useCreateFolderWithPost` 동일 패턴 |
| `hooks/queries/useActivity.ts` `screens/ActivityScreen.tsx` | 피드 select 에 `preview_title, preview_image_url, preview_status` 추가(명시 컬럼 목록 — 005 미적용 DB 에서는 42703), 행 제목 = `previewTitle || domain`(기기 파싱 제거) |
| `screens/FolderDetailScreen.tsx` | `usePreviewCatchUp(folderId, postList, canEdit)`, 카드에 preview props 전달, 메모 수정 시트 하단 '미리보기 다시 불러오기'(canEdit && failed), 검색에 preview_title 포함, 중복 검사 `normalizeForCompare`. `handleEditPress`/`handleRetryPreview` 는 `postListRef` 로 목록을 읽어 deps 가 비어 있다(3 s 폴링마다 전 카드가 리렌더되지 않게) |
| `components/sheets/SaveLinkSheet.tsx` `share/ShareApp.tsx` `screens/HomeScreen.tsx` `hooks/useShareIntent.ts` | 공유 텍스트 → `extractTitleHint(text, url)`(URL 제거·공백 정리·2자 미만 null·200 코드포인트 캡) → `preview_title` 힌트. 저장 전 `parseMetadata` 결과를 `deviceHints` 로 invoke 바디에만 실음(insert 컬럼 아님) |
| `utils/domainInfo.ts` | 서버 `siteName` 과 같은 라벨 추가(네이버 뉴스/지도/스마트스토어, TikTok, 쿠팡, 카카오맵, 당근, 오늘의집, 컬리, 무신사, 29CM, Reddit, LinkedIn). **TikTok·쿠팡 규칙은 `opensInApp: true`** — 미리보기 계약과 무관한 사용자 가시 변경(§4-10 (e)) |
| `utils/openLink.ts` | 주석만 갱신. 동작: `opensInApp` 호스트(인스타·유튜브·스레드 + 이번에 TikTok·쿠팡)는 `Linking.openURL` 로 시스템에 넘긴다(앱 있으면 앱, 없으면 기본 브라우저) — 카드 탭이 **인앱 브라우저를 떠난다**. 그 외는 인앱 브라우저 |
| `utils/supabase/types.ts` | **수동 편집**(상단 ⚠️ 주석): posts.preview_* 16컬럼 + RPC 2개. 005 적용 후 `bun run update-types` 로 재생성해 덮는다 |
| `utils/react-query/queryKeys.ts` `queryClient.ts` | METADATA 키는 SaveLinkSheet 저장 전 미리보기 전용으로 주석만 갱신 |

---

## 2. 아키텍처

```
[앱: SaveLinkSheet / FAB / 공유 시트]                 [DB: posts]                          [Edge Function: link-preview]
 insert({url, description, folder_id,        ─AFTER INSERT enqueue_link_preview()──▶  mode webhook (x-webhook-secret)
         preview_title: 공유텍스트 힌트})       (pg_net, Vault 비밀 있을 때만)              202 즉시 → EdgeRuntime.waitUntil(processPost)
   .select('id').single()
   └─ void requestPreviewFetch(id, deviceHints) ────────────────────────────────────▶  mode fetch (user JWT, post_id + device — owner/editor 만, viewer 403)
                                                                                         ┌ claim_post_preview (원자 선점, attempts+1)
                                                                                         │  (webhook 이 먼저 선점했으면 ≤10 s 기다려 needs_client/failed 에 힌트를 assist 로 적용)
[FolderDetailScreen 진입 / 3초 폴링]                                                       ├ canonical 재활용 (같은 그룹·7일·ready → storage.copy)
 usePreviewCatchUp ─ pending·일시 failed·stale fetching 8개씩 ──────────────────────▶  mode fetch (post_ids ≤ 8)   ├ resolveAdapter(url).run(ctx)  ← SSRF·캡·홉 제한
                   ─ needs_client 행(canEdit): 폰 parseOnDevice ──────────────────▶  mode assist                  ├ 폰 힌트 병합 → 제목 힌트 → 이미지 복사(매직바이트)
[롱프레스 → 메모 수정 → 미리보기 다시 불러오기] ─ 폰 parseOnDevice + force ────────▶  mode fetch force (60 s 쿨다운) └ 단일 UPDATE preview_* (claimed_at=null)
(선택) curl / pg_cron ─────────────────────────────────────────────────────────────▶  mode sweep (x-webhook-secret, pick_preview_jobs, 60 s)
                                                                                         응답 직전: preview_image_tombstones 상위 10건 — 행 삭제(RETURNING) → 아직 참조 중인 경로 제외 → storage.remove
[Storage: link-previews/posts/<post_id>/<sha256 16>.<ext>]  ◀── 서버(service_role)만 업로드, 공개 읽기 (expo-image 디스크 캐시)
[카드]  posts.preview_* 컬럼만 렌더. 어떤 상태에서도 최소 "도메인 카드". 에러 화면·에러 토스트 없음.
```

세 겹(트리거·앱 가속·폴더 catch-up)이 모두 같은 `processPost` 로 수렴하고 `claim_post_preview` 가 한 행을 한 워커만 처리하게 한다.
함수는 **요청 바디의 URL 을 절대 fetch 하지 않는다** — 바디에는 post_id 만, fetch 대상은 DB 의 `posts.url` 과 어댑터가 그로부터 계산한 고정 엔드포인트만. 예외는 `device.image_url` 하나(https + SSRF + 어댑터 `imageHosts` + 재다운로드·매직바이트 뒤에만 저장). 폰 힌트가 저장 내용을 바꾸는 경로(fetch 의 `device`/`force`, assist)는 전부 owner/editor 게이트 뒤에 있고, 폰이 준 canonical(`device.canonical_url`, 제출 HTML 의 og:url)은 `posts.url` 과 같은 사이트일 때만 `preview_canonical_url` 로 쓴다.

---

## 3. 상태 머신 (`posts.preview_status`, CHECK 6값)

```
                  insert (default)
                        │
                        ▼
   ┌───────────────  pending  ◀──────────────────────────────────────────────────────┐
   │                    │ claim (webhook / fetch / sweep)                              │
   │                    ▼                                                              │
   │   stale(2분) ─▶ fetching ─▶ 어댑터 결과                                            │
   │   재선점(attempts<5) │                                                            │
   │                    ├─ ready        : 완료. 제목·이미지 null 가능(=도메인 카드). 끝.  │
   │                    ├─ needs_client : 서버(데이터센터 IP) 차단 → 폰 1회 보조          │
   │                    │      │  canEdit 폰 parseOnDevice → assist                    │
   │                    │      ├─ 결과 있음 → ready (source 'device')                    │
   │                    │      ├─ 폰도 차단 → failed ('needs:webview' | 'device_blocked')│
   │                    │      └─ 빈 결과   → failed ('device_empty')                   │
   │                    ├─ failed       : 일시 실패. error ∈ {timeout,http_5xx,dns_failed,network,fetch_failed,unexpected}
   │                    │                 이고 attempts<3 → 다음 폴더 진입 catch-up 이 재시도 ─┘
   │                    │                 그 외 failed 는 '미리보기 다시 불러오기'(force) 만
   │                    └─ unsupported  : 영구 실패(삭제·404·oEmbed 400·BrokenMedia·SSRF·bad_url).
   │                                      재시도 버튼 숨김, force 로만 다시 돌 수 있음
   └── force (사용자 버튼, 60 s 쿨다운, 어떤 상태든 claim 통과)
```

- claim 조건(005 ④): `p_force` 또는 status ∈ {pending, needs_client} 또는 (failed ∧ attempts<3) 또는 (fetching ∧ claimed_at < now-2분 ∧ **attempts<5**). group_id null 행은 제외. attempts 상한이 없으면 처리 중 매번 죽는 행(isolate 강제 종료)을 스윕이 2분마다 영원히 재선점한다 — 5회 뒤로는 force 만 건드린다.
- 비-force fetch 는 attempts ≥ 5 면 서버가 `max_attempts` 로 건너뛴다. 영구 코드(`ssrf*`, `too_many_redirects`, `bad_url`) 의 failed 는 unsupported 로 저장.
- fetch 에 `device` 또는 `force` 를 실으려면 owner/editor 여야 한다(viewer → 403 `forbidden`). 힌트 없는 fetch 는 서버가 받아오는 것뿐이라 RLS 가시 멤버 누구나.
- 앱의 스켈레톤·3초 폴링은 `pending(created_at 10분 이내)` 또는 `fetching(claimed_at 2분 이내)` 일 때만 → 함수 미배포·pg_net 실패로 막힌 행이 영구 폴링을 만들지 않고 도메인 카드로 굳는다.
- 카드 재시도 버튼은 `failed` 에서만(unsupported·needs_client·ready 숨김).

---

## 4. 수동 절차 체크리스트 (전체)

값(비밀) 은 채팅·파일·커밋 어디에도 적지 않는다. 터미널 명령은 레포 루트에서.

- [ ] **4-0 (선택, 1분) 현재 스키마 확인** — Dashboard → SQL Editor
  ```sql
  select column_name, data_type, column_default from information_schema.columns where table_name='posts' order by ordinal_position;
  select policyname, cmd from pg_policies where tablename='posts';
  select extname from pg_extension where extname in ('pg_net','supabase_vault','pg_cron');
  select column_name, data_type from information_schema.columns
    where table_schema='public' and table_name='posts' and column_name in ('id','url','folder_id');  -- ④ RETURNING 캐스트 전제
  ```
  설계 가정(SELECT/INSERT/UPDATE/DELETE 4정책, `set_post_group` BEFORE 트리거, `posts.id` bigint, `posts.url` text — varchar 여도 ④ 가 `::text` 로 캐스트하므로 통과)과 같은지 확인.

- [ ] **4-1 005 SQL 실행** — SQL Editor 에 `supabase/migrations/005_link_previews.sql` 전체(`begin` ~ `commit`) 를 붙여 실행. 실패 시 어느 블록(①~⑦)인지 확인. ⑥ `storage.buckets` insert 가 거부되면 Storage UI 에서 공개 버킷 `link-previews`(file size 3 MB, MIME image/jpeg·png·webp·gif·avif) 를 직접 만든다.

- [ ] **4-2 검증 SQL**
  ```sql
  select preview_status, count(*) from public.posts group by 1;                         -- 전부 pending
  select grantee, privilege_type, column_name from information_schema.column_privileges
    where table_schema='public' and table_name='posts' and grantee='authenticated';     -- insert: url/description/folder_id/preview_title, update: description/folder_id 만
  select id, public, file_size_limit from storage.buckets where id='link-previews';
  ```

- [ ] **4-3 GRANT 직후 즉시, 구버전 앱(현재 설치된 0.0.7)으로** 링크 1개 저장 + 메모 수정이 42501 없이 되는지 확인. (컬럼 단위 GRANT 가 현재 insert/update 범위와 일치하는지 라이브 검증 — 실패하면 ③ 의 grant 목록을 넓히는 게 아니라 어느 컬럼을 앱이 보내는지 먼저 본다.)

- [ ] **4-4 로컬 파서 테스트** — `cd /Users/yooinhak/inhak/moaring-app && bun test supabase/functions/link-preview` 전부 통과(현재 398/398). deno 가 없으므로 배포 전 유일한 검증.

- [ ] **4-5 함수 배포**
  ```sh
  npx supabase login                                   # 1회
  npx supabase functions deploy link-preview  --no-verify-jwt --project-ref yvhyjxdxksdddunjmjdo
  npx supabase functions deploy delete-account --no-verify-jwt --project-ref yvhyjxdxksdddunjmjdo
  ```
  `--no-verify-jwt` 인 이유: 웹훅은 JWT 가 없고, 사용자 JWT 검증은 함수 안에서 직접 한다.
  레포에 `supabase/config.toml` 이 없어도 된다 — 2026-11-04 빈 디렉터리에서 CLI 3.0.0 으로 확인: config 오류 없이 바로 Functions API 로 가서 토큰 검증(401) 에서 멈췄다(`npx supabase init` 불필요, 리뷰 지적 [16] 은 구버전 CLI 전제). CLI 3.x 는 `--project-ref` 를 deprecated 로 경고한다(v4 제거 예정) — `--remote=yvhyjxdxksdddunjmjdo` 로 바꿔도 된다. 비대화형 셸(CI·에이전트)에서는 `--yes` 가 없으면 확인 질문을 못 해 그 자리에서 종료하고, 로그인 토큰이 없으면 키체인 조회에서 출력 없이 멈출 수 있다 — 터미널에서 `login` 뒤 직접 실행하면 해당 없음.

- [ ] **4-6 배포 검증**
  ```sh
  curl -sS -X POST https://yvhyjxdxksdddunjmjdo.supabase.co/functions/v1/link-preview \
    -H 'content-type: application/json' -d '{"mode":"fetch","post_id":1}'
  ```
  → `401 {"success":false,"step":"auth","error":"Missing credentials"}` 가 와야 정상.

- [ ] **4-7 (권장) 서버 소유 트리거 켜기** — 결정 §10-1
  1. 터미널 `openssl rand -hex 32` (값은 화면에서만 본다)
  2. SQL Editor: `select vault.create_secret('<hex64>', 'link_preview_webhook_secret', 'link-preview x-webhook-secret');` (권한 오류면 Dashboard → Database → Vault UI 로 같은 이름으로 생성)
  3. Dashboard → Edge Functions → Secrets 에 `LINK_PREVIEW_WEBHOOK_SECRET` = 같은 값 (이름이 `SUPABASE_` 로 시작하면 거부됨)
  4. (선택) `INSTAGRAM_STORE_CAPTION=full` 은 §10-2 결정에 따라.
  Edge Secret 저장 후 함수는 재배포 없이 다음 호출부터 새 env 를 읽는다.

- [ ] **4-8 트리거 동작 확인** — 앱에서 링크 1개 저장 →
  ```sql
  select id, status_code, left(content::text,200) from net._http_response order by id desc limit 3;  -- 202 {"success":true,"accepted":true} (약 6시간 보관)
  select id, preview_status, preview_provider, preview_source, preview_error from public.posts order by id desc limit 3;  -- ready 로 바뀜
  ```
  Dashboard → Edge Functions → link-preview → Logs 에 `[link-preview] process.done {...}` 확인.

- [ ] **4-9 타입 재생성** — `bun run update-types` → `git diff src/utils/supabase/types.ts` 로 수동 편집본과 같은지 확인(상단 ⚠️ 수동 편집 주석은 재생성으로 사라진다) → `bunx tsc --noEmit -p .` → `bun run lint`. **`bun run format` 은 절대 실행하지 않는다**(Prettier 미정렬 파일 27개가 통째로 바뀐다).

- [ ] **4-10 라이브 1회 검증(출시 전 필수, 개발 빌드)**
  - (a) 앱 안 ＋ 로 YouTube 링크 저장이 42501 없이 성공 → `insert().select('id')` RLS RETURNING 확인 → 수 초 내 제목·채널·썸네일
  - (b) Table Editor 에서 그 행 `preview_image_url` 이 `https://yvhyjxdxksdddunjmjdo.supabase.co/storage/v1/object/public/link-previews/posts/<id>/…` 형태
  - (c) 인스타 앱 → 공유 → 모아링 저장 → Activity 종료 후 앱 재진입 → 폴더 열기 → 카드 채워짐
  - (d) 롱프레스 → 메모 수정 → '미리보기 다시 불러오기' 동작, 60초 내 재요청 시 '잠시 후 다시 시도해주세요'. 재시도 결과가 ready 가 아니면 성공 토스트가 아니라 '미리보기를 불러오지 못했어요'(또는 다른 워커가 쥐고 있으면 '이미 불러오는 중이에요')가 떠야 한다
  - (e) **TikTok·쿠팡 카드 탭** → 0.0.7 의 인앱 브라우저가 아니라 해당 앱(없으면 기본 브라우저)으로 넘어가는지 — `domainInfo.ts` 의 `opensInApp: true` 추가분(§1). 인스타·유튜브·스레드와 같은 동작이면 정상
  - (f) viewer 계정으로 같은 폴더를 열어 재시도 버튼이 없고 catch-up 이 assist 를 보내지 않는지(서버는 보냈어도 403)
  - RETURNING 이 42501 이면: `usePosts.ts`/`useFolders.ts` 의 `.select('id').single()` 을 제거하고 `requestPreviewFetch` 호출도 뺀다 — 트리거(4-7)·catch-up 만으로도 동작한다.

- [ ] **4-11 데이터센터 IP 검증(필수)** — 샘플 URL 10개(Instagram reel, Threads, x.com status, m.blog.naver.com, n.news.naver.com, naver.me 지도 공유, brunch, pinterest pin, tiktok video, yes24 메인) 저장 →
  ```sql
  select preview_provider, preview_status, preview_error, count(*) from public.posts group by 1,2,3 order by 4 desc;
  ```
  차단된 provider 는 §6 절차로 전환 후 재배포.

- [ ] **4-12 쿠팡 실기기 확인** — 쿠팡 앱 → 상품 공유 → 모아링 → 저장된 행 `preview_title` 에 상품명이 들어오는지(EXTRA_TEXT 에 상품명 포함 여부). 안 들어오면 §10-3 WebView 러너 우선순위를 올린다.

- [ ] **4-13 기존 ~100행 백필 관찰** — 폴더를 하나씩 열어 catch-up 이 도는지(폴더 진입 → 카드 순차 채워짐). 가속하려면:
  ```sh
  export WH=<LINK_PREVIEW_WEBHOOK_SECRET 값>   # 셸 변수로만, 어디에도 적지 않는다
  for i in $(seq 1 12); do
    curl -sS -X POST https://yvhyjxdxksdddunjmjdo.supabase.co/functions/v1/link-preview \
      -H "x-webhook-secret: $WH" -H 'content-type: application/json' -d '{"mode":"sweep","limit":8}'; echo
  done                                          # processed 0 이면 중단
  ```
  1시간 후 `select preview_status, count(*) from public.posts group by 1;`

- [ ] **4-14 Storage GC 확인** — 이미지 있는 글 1개 삭제 → `select * from public.preview_image_tombstones;` 에 경로 적재 → 다음 fetch/sweep 호출(폴더 열기면 충분) 뒤 비워지고 Storage → link-previews 에서 객체가 사라지는지. GC 는 행을 먼저 지우고(RETURNING) 아직 `posts.preview_image_path` 가 가리키는 경로는 남긴다(로그 `tombstone_kept_live`) — Storage remove 가 실패하면 행은 이미 없으므로 그 객체는 고아로 남고 로그(`tombstone_remove_failed`)에만 찍힌다.

- [ ] **4-15 (선택, 나중) pg_cron** — Database → Extensions 에서 pg_cron 활성화 → 005 하단 '수동 2단계' 블록 실행 → `select jobname, schedule from cron.job;`. Free 플랜은 1주 비활성 시 프로젝트가 일시정지된다.

- [ ] **4-16 커밋** — `feat. 링크 미리보기 서버 수집 — posts.preview_* + link-preview 함수 + 카드 DB 렌더` 형식. **Co-Authored-By 트레일러 없음**(사용자 규칙). 이 문서는 `git add -f`. §14 참고.

---

## 5. 검증·모니터링 SQL

```sql
-- 전체 분포 (가장 자주 볼 것)
select preview_status, preview_provider, preview_error, count(*)
  from public.posts group by 1,2,3 order by 4 desc;

-- 상태만
select preview_status, count(*) from public.posts group by 1;

-- 최근 처리 30건 (무엇이 어떤 경로로 채워졌나)
select id, preview_status, preview_provider, preview_source, preview_error, preview_attempts,
       preview_fetched_at, preview_assisted_by is not null as assisted
  from public.posts order by coalesce(preview_fetched_at, created_at) desc limit 30;

-- 멈춘 선점 (2분 넘게 fetching = 워커 사망; 다음 claim 이 재선점한다)
select id, preview_claimed_at, now() - preview_claimed_at as age
  from public.posts where preview_status='fetching' and preview_claimed_at < now() - interval '2 minutes';

-- attempts 상한에 걸린 행 (비-force 자동 경로가 더 이상 건드리지 않는 행)
select id, preview_status, preview_error, preview_attempts from public.posts where preview_attempts >= 3 order by preview_attempts desc;

-- 이미지만 실패한 ready 행 (텍스트는 있고 썸네일은 없음)
select id, preview_provider, preview_error, preview_image_src from public.posts
  where preview_status='ready' and preview_error like 'image:%';

-- 웹훅 트리거가 실제로 나갔나 (pg_net 응답, ~6시간 보관)
select id, status_code, left(content::text,200) from net._http_response order by id desc limit 5;

-- Storage 고아 후보 (쌓이기만 하면 함수 끝의 GC 가 안 돌고 있다는 뜻)
select count(*), min(created_at) from public.preview_image_tombstones;

-- 컬럼 GRANT 확인
select grantee, privilege_type, column_name from information_schema.column_privileges
  where table_schema='public' and table_name='posts' and grantee='authenticated';

-- 스윕이 다음에 집을 후보 미리보기
select * from public.pick_preview_jobs(8);   -- SQL Editor 는 postgres 역할이라 실행 가능
```

Edge Function Logs 에서 볼 이벤트(`[link-preview] <event> {json}`, URL·제목은 절대 안 찍힘):
`process.done {post_id, provider, status, source, error, host, image, ms}` · `process.unexpected` · `claim_failed` · `reuse_lookup_failed` · `update_failed` · `assist.done` · `assist.unexpected` · `sweep.done {picked, processed, ms}` · `background_failed` · `fetch.race_poll_failed` / `fetch.race_assist {post_id, status, error}`(저장 직후 가속 호출이 webhook 선점에 밀려 기다린 뒤 힌트를 적용한 경우) · `tombstone_kept_live {count}` / `tombstone_remove_failed {count, error}` / `tombstone_live_check_failed {count, error}`(GC)
사이트별: `instagram.embed_rejected` / `instagram.embed_no_image` / `instagram.embed_fetch_failed` · `tiktok.waf_stub` · `youtube.oembed_fallback` / `youtube.thumb_head_failed` · `x.page_fallback` · `naver_blog.postview_fallback` · `naver_cafe.title_unavailable` / `naver_cafe.fetch_failed` · `coupang.unresolved` · `oembed.fallback_generic` · `generic.meta_refresh`

---

## 6. needs_client 가 급증하면 — 무엇을 보고 무엇을 바꾸나

needs_client 는 "서버(Supabase Edge 데이터센터 IP)가 차단당해 폰이 1회 보조해야 하는 행" 이다. 모든 프로브는 주거용 IP 에서만 했으므로, 배포 후 Edge egress 에서 어떤 사이트가 막히는지는 **이 SQL 로만 알 수 있다**.

### 6-1 어떤 SQL
```sql
-- provider × error 분포: 어느 사이트가 어떤 사유로 막히는지
select preview_provider, preview_error, count(*)
  from public.posts where preview_status='needs_client' group by 1,2 order by 3 desc;

-- 폰 보조 뒤에도 끝내 실패한 것 (폰도 막힘 / 빈 결과) — WebView 러너(v2) 수요의 실측치
select preview_provider, preview_error, count(*)
  from public.posts where preview_status='failed'
   and (preview_error like 'needs:%' or preview_error in ('device_blocked','device_empty'))
 group by 1,2 order by 3 desc;

-- 최근 24시간 신규 저장 중 needs_client 비율 (급증 판단)
select count(*) filter (where preview_status='needs_client') * 100 / greatest(count(*),1) as needs_client_pct, count(*)
  from public.posts where created_at > now() - interval '24 hours';
```
error 코드 읽는 법: `blocked:cloudflare`/`blocked:akamai`/`blocked:waf` = WAF 시그니처(본문 미저장), `blocked:linkedin` = 999, `blocked:shell` = X 가 JS 셸만 줌, `blocked:naver_shop` = 스마트스토어(서버 fetch 안 함), `needs:webview` = 폰 fetch 로도 못 푸는 SPA/쿠팡/플레이스, `blocked:login` = Facebook 로그인 벽. Edge Logs 의 `process.done` 에 `host` 와 `status` 가 같이 찍힌다.

### 6-2 정상 범위
- 쿠팡 상품·스마트스토어·네이버 플레이스(제목 없는 신형 링크)·Medium·Notion·무신사·29CM 은 **설계상 needs_client 또는 slug** 다 — 급증이 아니다. 카드는 브랜드 라벨 + 힌트/슬러그 제목으로 그려진다.
- 인스타·틱톡·X·네이버 블로그/뉴스·핀터레스트·범용 og 사이트가 `blocked:*` 로 쌓이면 **데이터센터 IP 차단** → 6-3.

### 6-3 어떤 플래그 — `serverFetch` 전환 절차
`SiteAdapter.serverFetch`(`supabase/functions/link-preview/types.ts` L204) 는 "이 어댑터는 서버에서 네트워크를 안 쓴다" 는 선언이다. **주의: `process.ts` 는 이 플래그로 `run()` 호출을 막지 않는다**(L607 은 주석, L812 는 assist 가 `needs:webview` 코드를 고를 때만 참조). 그러므로 "플래그 1줄" 이 아니라 아래 두 줄 묶음이 실제 전환이다.

1. `supabase/functions/link-preview/sites/<site>.ts` 의 해당 어댑터에서
   - `serverFetch: true` → `serverFetch: false`
   - `run(ctx)` 첫 줄에서 네트워크 없이 바로 반환:
     ```ts
     return Promise.resolve(
       needsClient('blocked:<사유>', ctx.canonicalUrl, 'fetch', 'generic',
         emptyFields({ title: ctx.hintTitle, siteName: '<브랜드>', canonicalUrl: ctx.canonicalUrl })),
     );
     ```
     (`needsClient`/`emptyFields` 는 `sites/generic.ts` export. 폰 fetch 도 소용없는 사이트면 error 를 `'needs:webview'`, runner 를 `'webview'` 로 — 그러면 catch-up 이 폰 fetch 를 시도하지 않는다. 기존 예: `naver.ts` `naverShopAdapter.run`, `coupang.ts` `coupangOutcome`.)
2. `bun test supabase/functions/link-preview` → 해당 사이트 테스트가 서버 fetch 를 기대하면 함께 고친다.
3. `npx supabase functions deploy link-preview --no-verify-jwt --project-ref yvhyjxdxksdddunjmjdo` (`supabase/config.toml` 불필요 — §4-5)
4. 이미 needs_client 로 쌓인 행은 그대로 둬도 된다 — 폴더 진입 시 폰이 assist 한다. 서버 재시도를 강제하려면 `update public.posts set preview_status='pending', preview_attempts=0 where preview_provider='<id>' and preview_status in ('needs_client','failed');` 뒤 sweep(§4-13) 또는 폴더 열기.
5. 되돌리기(차단이 풀렸을 때)는 반대로. `blocked:*` 코드가 다시 쌓이는지 6-1 로 확인.

반대 방향(폰도 못 푸는 걸 알게 됨): `src/hooks/usePreviewCatchUp.ts` 의 `WEBVIEW_ONLY_PROVIDERS` 에 provider id 를 추가하면 폰 fetch 를 건너뛴다(앱 재배포 필요). 서버 쪽에서 error 를 `needs:webview` 로 바꾸는 편이 앱 배포 없이 같은 효과를 낸다.

---

## 7. 웹훅 비밀 회전 (`LINK_PREVIEW_WEBHOOK_SECRET` ↔ Vault `link_preview_webhook_secret`)

두 곳의 값이 같아야 트리거 → 함수 호출이 401 을 받지 않는다. **함수 재배포는 불필요** — Edge Secret 은 저장 즉시 다음 호출부터 반영된다.

1. 새 값 생성: `openssl rand -hex 32`
2. Dashboard → Edge Functions → Secrets → `LINK_PREVIEW_WEBHOOK_SECRET` 값 갱신 (이 순간부터 옛 값의 웹훅은 401 → 그 insert 들은 pending 으로 남아 catch-up/sweep 이 줍는다. 수 초 창이라 무해)
3. SQL Editor:
   ```sql
   select vault.update_secret((select id from vault.secrets where name='link_preview_webhook_secret'), '<new>');
   ```
4. 확인: 링크 1개 저장 → `select status_code from net._http_response order by id desc limit 1;` 가 202.
5. 비밀을 **끄려면**(트리거 비활성): `delete from vault.secrets where name='link_preview_webhook_secret';` 또는 Dashboard → Database → Vault UI 에서 삭제 → `enqueue_link_preview()` 가 조용히 통과(insert 는 계속 성공). Edge Secret 도 지우면 sweep 포함 서버 간 모드 전체가 401.

---

## 8. Edge Function 계약 요약 (`index.ts` 기준)

`POST https://yvhyjxdxksdddunjmjdo.supabase.co/functions/v1/link-preview` — 공개 URL(`--no-verify-jwt`), 인증은 함수 내부.

| 인증 | 허용 모드 | 실패 |
|---|---|---|
| `x-webhook-secret` 헤더 == env `LINK_PREVIEW_WEBHOOK_SECRET` (상수시간 비교; env 없으면 무조건 401) | `webhook`, `sweep` | 401 `{step:'auth'}`; 다른 모드 → 400 `{step:'mode'}` |
| `Authorization: Bearer <user JWT>` → `auth.getUser()` | `fetch`, `assist` | 401 `{step:'auth'}`; webhook/sweep 시도 → 403 `{step:'auth'}` |
| 둘 다 없음 | — | 401 `{step:'auth', error:'Missing credentials'}` |

| 모드 | 바디 | 동작 | 응답 |
|---|---|---|---|
| `fetch` | `{post_id, device?, force?}` 또는 `{post_ids: [≤8]}` (`post_ids` 에 `device`/`force` 가 함께 오면 **400** `{step:'body', error:'device/force require post_id'}` — 조용히 버리지 않는다) | userClient 로 RLS 가시 행만 select(`group_id` 포함) → **`device` 가 객체이거나 `force:true` 면 `is_group_member(owner/editor)` 아니면 403** `{step:'forbidden', error, results:[{post_id, status:<현재>, skipped:'forbidden'}]}`(힌트 없는 fetch 는 viewer 도 됨 — 서버가 받아오는 것뿐) → force: fetching(2분 이내) 은 `in_progress`, claimed/fetched 60 s 이내는 **429** `{step:'cooldown', results:[{skipped:'cooldown'}]}` → 비-force: ready/unsupported 는 그대로, attempts ≥ 5 는 `max_attempts` → 나머지 `processManyWithBudget`(동시 2, 20 s 예산; 넘치면 `{status:'fetching', skipped:'in_progress'}` 로 돌려주고 waitUntil 로 계속) → **단건 + device 가 다른 워커의 선점에 밀려 `in_progress` 로 끝났고 백그라운드 작업이 없으면**(저장 직후 webhook 과의 경합 — 보통의 경우) 750 ms 간격으로 ≤10 s(20 s 예산 − 4 s assist 예비) 그 행을 폴링: needs_client/failed 로 끝나면 `applyAssist`(html 제외, 이미지 복사는 남은 예산 안) 결과를 `results[0]` 으로(예: `status:'ready', source:'device'` 또는 failed `device_empty`), ready/unsupported 면 `{post_id, status}`, 아직 fetching 이면 `in_progress` 그대로 | 200 `{success:true, results:[…]}` (요청 순서) |
| `webhook` | `{post_id}` | admin select → 없음 404 `{step:'post'}`; 선점 불가(ready/unsupported/failed≥3/fetching<2분/group_id null) → 200 `{accepted:false}`; 아니면 `waitUntil(processPost)` | **202** `{success:true, accepted:true}` |
| `sweep` | `{limit?}` (1..20, 기본 8) | `pick_preview_jobs` → 순차 `processPost`, 60 s 예산 | 200 `{success:true, processed, results}` |
| `assist` | `{post_id, device:{title?, description?, image_url?, author?, canonical_url?, html?(≤256 KB), blocked?, http_status?}}` | userClient 가시성(없으면 200 + `skipped:'not_found'`) → `is_group_member(owner/editor)` 아니면 **403** `{step:'forbidden', error, results:[{post_id, status, skipped:'forbidden'}]}`(RPC 오류도 거절) → 상태 needs_client/failed 아니면 `skipped:'in_progress'` → `applyAssist`(claim 경유, 서버 파서로 HTML 재해석, 이미지 재다운로드, **부분 UPDATE** 로 브랜드 라벨·힌트 제목 보존, `preview_assisted_by`=user). `device.canonical_url` 과 제출 HTML 의 og:url/link[rel=canonical] 은 **posts.url(또는 서버 canonical)과 같은 사이트일 때만** 파서 기준 URL·`preview_canonical_url` 로 쓴다(호스트의 `www.`/`m.` 을 떼고 비교, 하위 도메인 허용) — 아니면 서버 canonical 로 돌아가고 폰 값은 저장되지 않는다(제목·설명·작성자·이미지는 그대로 저장). adapter 가 `instagram` 이면 `device.description` 은 `INSTAGRAM_STORE_CAPTION=full` 일 때만 받는다(fetch 의 device 병합도 같다) | 200 `{success:true, results:[entry]}` |

바디 캡: fetch/webhook/sweep 8 KB(초과 413), assist 320 KB. 응답 골격 `{success, step?, error?, accepted?, processed?, results?}` — `results[]` = `{post_id, status, source?, error?, skipped?: not_found|in_progress|max_attempts|cooldown|forbidden, client_task?: {post_id, folder_id, url, runner: fetch|webview, parser: generic|instagram_embed|tiktok_ssr}}`.
`not_found` 엔트리는 status 자리에 `'failed'` 가 들어간다(타입상 필수 필드라서 — 호출자는 `skipped` 를 먼저 본다).

env: `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`(자동) · `LINK_PREVIEW_WEBHOOK_SECRET` · `INSTAGRAM_STORE_CAPTION`(`full` 이면 캡션 전체를 description 에) · `MICROLINK_API_KEY`(자리만, 효과 없음).

### 에러 코드 (`posts.preview_error`, ≤120자)
| 분류 | 코드 | 뜻 / 다음 행동 |
|---|---|---|
| unsupported(영구) | `gone` | 404/410(t.co·lnkd.in·Reddit `/s/` 리다이렉터가 Location 없이 404/410 을 줄 때 포함), YouTube oEmbed 400, IG EmbedBrokenMedia·302→프로필, X 'Post Not Found' |
| | `coupang_unresolved` | link.coupang.com 이 홈으로 302(만료 코드) |
| | `offsite_redirect` | Reddit `/r/<sub>/s/<id>` 의 Location 이 reddit 밖 |
| | `login_wall` | LinkedIn `/in/`·`/company/`·`/school/` 프로필(lnkd.in 이 거기로 가도 같음) |
| | `tiktok_status_<n>` | TikTok statusCode ≠ 0(삭제·비공개·지역제한) |
| | `ssrf*` `too_many_redirects` `bad_url` | failed 로 났지만 영구 코드라 unsupported 로 저장 |
| failed(일시, **catch-up 자동 재시도**, attempts<3) | `timeout` `http_5xx` `dns_failed` `network` `fetch_failed` `unexpected:<msg>` | 다음 폴더 진입에 재시도(`TRANSIENT_PREVIEW_ERRORS`, 서버 코드와 1:1). `network` = fetch 의 TypeError(연결 거부·리셋·TLS), `fetch_failed` = 그 외 분류 안 된 fetch 예외. 반복되면 Edge Logs 의 host 확인 |
| failed(자동 재시도 없음, 버튼 force 만) | `too_large` `http_<4xx>` `oembed_invalid` `tiktok_shape` `tco_unresolved` `lnkd_unresolved` `reddit_unresolved` `redirect_invalid` | 어댑터 가정이 깨짐(마크업 변경·리다이렉터 동작 변경 등) — 테스트 픽스처 갱신 대상. `*_unresolved` = 단축 링크가 리다이렉트를 안 줬거나 자기 자신으로만(t.co 는 3회) 갔다, `redirect_invalid` = Location 이 URL 이 아님 |
| | `needs:webview` `device_blocked` `device_empty` | assist 종결 코드: 폰도 막힘 / 폰도 빈 결과. WebView 러너(v2) 수요 |
| | `claim_failed` | 응답에만 나타남(행 미변경). RPC 권한/시그니처 문제 → 005 ④ 재확인 |
| needs_client | `needs:webview` | 쿠팡 상품·네이버 플레이스(제목 없음)·generic SPA 셸. 폰 fetch 안 함 |
| | `blocked:naver_shop` | 스마트스토어/브랜드스토어. 폰 fetch 1회 |
| | `blocked:cloudflare` `blocked:akamai` `blocked:waf` `blocked:linkedin` `blocked:shell` `blocked:login` | WAF·JS 챌린지·999·셸·로그인벽. 본문 미저장. 폰 fetch 1회 |
| ready + 이미지만 실패 | `image:url` `image:host` `image:not_image` `image:svg` `image:too_large` `image:empty` `image:bad_magic` `image:upload` `image:copy_existing` | 텍스트 카드로 ready. 원본은 `preview_image_src` |

---

## 9. 테스트 계획 (배포 후 수동)

- **단위(배포 전)**: `bun test supabase/functions/link-preview` (398) — 엔티티(`&#039;`/`&#x27;`/`&quot;`/세미콜론 누락), charset 라벨(ks_c_5601-1987·UTF8·euc_kr 거부, UTF-8 BOM 이 euc-kr 헤더를 이김), 상대/프로토콜상대 URL, 따옴표 안 `>` 가 있는 meta, meta refresh, SPA 셸 판정, 차단 시그니처, 추적 파라미터 제거, YouTube id 17케이스, X 404 게이트·card 분기·t.co 외부/체인/404, 인스타 임베드 캡션/이미지/BrokenMedia·`/reels/audio/`, naver.me Location(순서 2종·신형), 블로그 URL 재작성 4폼, 카페 `/f-e/`·홈·게시판 canonical, 쿠팡 Location(정상·홈 302), lnkd.in·Reddit `/s/` 첫 홉 분기(misc.test.ts), tombstone GC 선점·생존 확인(image.test.ts), process/assist 흐름 62건(인스타 캡션 정책·canonical 같은 사이트 게이트 포함).
- **YouTube**: `https://youtu.be/dQw4w9WgXcQ?si=abc` → 5초 내 ready, source `oembed`, 제목 'Rick Astley - …', author 'Rick Astley', Storage 이미지(원본 maxresdefault). `/shorts/JfbnpYLe3Ms` → site_name 'YouTube Shorts'. 없는 id → unsupported(`gone`), 도메인 카드, 재시도 버튼 없음.
- **Instagram**: 공개 릴스(`/reel/DI3R5NfBWn_/?igsh=…`) → ready, source `embed`, 제목 = 캡션 첫 줄, author '@jewvely_home', Storage `posts/<id>/` 객체 1개(oe= 서명 URL 은 `preview_image_src` 에만). 삭제된 `/p/DHAfcsvMXwT/` → unsupported. 서버 IP 차단이면 needs_client → 폴더 진입 시 폰 assist → ready(`device`). 그동안 '@user • Instagram' 또는 도메인 카드, 에러 토스트 없음.
- **네이버**: 데스크톱 폼 `https://blog.naver.com/naverofficial/224464411656` → m.blog 재작성으로 ready, author 'naverofficial', canonical 은 데스크톱 폼. 뉴스 `read.naver?oid=001&aid=…` → `/mnews/article/` canonical + 이미지. naver.me 지도(구형, title 쿼리) → ready '마포식당' + 지도 이미지 + '네이버 지도'; 신형(title 없음) → needs_client(`needs:webview`) 지만 카드는 '네이버 지도' 브랜드 카드 즉시.
- **X**: `https://x.com/BarackObama/status/266031293945503744` → ready 'Four more years.', author 'Barack Obama (@BarackObama)', pbs 이미지. `x.com/jack/status/20` → 텍스트 카드(아바타 미저장). `/i/web/status/20` → 307 추적으로 ready. 없는 id → unsupported, 제목에 'Post Not Found' 절대 없음. 외부 기사로 가는 `https://t.co/<code>` → provider `x` 지만 generic og 로 ready(canonical 은 기사 URL) — `ssrf:hop_host` 가 나오면 퇴행.
- **쿠팡**: 쿠팡 앱 '상품명 https://link.coupang.com/a/…' 공유 → `preview_title` 에 상품명 → 서버는 Location 만 읽어 canonical `www.coupang.com/vp/products/<pid>?itemId=…` 저장, needs_client(`needs:webview`), 카드 = 상품명 + '쿠팡'. 힌트 없이 URL 만 → '쿠팡 상품 <pid>'. Edge Logs 에 www.coupang.com 요청(host) 없어야 함. 만료 코드 → unsupported(`coupang_unresolved`). 폴더 진입 시 폰 fetch 시도 없어야 함.
- **범용**: `https://github.com/expo/expo`, `https://www.daangn.com/kr/buy-sell/…`(&amp;·webp), `https://m.cafe.daum.net/supporters/MbmU/92`(상대 og:url·숫자 엔티티·http 이미지 → https Storage), `https://place.map.kakao.com/18722401`(프로토콜상대 og:image), `https://velog.io/@…`(플레이스홀더 제외) 각각 ready. `https://www.musinsa.com/products/2705776` → needs_client(`blocked:cloudflare`), 'Attention Required!' 가 제목에 없음 → 폰 1회 → 실패면 failed(`needs:webview`), 카드 '무신사' + 슬러그 제목.
- **EUC-KR**: `https://www.yes24.com/`(ks_c_5601-1987) → '예스24' 정상; `https://www.yes24.com/Product/Goods/197808669`(UTF8) → '독재자(들) …' 정상(같은 호스트 응답별 판정). `https://cafe.naver.com/joonggonara/1119896688`(MS949) → '중고나라 글' + '네이버 카페'. 2024 PC 폼 `https://cafe.naver.com/f-e/cafes/10050146/articles/1119896688?boardtype=L` → 공유 텍스트 힌트 또는 '네이버 카페 글', canonical `…/ca-fe/cafes/10050146/articles/1119896688`(두 글이 같은 canonical 을 갖지 않아야 한다). 폰 보조는 euc-kr 에서 제목 null 을 보내고 서버가 그대로 종결.
- **공유 시트 생존**: Android 인스타/크롬 → 공유 → 모아링 → 저장 → 즉시 홈 복귀(Activity 종료) → 트리거 활성이면 10초 내 DB ready(앱 미실행; Edge 로그·`net._http_response`); 비활성이면 pending 유지 → 앱 열고 폴더 진입 시 catch-up 으로 ready. 어느 경우에도 에러 토스트 없음.
- **폴링·재시도**: 폴더 화면 켜 둔 채 저장 → 3초 폴링 → ready 되며 폴링 중단. 함수를 일시적으로 깨뜨린 상태(잘못된 secret 등)로 저장 → 10분 후 폴링 멈추고 도메인 카드. 수동 재시도 60초 내 2회 → 두 번째 '잠시 후 다시 시도해주세요'. 재시도가 또 실패(failed/unsupported/needs_client) → 빨간 '미리보기를 불러오지 못했어요'(초록 토스트가 뜨면 퇴행); 다른 워커가 선점 중 → '이미 불러오는 중이에요' 뒤 폴링이 채움. 재시도 중 3초 폴링이 스켈레톤을 되돌리지 않아야 한다(요청 직전에 낙관 행을 다시 세움). unsupported 행에 재시도 버튼 없음. 오프라인에서 폴더를 열어 catch-up 이 실패한 뒤 연결이 돌아오면 다음 목록 갱신에 **다시** 보낸다(세션 Set 이 전송 실패를 기억하지 않음). 100행 폴더를 열어도 Edge Function 호출이 겹쳐 뜨지 않는다(폴더당 배치 하나, 24건 → 끝나면 다음 24건).
- **무결성·보안**: authenticated 세션으로 `from('posts').update({preview_title:'x'})` → 42501. viewer 계정 `assist` → 403 forbidden. **viewer 계정 `fetch` + `device` 또는 `force:true` → 403 forbidden**(앱은 '미리보기를 다시 불러올 권한이 없어요'); viewer 의 힌트 없는 `fetch` 는 200. `post_ids` + `device` → 400. 다른 그룹 post_id `fetch` → `skipped:'not_found'`. 바디에 url 넣어도 무시. editor 가 `assist` 에 다른 사이트의 `canonical_url`/og:url 을 실어도 `preview_canonical_url` 은 폰 값이 아니다(그룹의 다른 글이 그 canonical 로 donor 를 얻지 않음). 인스타 글에 `device.description` 을 실어도 `INSTAGRAM_STORE_CAPTION` 미설정이면 `preview_description` null. service_role 로 `preview_image_url` 에 http UPDATE → CHECK 위반. 비밀 없는 `sweep` → 401.
- **Storage 정리**: 이미지 있는 글 삭제 → tombstone → 다음 fetch/sweep 후 객체 삭제(행 삭제가 먼저, 아직 참조 중인 경로는 남김 — §4-14). 재시도로 이미지가 바뀌면 옛 경로가 tombstone. 테스트 계정 삭제 → delete-account 가 그 사용자 경로 전부 remove.
- **호환성**: **새 앱은 005 를 요구한다.** 005 적용 전 새 앱 — 공유 텍스트 힌트가 **없는** 저장(FAB·URL 만 공유)은 insert 바디에 `preview_title` 키가 실리지 않아 성공하고 invoke 404 는 무시, 도메인 카드; 힌트가 **있는** 저장(인스타·크롬 공유 텍스트에 제목 포함, 쿠팡 상품명)은 PostgREST PGRST204(`preview_title` 컬럼 없음)로 실패해 '링크 추가에 실패했어요'('만들고 바로 저장' 은 폴더만 만들어지고 글 저장 실패); 활동 피드는 `useActivityFeedQuery` 의 명시 select 때문에 42703 로 빈다(폴더 목록·상세는 와일드카드 select 라 정상). 같은 이유로 **005 를 되돌릴 때는 앱을 먼저 되돌린다**(새 앱이 깔린 채 되돌리면 힌트 저장·활동 피드가 깨진다). 005 적용 후 구앱 — insert/update/select 정상. 함수 미배포 — 도메인 카드만. 롤아웃 순서(005 → 함수 → 앱)를 지키면 어떤 조합에서도 크래시·에러 토스트 없음.

---

## 10. 사용자 결정 사항 (기록 칸)

### 10-1 서버 소유 트리거(pg_net + Vault 비밀)를 지금 켤지 — 권장 **켠다**
비용은 §4-7 의 3단계. 켜면 Android 공유 시트에서 프로세스가 죽어도 수집이 보장되고 구버전 앱 저장까지 백필된다. 끄면(비밀 미등록) 트리거는 조용히 비활성, 앱 호출 + 폴더 catch-up 만으로 동작(폴더 열기 전까지 pending).

- 결정: ☐ 켠다  ☐ 끈다   날짜: ________  메모: ______________________

### 10-2 Instagram 캡션 저장 범위 — 권장 **제목(캡션 첫 줄 ≤80자) + 이미지 + @username 만**(`INSTAGRAM_STORE_CAPTION` 미설정)
Meta oEmbed 약관의 '메타데이터 영속 금지' 는 oEmbed 를 쓰지 않아 직접 적용을 피했지만, 공개 임베드 페이지(`/embed/captioned/`) 파싱 결과의 저장 적합성은 제품/법적 판단이다. 전체 캡션이 필요하면 Edge Secret `INSTAGRAM_STORE_CAPTION=full`(재배포 불필요). 이 정책은 **서버가 강제한다**(`process.ts applyCaptionPolicy`): 폰이 fetch/assist 힌트로 캡션 전체를 `description` 에 실어 보내도 플래그가 없으면 버린다 — 클라이언트 버전과 무관하게 결정이 유효하다.

- 결정(Meta 약관 기록): ☐ 첫 줄만(기본)  ☐ 전체 캡션 저장   날짜: ________  근거/메모: ______________________

### 10-3 WebView 러너(react-native-webview + prebuild)를 v1 에 넣을지 — 권장 **v2 보류**
먼저 §4-12 로 쿠팡 앱 공유 텍스트에 상품명이 포함되는지 확인 — 포함되면 힌트만으로 쿠팡 카드 품질이 충분하다. 미포함이거나 스마트스토어·네이버 플레이스 제목이 꼭 필요하면 올린다(iOS 공유 확장 계획 `docs/superpowers/plans/2026-11-01-ios-share-extension.md` 의 prebuild 와 충돌 여부도 함께).

- 결정: ☐ v2 보류  ☐ v1 에 포함   쿠팡 EXTRA_TEXT 상품명 포함 여부: ☐ 예 ☐ 아니오   날짜: ________

### 10-4 pg_cron 5분 sweep / Microlink 키 — 권장 **둘 다 v1 미사용**
재시도·백필·Storage GC 는 폴더 진입 catch-up 과 함수 호출 끝 GC 로 처리되고, 백필 가속은 curl 1줄(§4-13). 사용자가 폴더를 열지 않아도 ready 가 되길 원하면 005 하단 pg_cron 블록(Free 플랜 1주 비활성 일시정지 유의). Microlink 는 키 25회/일로 가치가 낮고 저장 URL 이 제3자로 나간다.

- 결정: pg_cron ☐ 미사용 ☐ 사용   Microlink ☐ 미사용 ☐ 사용   날짜: ________

---

## 11. 알려진 한계

- **쿠팡 상품·스마트스토어·네이버 플레이스(신형 링크)·일반 SPA** 는 v1 에서 공유 텍스트 힌트가 없으면 브랜드 카드('쿠팡 상품 <pid>', '<storeId> 스토어 상품', '네이버 지도')다. 서버·폰 모두 fetch 하지 않는다(Akamai 403·429 정적 페이지·SPA 셸).
- **데이터센터 IP 미검증**: 모든 프로브는 주거용 IP·curl 기본 UA. Edge egress 에서의 차단 여부는 §4-11 샘플과 §6 SQL 로만 확인된다. UA 스푸핑·우회는 하지 않는다(정책).
- **비공식 마크업 의존**: Instagram `/embed/captioned/`, TikTok `__UNIVERSAL_DATA_FOR_REHYDRATION__`. 바뀌면 needs_client/`tiktok_shape` 가 늘고 §6-1 SQL 로 감지된다.
- 미검증: 네이버 카페 글 제목(카페명만 저장), 카페 `/f-e/cafes/…/articles/…` 페이지가 SPA 셸인지(코드는 그렇다고 가정 — 글 제목은 힌트에서만), X 미디어 외 영상 og, FB 비디오, kko.* 단축, m.entertain/sports.naver, 개인 네이버 블로그(서로이웃), IG 사진/캐러셀, Threads 첨부 미디어, **Reddit `/r/<sub>/s/<id>` 리다이렉터가 데이터센터 IP 에도 permalink Location 을 주는지**(로그인 페이지로 보내면 `offsite_redirect`/`gone` 가 아니라 oEmbed 404 → `gone`), **lnkd.in 리다이렉터 동작**(외부 기사 → generic 으로 가는 경로는 가짜 io 로만 검증).
- 공유 그룹에서 다른 멤버가 저장한 글의 갱신은 폴더 재진입 시 반영(Realtime 미사용).
- 썸네일 리사이즈 없음(Edge 에 sharp 없음) — 원본 그대로 3 MiB 캡. 공개 버킷이라 URL 을 아는 누구나 썸네일 조회 가능(경로에 post_id + sha 조각).
- DNS 리바인딩은 Deno fetch 가 IP 고정을 못 해 잔여 위험 — 본문은 호출자에게 중계되지 않고 길이 캡된 제목/설명만 저장되므로 blind probe 로 축소. DoH 폴백은 저장 URL 의 호스트명을 Cloudflare 에 보낸다.
- Edge 함수 `fetch` 20 s 예산 + 동시 2 → 느린 8건 배치는 2~4건만 동기 결과, 나머지는 `in_progress` 로 돌아오고 백그라운드에서 계속된다(다음 폴링/폴더 재진입에 보임). 로그에 `in_progress` 가 잦으면 `index.ts` `FETCH_BUDGET_MS` 를 올리거나(Edge 벽시계 150 s) `BUDGET.postTimeoutMs` 를 내린다.
- **저장 직후 폰 힌트와 webhook 의 경합**: 트리거가 켜져 있으면 pg_net webhook 이 먼저 선점하는 것이 보통이라 앱의 가속 fetch 는 claim 에 진다. 그 경우 함수가 ≤10 s 그 행을 기다렸다가 needs_client/failed 로 끝나면 힌트를 `applyAssist` 로 적용한다(§8 fetch, 로그 `fetch.race_assist`) — 인스타 임베드 원문(html)은 fetch 바디(8 KB)에 못 실리므로 이 경로는 제목·설명·작성자·이미지 힌트만 적용하고, 서버 재파싱이 필요한 경우는 폴더 catch-up 의 assist 가 맡는다. 비용: 가속 호출에만 경합 시 ≤10 s 지연 + `is_group_member` RPC 1회(수십 ms). 그 10 s 안에도 끝나지 않으면(느린 사이트) 힌트는 버려지고 catch-up 이 다시 폰 파싱한다.
- tombstone GC 의 잔여 경합: GC 가 행을 선점(RETURNING)한 직후 다른 호출이 같은 경로를 재업로드·`clearTombstone`(no-op)·UPDATE 하면, GC 의 생존 확인(select)이 그 UPDATE 커밋 전에 지나가 객체를 지울 수 있다 — 창은 DB 왕복 1회. 완전히 닫으려면 원자 RPC(`claim_preview_tombstones`, §13) 가 필요하다. 생존 확인 select 가 실패하면 그 회차는 아무것도 지우지 않는다(고아 ≤3 MiB 가 깨진 썸네일보다 싸다).
- `EdgeRuntime.waitUntil` 이 런타임에 없으면 202 뒤 백그라운드가 죽을 수 있다(코드는 guarded) — 그 행은 stale fetching 으로 남아 2분 뒤 catch-up/sweep 이 재선점한다(attempts<5 까지, 그 뒤는 force 만). 배포 후 webhook 1건이 ready 로 끝나는지(§4-8) 로 확인.
- `index.ts` 의 `handleFetch` 판단 로직(게이트·쿨다운·경합 보정)은 bun 테스트가 없다 — URL import 때문에 import 자체가 안 된다. §13 참고.

---

## 12. v2 계획

### 12-1 WebView 러너
현재 코드에 있는 자리: 서버 `ClientRunner = 'fetch' | 'webview'`(types.ts), 어댑터가 `needsClient('needs:webview', url, 'webview', 'generic', fields)` 로 과제를 내는 곳 3개(`sites/coupang.ts` `coupangOutcome`, `sites/naver.ts` `naverMapOutcome`, `sites/generic.ts` SPA 셸), 클라이언트 `PreviewClientTask.runner: 'fetch' | 'webview'`, `usePreviewCatchUp` 의 `WEBVIEW_ONLY_PROVIDERS` + `needs:webview` 건너뛰기. **`registerWebViewRunner` 같은 등록 함수는 아직 없다** — 이름만 계획이다.

구현 순서(예정):
1. `npx expo install react-native-webview` → prebuild 필요(iOS 공유 확장 계획의 prebuild 와 같은 시점에 묶는 것이 안전).
2. `src/utils/preview/webviewRunner.tsx`: 보이지 않는 `<WebView>` 에 `client_task.url` 을 로드 → `injectedJavaScript` 로 `document.head.innerHTML`(og/twitter/title) 만 postMessage(쿠팡은 이미지 호스트 `*.coupangcdn.com` 만) → 10 s 타임아웃 → `DeviceAssistHints{html}` 로 `requestPreviewAssist`.
3. `usePreviewCatchUp`: `canEdit` 이고 `preview_error` 가 `needs:webview` 로 시작하는 needs_client/failed 행을 러너에 1건씩(동시 1) 넘긴다. `WEBVIEW_ONLY_PROVIDERS` 건너뛰기를 러너 경로로 교체.
4. 서버는 변경 없음 — `applyAssist` 가 `parseSubmittedHtml(adapter, html)` 로 이미 generic 파싱·imageHosts 게이트를 한다. 쿠팡은 `coupang.ts` 에 `parseSubmitted`(og:title/og:image, `*.coupangcdn.com`) 를 추가.
5. 측정: §6-1 두 번째 SQL(`needs:%`/`device_*` failed) 이 줄어드는지.

### 12-2 Microlink 어댑터 자리
`index.ts` 가 `MICROLINK_API_KEY` 를 env 목록에 적어 두었지만 **읽는 코드는 없다**(값이 있어도 효과 없음). 넣는다면 `sites/microlink.ts` 어댑터를 만들어 `sweep` 모드에서만, generic 이 `failed`/`needs_client` 로 끝난 뒤의 2차 시도로 붙이는 것이 설계 의도다(이미지 URL 도 원본이라 가치 낮음, 저장 URL 이 제3자로 나감 — §10-4).

---

## 13. 후속 과제·알려진 불일치

코드 리뷰·다음 작업에서 처리할 것. 어느 것도 출시를 막지는 않는다. 2026-11-04 저녁 적대적 리뷰(확정 38건, 아래 `[n]` 은 그 번호)에서 코드로 고친 것은 맨 아래 "해결됨" 블록에 모았다.

### 열려 있는 것

1. **`serverFetch` 가 `run()` 을 막지 않는다** (§6-3). `process.ts` 의 어댑터 실행 직전에 `if (adapter.serverFetch === false && …)` 가드를 두거나, 문서처럼 "플래그 + run 두 줄" 을 관례로 유지. 전자가 설계가 말한 '1줄 전환' 을 실제로 만든다.
2. `bun run lint` 가 `src/components/Toast.tsx:60` react-hooks/exhaustive-deps 경고 1개로 exit 1 — 이번 작업 이전부터 있던 것. deps 를 채우거나 사유 주석 + disable.
3. `extractTitleHint` 가 `src/hooks/useShareIntent.ts` 에 있고 `ShareApp.tsx` 가 거기서 import 한다(설계는 ShareApp 에 두는 것). 더 중립적인 자리는 `src/utils/titleHint.ts`. Chrome 공유처럼 텍스트가 URL 만이고 제목이 EXTRA_SUBJECT(`shareIntent.meta?.title`) 에 오는 경우는 힌트가 null — 후속 폴백 후보.
4. `index.ts` 는 이 Mac 에서 실행·타입체크 불가(deno 없음; bun 트랜스파일 + `--noResolve` tsc 구문 검사 + 통독으로만 확인). 배포 후 확인: 401 응답(§4-6), `EdgeRuntime.waitUntil` 존재(§4-8 webhook 이 ready 로 끝남), `pick_preview_jobs` 가 supabase-js rpc 로 number[] 로 옴(sweep `processed > 0`), viewer 의 `fetch`+`device` 가 403(§9). **`handleFetch` 의 판단 로직(owner/editor 게이트·쿨다운·`rescueDeviceHints`)에는 자동 테스트가 없다** — URL import 때문에 bun 이 index.ts 를 import 하지 못한다. 후속: 그 로직을 process.ts 처럼 순수 모듈로 빼서 테스트.
5. ~~클라이언트 인스타 shortcode 정규식의 `/reels/audio/` 오인식~~ (해결): `parseMetadata.ts extractInstagramCode` 가 서버와 같은 예약어 집합(`INSTAGRAM_RESERVED_CODES = {audio, embed, explore, videos}`)을 거부해 generic og 로 떨어진다.
6. tombstone GC 의 잔여 경합(§11, DB 왕복 1회 창). 완전히 닫으려면 005 에 원자 RPC — 예: `claim_preview_tombstones(p_limit int) returns setof text` 가 `delete … where path in (select path from preview_image_tombstones where not exists (select 1 from posts p where p.preview_image_path = preview_image_tombstones.path) order by created_at limit p_limit) returning path` — 를 두고 `image.ts removeTombstones` 가 select+delete+select 대신 rpc 한 번을 부르게. 필수는 아니다.
7. 미세 불일치(의도됨): `applyAssist` 는 URL 파싱 실패를 failed `bad_url` 로, `processPost` 는 unsupported 로 저장. assist 는 이미 needs_client/failed 인 행만 받으므로 실제로는 도달 불가.
8. `src/screens/HomeScreen.tsx` 3·520·541행, `useActivity.ts` 111행 등 120자 초과 줄은 기존 그대로(Prettier 미정렬 파일). **`bun run format` 금지** 규칙 유지. 테스트 쪽: `__tests__/misc.test.ts` 가 `x.test.ts` 의 가짜 리다이렉트 io(`followChain`) 를 복사해 갖고 있다 — 공용 `__tests__/helpers.ts` 로 합칠 것.
9. 실기기 미검증 항목: 롱프레스 → 시트 → 재시도 → 스켈레톤 → 토스트 분기(§4-10 (d)); editor 로 폴더 진입 시 catch-up 이 카드를 채우는 모습; viewer 에게 재시도 버튼·assist 호출이 없는 것(§4-10 (f)); TikTok·쿠팡 카드가 앱으로 열리는 것(§4-10 (e)); 쿠팡 앱 공유 텍스트 모양(§4-12); TikTok 폰 보조(`parseTikTok`) 1건.
10. 네트워크 없이 고친 것들의 라이브 동작: Reddit `/s/` 리다이렉터, lnkd.in, 카페 `/f-e/` 페이지 — §11 미검증 목록. 배포 후 §4-11 샘플에 각 1개씩 넣어 `preview_error` 로 확인.
11. supabase CLI 3.x 가 `--project-ref` 를 deprecated 로 경고한다(v4 제거) — §4-5·§6-3 의 명령은 아직 동작하지만 `--remote=<ref>` 로 바꿀 시점을 봐 둘 것. `supabase/config.toml` 은 필요 없다(§4-5 에서 확인, [16] 은 구버전 전제).
12. 저장 직후 가속 fetch 는 이제 `is_group_member` RPC 1회를 더 부른다(수십 ms) — 가속 호출 지연을 추적한다면 참고.

### 해결됨 (2026-11-04)

- 통합 단계: provider id 오타(`naver_store`) 제거 → `WEBVIEW_ONLY_PROVIDERS = {'coupang','naver_map'}`; `pick_preview_jobs` 가 assist 종결 행(`needs:%`·`device_*`) 을 재집지 않음; 클라이언트 `DeviceHints.canonical_url`; `deno.json` 에 `__tests__` exclude; TikTok 폰 보조 `parseTikTok`(SSR JSON → 힌트만, 원문 미동봉, WAF 스텁은 blocked).
- 리뷰 [0][3]: fetch 의 `device`/`force` 에 owner/editor 게이트(viewer 403), `post_ids`+device/force 400, webhook 선점에 밀린 가속 호출의 힌트를 ≤10 s 기다려 assist 로 적용(`rescueDeviceHints`) — §8.
- [13][20]: 인스타 `device.description` 은 `INSTAGRAM_STORE_CAPTION=full` 일 때만(서버 `applyCaptionPolicy`, fetch·assist 공통); 폰 canonical·제출 HTML 의 og:url 은 posts.url 과 같은 사이트일 때만(`isSameSiteUrl`) — findDonor 오염 차단. assist 403 응답에도 `results[{skipped:'forbidden'}]`.
- [2][17][18] 005: stale fetching 재선점 `attempts < 5`(claim·pick 둘 다); RETURNING `url::text` 명시 캐스트(varchar 대비, 검증 SQL 에 컬럼 타입 확인 추가); 되돌리기 블록 맨 앞에 `cron.unschedule`(DO 블록, pg_cron 없어도 통과).
- [4][10][14]: `network`·`fetch_failed` 를 클라이언트 `TRANSIENT_PREVIEW_ERRORS` 에 추가(서버가 내는 일시 코드와 1:1) — §8 표.
- [21][22]: tombstone GC 가 행 삭제(RETURNING) 로 선점 → 생존 경로 제외 → remove(§4-14); charset 우선순위 BOM → 헤더 → meta(WHATWG). ※ [22] 의 전제 수정: UTF-8 한글을 EUC-KR 로 풀면 U+FFFD 비율이 ≈0 이 아니라 12~32% 라 5% 게이트가 걸려 "깨진 제목 저장" 이 아니라 "멀쩡한 페이지의 텍스트를 버리고 needs_client" 가 실제 증상이었다 — 수정으로 정상 디코드.
- [6][25] html.ts: "og:type=website ∧ og:description == meta description → 버림" 추론 제거(Stack Overflow·MDN·Next.js 템플릿의 진짜 설명을 날렸다; 당근 어댑터의 우회도 함께 제거), 명시 패턴만 유지; `<meta>`/`<link>` 끝 판정이 따옴표 안의 `>` 를 건너뜀(`findTagEnd`, 16 KB 상한, 선형).
- [1][5][7][23][24] sites: 카페 `/f-e/cafes/<clubid>/articles/<id>` 인식 + 홈/게시판 canonical = 자기 URL + 예약 첫 세그먼트; t.co·lnkd.in·Reddit `/s/` 는 첫 Location 만 읽고 호스트로 분기(외부 → generic, 자기 자신/무응답 → `*_unresolved`, 404/410 → `gone`); 인스타 `/reels/audio/` 예약어 → generic. 테스트 가짜 io 가 fetch.ts 리다이렉트 의미를 재현.
- [8][9][27][28] 클라이언트 catch-up: 폰 타임아웃(`timedOut`)·화면 이탈의 빈 결과는 제출하지 않음; 전송 실패한 id 는 Set 에서 해제; `forgetPreviewRetryState(postId)` 를 수동 재시도가 호출; 폴더당 배치 하나(`fetchInFlight`/`assistInFlight`); POST_LIST 와 함께 GROUP_ACTIVITY invalidate(usePosts·useFolders·catch-up·재시도 모두).
- [11][19][26][30] 수동 재시도: 토스트를 `results[0]` 으로 분기(ready/in_progress/실패, viewer forbidden 문구), `onSettled` invalidate, 되돌리기는 그 행만, 요청 직전에 낙관 fetching 재설정.
- [12][15]: `preview_title` 키는 힌트가 있을 때만 insert 바디에(usePosts·useFolders) — 힌트 없는 저장은 005 전에도 성공. 그래도 새 앱은 005 를 요구한다(§9 호환성, 되돌릴 땐 앱 먼저).
- [29]: `FolderDetailScreen` 의 `handleEditPress`/`handleRetryPreview` 가 `postListRef` 를 읽어 deps `[]` — 카드 `React.memo` 유지.
- [31]~[36] parseMetadata: 코드포인트 단위 자르기, ATTR_RE 선형화 + 태그 16 KB, content-length 2 MB 를 `text()` 전에 확인(4 fetcher 모두), 인스타 캡션 64 KB + `</div>` 폴백, TikTok 은 영상 URL 만 SSR(그 외 generic), URL 힌트 2048자. [36] 잔여(한글 설명 1000자 + URL 2개면 8 KB 초과 가능)는 `invoke.ts fitFetchBody` 가 닫는다 — fetch 바디의 UTF-8 바이트가 7680 을 넘으면 description → image_url → canonical_url → author 순으로 덜어낸다.
- 통합 단계 추가: catch-up 의 stale fetching 후보도 `preview_attempts < 5`(서버 상한과 동일) 로 걸러 max_attempts 로 돌아올 요청을 보내지 않는다.
- [37]: domainInfo 의 TikTok·쿠팡 `opensInApp: true` 와 openLink.ts 를 §1·§4-10 (e) 에 기록(동작은 유지).
- [16]: 반증 — CLI 3.0.0 은 `supabase/config.toml` 없이 배포 명령이 API 까지 간다(§4-5). `supabase init` 추가하지 않음.

---

## 14. 작업 규칙 (사용자 선호 — 이전 인계 문서와 동일)

- 커밋 메시지: `feat. 한국어 설명` / `fix.` / `chore.` / `test.` 형식. **Co-Authored-By 트레일러 넣지 않음**(사용자가 명시적으로 요청). 이번 작업 권장 메시지: `feat. 링크 미리보기 서버 수집 — posts.preview_* + link-preview 함수 + 카드 DB 렌더`.
- `.gitignore` 가 README 외 모든 `*.md` 를 무시한다. 이 문서는 `git add -f docs/superpowers/HANDOFF-2026-11-04-link-preview.md` 로 개별 추가(규칙 자체는 건드리지 않음 — 사용자 설정).
- 패키지 매니저 bun. 네이티브 의존성은 `npx expo install`. `bun run format` / `prettier --write` 를 기존 파일에 돌리지 않는다(Prettier 미정렬 파일 27개).
- **Android Play Alpha 비공개 테스트 기간 중(가장 빠른 프로덕션 신청 ~2026-11-12) Alpha 외 트랙에 빌드 업로드 금지.** 이 작업은 Android 코드를 바꾸므로 로컬 APK(`bun run android:apk`)·개발 빌드로만 확인하고 Play 업로드는 하지 않는다. 비공개 테스트가 끝난 뒤 버전·versionCode 올려 릴리스(`docs/superpowers/plans/2026-11-01-ios-share-extension.md` 와 memory `release-versioning-flow` 참고).
- 비밀(`LINK_PREVIEW_WEBHOOK_SECRET`, Vault 값, service_role 키)은 채팅·파일·커밋·로그 어디에도 적지 않는다. `.env` 는 커밋되지 않는다(`scripts/check-env.js` 가 빌드 전 검사).
- 사용자는 한국어로 소통. 세션 간 인계는 이 폴더(`docs/superpowers/HANDOFF-*.md`) 에 날짜별로 쌓는다.
