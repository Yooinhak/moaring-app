# 링크 미리보기 서버 수집 (link-preview) 설계

- 상태: 최종 합성안 (2026-11-04). coverage-first / ops-light / security-integrity 3안 + 심사 2건을 종합.
- 심사 결정: 두 심사가 승자를 달리 봤다(① ops-light, ② security-integrity). 합계는 76 : 74 로 사실상 동률이며, 두 심사가 지적한 구멍은 서로의 장점으로 정확히 메워진다. 따라서 **골격은 ops-light**(마이그레이션 1개 + Edge Function 1개 + 버킷 1개, 앱이 저장 직후 호출 + 폴더 열 때 catch-up, 어떤 상태에서도 카드는 도메인 카드), **무결성 층은 security-integrity**(컬럼 단위 GRANT, claim RPC 원자 선점, https·길이 CHECK, tombstone 으로 Storage 고아 정리, SSRF fail-closed) 를 택했다. 두 안이 갈린 "수집 트리거를 누가 소유하나" 는 **DB 트리거(pg_net + Vault)를 SQL 에 포함하되 Vault 비밀이 없으면 조용히 비활성** 으로 두어, 사용자가 비밀 2개를 등록하는 순간 서버 소유로 바뀌게 했다(공유 시트에서 프로세스가 죽어도 수집). pg_cron 은 v1 에서 쓰지 않는다 — 재시도·백필·GC 는 모두 "폴더를 열 때" 와 "함수 호출 끝" 에 얹는다(심사① 의 운영 부담 지적 수용). coverage-first 에서는 전략 표의 세부 규칙, 공유 텍스트 제목 힌트, 순수 파서 모듈 + bun 테스트, unsupported 상태, canonical 재활용을 가져왔다.

## 1. 배경

- `src/utils/parseMetadata.ts` 가 카드마다 Microlink → 기기 HTML 정규식 파싱을 반복한다. Microlink 무료는 **IP 당 5회/일**(`x-rate-limit-limit: 5`, 429 관측) 이라 사실상 죽었다.
- 인스타그램 게시물 페이지는 og:title/og:description 이 없고 `<title>` 이 'Instagram' 이라 ~100개 중 절반이 빈 카드. 썸네일 CDN URL 은 `oe=`(hex epoch) 서명이 **약 4.4일** 뒤 만료되고 쿼리를 떼면 403 'Bad URL hash'.
- 결과가 React Query 메모리(staleTime 2분)에만 있어 기기마다·열 때마다 재수집. Android 는 cleartext 차단으로 http 썸네일이 조용히 깨진다(memory: kakao-http-avatar-cleartext).

## 2. 목표 / 비목표

목표: (1) 저장 시점에 서버가 1회 수집해 `posts.preview_*` 에 영구 보관 (2) 썸네일은 Supabase Storage 공개 버킷 `link-previews` 로 복사해 https URL 만 렌더 (3) 사용자가 요구한 사이트군(인스타·스레드·유튜브·X·네이버 전부·쿠팡·틱톡·핀터레스트·한국 커머스·EUC-KR 포함 범용 og) 을 프로브로 **검증된** 전략으로 커버 (4) 서버가 봇 차단된 사이트는 사용자의 폰(주거용 IP) 이 1회 보조 (5) 기존 ~100건 지연 백필 (6) SSRF-safe·남용 불가 (7) 구버전 앱과 어떤 배포 순서에서도 깨지지 않음.

비목표: Realtime 도입, Microlink 의존(키 설정 시에만 켜지는 어댑터 자리만 남김, v1 미구현), 쿠팡·스마트스토어·네이버 플레이스의 WebView 추출(v2, 훅 포인트만), iOS 공유 확장, 썸네일 리사이즈(Edge 에 sharp 없음).

## 3. 아키텍처

```
[앱: SaveLinkSheet / FAB]                 [DB: posts]                      [Edge Function: link-preview]
 insert({url, description, folder_id,     ─AFTER INSERT 트리거(pg_net)──▶  mode webhook  (x-webhook-secret, Vault 비밀 있을 때만)
         preview_title: 공유텍스트 힌트})                                   claim → provider → image → UPDATE preview_*
   .select('id')                                                             ▲
   └─ fire-and-forget invoke ───────────────────────────────────────────────┘ mode fetch (user JWT, post_id | post_ids≤8, device 힌트 — device/force 는 owner/editor)
[FolderDetailScreen 진입] ─ pending/일시 failed/stale fetching 배치 ─▶ mode fetch       ── 끝에 tombstone ≤10 GC(행 삭제 → 생존 확인 → remove)
                          ─ needs_client 행: 폰이 parseOnDevice → ─▶ mode assist (owner/editor)
[롱프레스 → 메모 수정 시트 → 미리보기 다시 불러오기] ───────────▶ mode fetch force (60s 쿨다운)
(선택) pg_cron / curl ────────────────────────────────────────▶ mode sweep (x-webhook-secret)
[Storage: link-previews/posts/<post_id>/<sha256 16>.<ext>]  ◀── 서버만 업로드, 공개 읽기
```

세 겹 수집 경로가 모두 같은 함수·같은 `processPost` 로 수렴하고, `claim_post_preview` 가 한 행을 한 워커만 처리하게 한다.

## 4. 데이터 모델 — `supabase/migrations/005_link_previews.sql` (전문, 2026-11-04 리뷰 반영판과 동기: stale fetching 재선점 `attempts < 5`, RETURNING `url::text` 캐스트, 스윕의 assist 종결 행 제외, 되돌리기 맨 앞 `cron.unschedule`)

```sql
-- ----------------------------------------------------------------------------
-- 005_link_previews.sql  (2026-11-04)
--
-- 링크 미리보기(제목·설명·썸네일)를 "저장 시점에 서버가 1회" 수집해 posts 행에 보관한다.
-- 지금은 모든 기기가 카드마다 Microlink(무료 5회/일/IP → 429) → 기기 HTML 파싱을 반복해
-- 인스타 링크 절반이 빈 카드로 보이고, 인스타 썸네일 CDN URL(oe= 서명)은 4~5일 뒤 만료된다.
--   ① posts 에 preview_* 컬럼 추가 (전부 nullable / 기본값 → 구버전 앱 insert·select 영향 없음)
--   ② 큐 부분 인덱스 + canonical 재활용 인덱스
--   ③ 컬럼 단위 GRANT — preview_* 는 서버(service_role) 만 쓴다. 클라이언트는 공유 텍스트에서 뽑은
--      제목 힌트(preview_title, ≤300자) 만 insert 때 넣을 수 있다.
--      ("Editors can update posts" 정책은 컬럼을 가리지 않아 editor 가 타인 글의 미리보기를 바꾸거나
--       외부 이미지 URL(추적 픽셀)을 심을 수 있었다)
--   ④ 워커 선점 RPC claim_post_preview / 스윕 후보 RPC pick_preview_jobs (service_role 전용)
--   ⑤ Storage 고아 방지 tombstone 테이블 + 트리거 (이미지 교체·행 삭제·cascade·계정 삭제 모두)
--   ⑥ Storage 버킷 link-previews (공개 읽기, 쓰기는 service_role 만 → storage.objects 정책 없음)
--   ⑦ insert → Edge Function 비동기 호출 트리거 (pg_net + Vault). Vault 비밀이 없으면 조용히 건너뛴다.
--
-- ⚠️ 실행 순서: 컬럼 추가만 있으므로 앱 버전과 무관하게 먼저 실행해도 된다 (004 와 달리 삭제 없음).
--    이 SQL → Edge Function 배포 → (선택) Vault 비밀 + Edge Secret → 앱 업데이트.
--    이 Mac 에는 supabase CLI 가 없고 라이브 DB 접속도 없다 — 대시보드 SQL Editor 에서 사용자가 직접 실행한다.
--    ③ 이후 클라이언트가 {url, description, folder_id, preview_title} 외 컬럼을 insert 하거나
--    {description, folder_id} 외 컬럼을 update 하면 42501 — 현재 앱은 정확히 이 범위만 쓴다.
--    새 컬럼을 앱이 쓰게 되면 아래 grant 목록에 추가할 것 (src/utils/preview/types.ts 상단 주석과 동기).
-- ⚠️ 되돌리기: 파일 맨 아래 주석. preview_* 를 지워도 url·description 은 보존된다.
-- ⚠️ CHECK 값은 `supabase gen types` 가 만드는 generated types(src/utils/supabase/types.ts) 에 안 보인다
--    (memory: supabase-check-constraints) → src/utils/preview/types.ts 의 PREVIEW_STATUSES 와 수동 동기.
-- ----------------------------------------------------------------------------

begin;

-- ① 컬럼 — posts.description 은 사용자 메모이므로 절대 재활용하지 않는다
alter table public.posts
  add column if not exists preview_title         text,
  add column if not exists preview_description   text,
  add column if not exists preview_author        text,          -- 채널명·@계정·기자명 (설명 없을 때 부제)
  add column if not exists preview_site_name     text,          -- 서버가 판정한 브랜드 라벨 ('네이버 지도', '쿠팡' …)
  add column if not exists preview_image_url     text,          -- Storage 공개 URL(https). 원본 CDN URL 은 넣지 않는다
  add column if not exists preview_image_path    text,          -- 버킷 내 경로 posts/<id>/<sha16>.<ext> — 삭제·GC 용
  add column if not exists preview_image_src     text,          -- 수집 당시 원본 이미지 URL (디버깅·재시도용, 렌더 금지)
  add column if not exists preview_canonical_url text,          -- 리다이렉트·추적 파라미터 정리 후 URL. posts.url 은 원문 유지
  add column if not exists preview_provider      text,          -- 'youtube' | 'instagram' | 'x' | 'naver_blog' | … | 'generic'
  add column if not exists preview_source        text,          -- 'oembed' | 'embed' | 'og' | 'redirect' | 'slug' | 'direct' | 'device' | 'hint'
  add column if not exists preview_status        text not null default 'pending',
  add column if not exists preview_attempts      smallint not null default 0,
  add column if not exists preview_claimed_at    timestamptz,   -- fetching 선점 시각 (2분 지나면 stale → attempts < 5 이면 재선점)
  add column if not exists preview_fetched_at    timestamptz,   -- 마지막 처리 완료 시각 (성공·실패 공통)
  add column if not exists preview_error         text,          -- 짧은 코드: blocked:cloudflare | gone | timeout | http_5xx | needs:webview …
  add column if not exists preview_assisted_by   uuid;          -- 기기 보조(assist) 제출자 (감사용)

alter table public.posts drop constraint if exists posts_preview_status_check;
alter table public.posts add constraint posts_preview_status_check
  check (preview_status in ('pending', 'fetching', 'ready', 'needs_client', 'failed', 'unsupported'));
--   pending      : 미시도 (신규 기본값, 기존 행 백필 큐)
--   fetching     : 워커가 선점함 (claimed_at 2분 지나면 죽은 것으로 봄 → attempts < 5 까지만 재선점, 이후는 force 만)
--   ready        : 완료 — 제목·이미지가 null 일 수 있다 (= 도메인 카드)
--   needs_client : 서버(데이터센터 IP)가 차단됨 → 폰이 1회 보조
--   failed       : 일시 실패. attempts < 3 이면 catch-up 이 재시도
--   unsupported  : 영구 실패 (삭제·404·EmbedBrokenMedia·oEmbed 400). 재시도 버튼 숨김, force 만 가능

-- Android 는 cleartext 차단 → http 썸네일이 조용히 깨진다. DB 에서부터 https 만 허용
alter table public.posts drop constraint if exists posts_preview_image_url_https_check;
alter table public.posts add constraint posts_preview_image_url_https_check
  check (preview_image_url is null or preview_image_url like 'https://%');

alter table public.posts drop constraint if exists posts_preview_lengths_check;
alter table public.posts add constraint posts_preview_lengths_check
  check (
    coalesce(char_length(preview_title), 0) <= 300
    and coalesce(char_length(preview_description), 0) <= 1000
    and coalesce(char_length(preview_author), 0) <= 120
    and coalesce(char_length(preview_error), 0) <= 120
  );

-- ② 인덱스
create index if not exists posts_preview_queue_idx
  on public.posts (created_at desc)
  where preview_status not in ('ready', 'unsupported');

create index if not exists posts_preview_canonical_idx
  on public.posts (preview_canonical_url)
  where preview_status = 'ready' and preview_canonical_url is not null;

-- ③ 컬럼 단위 GRANT (RLS 정책은 001 §6-7 그대로)
--    user_id 는 컬럼 default(auth.uid()), group_id 는 BEFORE 트리거 set_post_group 이 채우므로 권한 불필요.
--    RETURNING 은 SELECT 권한(전체 유지)으로 평가된다.
revoke insert, update on public.posts from authenticated;
grant insert (url, description, folder_id, preview_title) on public.posts to authenticated;
grant update (description, folder_id) on public.posts to authenticated;
revoke insert, update, delete on public.posts from anon;

-- ④ 워커 RPC (service_role 전용)
--    RETURNS TABLE 의 출력 변수(id, url, folder_id, group_id, attempts …)와 충돌하지 않도록
--    본문의 컬럼 참조는 전부 p. 로 한정한다 (plpgsql variable_conflict=error 기본값).
--    RETURN QUERY 는 컬럼 타입 OID 가 선언과 정확히 같아야 한다(varchar≠text → 42804) — posts.id·folder_id·url 은
--    라이브 타입을 생성 타입(src/utils/supabase/types.ts)만으로는 알 수 없으므로 전부 명시 캐스트한다.
--    stale fetching 재선점은 attempts < 5(= Edge BUDGET.maxAttempts) 까지만 — 처리 중 매번 죽는 행(isolate 강제 종료 등)을
--    스윕·catch-up 이 2분마다 영원히 재선점하지 않도록. 그 뒤로는 p_force 만 건드린다.
create or replace function public.claim_post_preview(p_post_id bigint, p_force boolean default false)
returns table (id bigint, url text, folder_id bigint, group_id uuid, attempts smallint,
               prev_image_path text, hint_title text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.posts p
     set preview_status     = 'fetching',
         preview_claimed_at = now(),
         preview_attempts   = least(p.preview_attempts + 1, 32767)
   where p.id = p_post_id
     and p.group_id is not null                       -- group_id null 행은 RLS 상 아무도 못 본다
     and (
       p_force
       or p.preview_status in ('pending', 'needs_client')
       or (p.preview_status = 'failed'   and p.preview_attempts < 3)
       or (p.preview_status = 'fetching' and p.preview_claimed_at < now() - interval '2 minutes'
           and p.preview_attempts < 5)
     )
  returning p.id::bigint, p.url::text, p.folder_id::bigint, p.group_id, p.preview_attempts,
            p.preview_image_path, p.preview_title;
end;
$$;

-- 스윕 후보: pending → failed(10·20·40분 지수 백오프) → stale fetching(attempts < 5, claim 과 같은 상한). 최신 저장 우선.
create or replace function public.pick_preview_jobs(p_limit int default 8)
returns setof bigint
language sql
security definer
set search_path = public
stable
as $$
  select p.id::bigint
  from public.posts p
  where p.group_id is not null
    and (
      p.preview_status = 'pending'
      or (p.preview_status = 'failed' and p.preview_attempts < 3
          -- 폰 보조까지 끝난 행(needs:webview · device_*)은 서버가 다시 돌려도 같은 결과라 스윕에서 제외
          and coalesce(p.preview_error, '') not like 'needs:%'
          and coalesce(p.preview_error, '') not in ('device_blocked', 'device_empty')
          and coalesce(p.preview_fetched_at, p.preview_claimed_at, p.created_at)
              < now() - (interval '10 minutes' * power(2, p.preview_attempts)))
      or (p.preview_status = 'fetching' and p.preview_claimed_at < now() - interval '2 minutes'
          and p.preview_attempts < 5)
    )
  order by p.created_at desc
  limit greatest(1, least(p_limit, 20));
$$;

revoke all on function public.claim_post_preview(bigint, boolean) from public, anon, authenticated;
revoke all on function public.pick_preview_jobs(int) from public, anon, authenticated;
grant execute on function public.claim_post_preview(bigint, boolean) to service_role;
grant execute on function public.pick_preview_jobs(int) to service_role;

-- ⑤ Storage 고아 방지 tombstone — storage.objects 를 SQL 로 지우면 S3 객체가 남으므로 함수가 Storage API 로 지운다
create table if not exists public.preview_image_tombstones (
  path       text primary key,
  created_at timestamptz not null default now()
);
alter table public.preview_image_tombstones enable row level security;
revoke all on public.preview_image_tombstones from anon, authenticated;

create or replace function public.tombstone_post_preview_image()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.preview_image_path is not null then
      insert into public.preview_image_tombstones (path) values (old.preview_image_path)
      on conflict (path) do nothing;
    end if;
    return old;
  end if;
  if old.preview_image_path is not null and old.preview_image_path is distinct from new.preview_image_path then
    insert into public.preview_image_tombstones (path) values (old.preview_image_path)
    on conflict (path) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_post_deleted_tombstone_preview on public.posts;
create trigger on_post_deleted_tombstone_preview
  after delete on public.posts
  for each row execute function public.tombstone_post_preview_image();

drop trigger if exists on_post_preview_image_replaced on public.posts;
create trigger on_post_preview_image_replaced
  after update of preview_image_path on public.posts
  for each row execute function public.tombstone_post_preview_image();

-- ⑥ Storage 버킷 — 공개: expo-image 가 URL 만으로 디스크 캐시해야 한다. 경로에 post_id + sha 조각 → 추측 어려움
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('link-previews', 'link-previews', true, 3145728,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ⑦ insert → Edge Function (pg_net). 함수 본문 전체를 exception 으로 감싼다:
--    supabase_vault 미설치·권한 부족·pg_net 오류 어떤 경우에도 링크 저장은 성공해야 한다 (공유 시트는 저장 직후 Activity 를 닫는다).
--    body 에 url 을 넣지 않는다 — 함수는 항상 DB 의 posts.url 만 fetch 한다 (요청 본문 URL 미신뢰 = SSRF 프록시 방지).
create extension if not exists pg_net;

create or replace function public.enqueue_link_preview()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  if new.group_id is null then
    return new;
  end if;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'link_preview_webhook_secret'
   limit 1;
  if v_secret is null then
    return new;   -- 비밀 미등록 = 트리거 비활성. 앱 호출 + 폴더 catch-up 이 대신 수집한다
  end if;
  perform net.http_post(
    url                  := 'https://yvhyjxdxksdddunjmjdo.supabase.co/functions/v1/link-preview',
    body                 := jsonb_build_object('mode', 'webhook', 'post_id', new.id),
    headers              := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists on_post_created_enqueue_preview on public.posts;
create trigger on_post_created_enqueue_preview
  after insert on public.posts
  for each row execute function public.enqueue_link_preview();

commit;

-- ----------------------------------------------------------------------------
-- 수동 1단계 (선택·권장, 서버 소유 트리거 활성화): 값은 `openssl rand -hex 32`, Edge Secret LINK_PREVIEW_WEBHOOK_SECRET 과 같은 값
--   select vault.create_secret('<hex64>', 'link_preview_webhook_secret', 'link-preview x-webhook-secret');
-- 수동 2단계 (선택, v1 미사용): pg_cron 5분 스윕
--   create extension if not exists pg_cron;
--   select cron.schedule('link-preview-sweep', '*/5 * * * *', $cron$
--     select net.http_post(
--       url := 'https://yvhyjxdxksdddunjmjdo.supabase.co/functions/v1/link-preview',
--       body := '{"mode":"sweep","limit":8}'::jsonb,
--       headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret',
--                   (select decrypted_secret from vault.decrypted_secrets where name='link_preview_webhook_secret')),
--       timeout_milliseconds := 5000);
--   $cron$);
-- 적용 후: bun run update-types
-- 검증:
--   select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='posts' and column_name in ('id','url','folder_id');  -- ④ RETURNING 캐스트 전제(bigint·text·bigint). varchar 여도 ::text 로 통과
--   select preview_status, count(*) from public.posts group by 1;                               -- 전부 pending
--   select grantee, privilege_type, column_name from information_schema.column_privileges
--     where table_schema='public' and table_name='posts' and grantee='authenticated';
--   select id, public, file_size_limit from storage.buckets where id='link-previews';
--   select id, status_code, left(content::text,200) from net._http_response order by id desc limit 5;  -- ~6h 보관
-- 되돌리기:
--   -- 수동 2단계(pg_cron 스윕)를 했다면 먼저 멈춘다 — 안 멈추면 5분마다 없는 pick_preview_jobs 를 부르며 500 을 영원히 남긴다.
--   -- pg_cron 미설치·잡 없음이면 조용히 통과. DO 블록 안이라 select 가 아니라 perform 이어야 한다.
--   do $$ begin perform cron.unschedule('link-preview-sweep'); exception when others then null; end $$;
--   drop trigger if exists on_post_created_enqueue_preview on public.posts;
--   drop trigger if exists on_post_deleted_tombstone_preview on public.posts;
--   drop trigger if exists on_post_preview_image_replaced on public.posts;
--   drop function if exists public.enqueue_link_preview(), public.tombstone_post_preview_image(),
--     public.pick_preview_jobs(int), public.claim_post_preview(bigint, boolean);
--   drop table if exists public.preview_image_tombstones;
--   grant insert, update on public.posts to authenticated;
--   alter table public.posts drop column if exists preview_title, drop column if exists preview_description,
--     drop column if exists preview_author, drop column if exists preview_site_name, drop column if exists preview_image_url,
--     drop column if exists preview_image_path, drop column if exists preview_image_src, drop column if exists preview_canonical_url,
--     drop column if exists preview_provider, drop column if exists preview_source, drop column if exists preview_status,
--     drop column if exists preview_attempts, drop column if exists preview_claimed_at, drop column if exists preview_fetched_at,
--     drop column if exists preview_error, drop column if exists preview_assisted_by;
--   버킷: Storage UI 에서 비운 뒤 delete from storage.buckets where id='link-previews';
-- ----------------------------------------------------------------------------
```

## 5. Edge Function 계약 — `supabase/functions/link-preview/`

배포 `npx supabase functions deploy link-preview --no-verify-jwt --project-ref yvhyjxdxksdddunjmjdo`(레포에 `supabase/config.toml` 이 없어도 CLI 3.0.0 은 배포 명령을 받는다 — HANDOFF §4-5; `--project-ref` 는 3.x 에서 deprecated, `--remote=<ref>` 가 후속). delete-account 관례(한국어 헤더, `// @ts-nocheck` 설명, std@0.224 `serve`, esm.sh supabase-js@2.45.4, `corsHeaders`, `{success, step, error}`). `tsconfig.json` 이 `supabase/functions/**` 를 제외하므로 Deno 코드가 앱 타입체크를 깨지 않는다. 순수 파서 모듈(Deno 전역·URL import 없음)은 `bun test supabase/functions/link-preview` 로 검증한다 — 이 Mac 에 deno 가 없으므로 배포 전 검증 수단은 이것뿐이다.

```ts
// POST /functions/v1/link-preview
// 인증 A: Authorization: Bearer <user JWT>              → fetch | assist
// 인증 B: x-webhook-secret == env LINK_PREVIEW_WEBHOOK_SECRET (상수시간 비교; env 없으면 401) → webhook | sweep
type DeviceHints = { title?: string|null; description?: string|null; image_url?: string|null;
                     author?: string|null; canonical_url?: string|null;
                     html?: string|null;              // 인스타 임베드·TikTok SSR 원문 (≤256 KB, assist 에서만 — fetch 바디는 8 KB)
                     blocked?: boolean; http_status?: number };
type Req =
  | { mode: 'fetch'; post_id: number; device?: DeviceHints|null; force?: boolean } // 저장 직후 가속 · 수동 재시도. device/force 는 owner/editor(아니면 403 forbidden)
  | { mode: 'fetch'; post_ids: number[] }                                       // 폴더 catch-up, ≤8. device/force 를 함께 보내면 400
  | { mode: 'assist'; post_id: number; device: DeviceHints }                    // 폰 파싱 결과 제출 (owner/editor)
  | { mode: 'webhook'; post_id: number }                                        // DB 트리거 → 202 즉시 + EdgeRuntime.waitUntil
  | { mode: 'sweep'; limit?: number };                                          // pick_preview_jobs → 순차, 60s 예산
type Res = { success: boolean; step?: string; error?: string; accepted?: boolean;
  results?: Array<{ post_id: number; status: PreviewStatus; source?: string; error?: string|null;
    skipped?: 'not_found'|'in_progress'|'max_attempts'|'cooldown'|'forbidden';
    client_task?: { post_id: number; folder_id: number; url: string; runner: 'fetch'|'webview';
                    parser: 'generic'|'instagram_embed'|'tiktok_ssr' } }> };
```

- 사용자 모드는 **userClient 로 `posts.select(...).in('id', ids)`** 해 RLS 가 보여주는 행만 처리(안 보이면 `not_found`). `adminClient` 로 `is_group_member` 를 부르지 않는다(auth.uid() null). 편집 권한은 `userClient.rpc('is_group_member', {p_group, p_roles:['owner','editor']})` — assist 와, **fetch 에 `device`(객체) 또는 `force:true` 가 실린 경우** 둘 다(viewer → 403 `{step:'forbidden', results:[{skipped:'forbidden'}]}`; RPC 오류도 거절). 힌트 없는 fetch 는 서버가 받아오는 것뿐이라 viewer 도 허용. 폰 힌트가 저장 내용을 바꾸는 경로는 전부 이 게이트 뒤에 있다.
- 함수는 **요청 바디의 URL 을 절대 fetch 하지 않는다**. fetch 대상은 claim 이 돌려준 `posts.url` 과 provider 가 그로부터 계산한 고정 엔드포인트만. 예외는 device.image_url 하나 — https + SSRF 검사 + provider `imageHosts` 허용목록 + 서버 재다운로드(image/* 매직바이트) 후에만 저장. 폰이 준 canonical(`device.canonical_url`, 제출 HTML 의 og:url/link[rel=canonical]) 은 **posts.url(또는 서버 canonical) 과 같은 사이트일 때만**(`isSameSiteUrl`: `www.`/`m.` 을 뗀 호스트가 같거나 점 경계 하위 도메인) 파서 기준 URL·`preview_canonical_url` 로 쓴다 — 아니면 서버 canonical 로 돌아가고 폰 값은 저장하지 않는다(findDonor 가 그룹 전체에 퍼뜨리는 값이라서).
- `processPost(id, {force, device})`: `claim_post_preview` → 0행이면 `in_progress`/`max_attempts` → `canonicalize(url)` → 같은 그룹에 `preview_canonical_url` 일치·ready(7일 이내) 행이 있으면 preview_* 복사 + `storage.copy` 로 **post 별 경로**에 복제(네트워크 0회) → provider 선택 → 폰 힌트 정제(`sanitizeDeviceHints` → `applyCaptionPolicy`: adapter 가 `instagram` 이면 `description` 은 `INSTAGRAM_STORE_CAPTION=full` 일 때만) → `run(ctx)` → 서버가 ready 면 빈 필드만 `device` 힌트로 채움, 서버가 못 읽었으면(needs_client·failed) 폰 제목/이미지가 결과가 되어 ready/'device'(이미지는 재다운로드) → 이미지 후보 순차 복사 → 정규화(NFC·제어문자 제거·길이 캡) → 단일 UPDATE(`preview_*`, `preview_fetched_at=now`, `preview_claimed_at=null`) → 예외는 `failed` + 코드. `hint_title`(공유 텍스트) 은 서버 제목이 없을 때 유지(source 'hint').
- 저장 직후 가속 fetch 는 DB 트리거 webhook 과 거의 동시에 도착해 보통 선점에 진다 — 그러면 processPost 가 device 를 읽지 못한다. 그래서 index.ts 는 **단건 + device 가 `in_progress` 로 끝나고 백그라운드 작업이 없으면** 750 ms 간격으로 ≤10 s(20 s 예산 − 4 s assist 예비) 그 행을 폴링해, needs_client/failed 로 끝나면 `applyAssist`(html 제외) 로 힌트를 적용하고 그 결과를 `results[0]` 으로 돌려준다(ready/unsupported 로 끝나면 관측한 상태만, 아직 fetching 이면 `in_progress` 그대로). 경합 때만 가속 호출이 ≤10 s 길어진다.
- 예산: HTML 10 s·1 MiB(스트림 캡 + `</head>`/`<body` 조기중단; Range 는 5곳 중 4곳이 무시), 이미지 8 s·3 MiB, 단건 25 s, 배치 ≤8 을 **동시 2** 로(CPU 2 s/요청 예산 — 인스타 512 KB·틱톡 1 MiB 정규식이 겹치지 않게). webhook/sweep 은 202 후 `EdgeRuntime.waitUntil`. 모든 fetch/sweep/assist 호출 끝에 `preview_image_tombstones` 상위 10건 GC(크론 없는 GC): **행을 먼저 지우고(RETURNING) 실제로 지워진 경로만** → 그중 `posts.preview_image_path` 가 아직 가리키는 경로는 건너뜀(`tombstone_kept_live`) → 나머지 `storage.remove`. remove 실패는 재시도되지 않고 고아로 남아 로그(`tombstone_remove_failed`)에만 찍힌다(행 삭제 실패는 아무것도 건드리지 않아 다음 호출이 재시도).
- 쿨다운·남용: force 는 post 당 60 s(`preview_claimed_at/fetched_at`) → 429 `cooldown`; attempts ≥ 5 비-force → `max_attempts`; stale fetching 재선점(claim·pick 둘 다)도 attempts < 5 까지만; 배치 8; 레이트리밋 테이블은 두지 않는다(무한 증식 지적 수용).
- User-Agent: **설정하지 않는다**(런타임 기본값). 모든 프로브가 curl 기본 UA 였고 'compatible; …Bot' 류는 WAF 가 더 엄격히 볼 수 있어 미검증 변수를 추가하지 않는다. 브라우저 UA 스푸핑은 금지. 각 provider 에 `serverFetch: boolean` 플래그를 두어 배포 후 데이터센터 IP 에서 차단이 확인되면 코드 1줄로 `needs_client` 직행.

## 6. 도메인별 전략 표 (관측 기준 2026-11-04, 한국 주거용 IP·curl 기본 UA; Edge egress 에서는 전부 미검증)

| 도메인 | 서버 전략 (관측됨) | 폴백 | 비고 |
|---|---|---|---|
| youtube.com·www/m/music·youtu.be·youtube-nocookie.com | 11자 id 추출(youtu.be 첫 경로 / `v` 쿼리 / `/(shorts\|live\|embed\|v\|e)/<id>`) → `GET https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D<id>&format=json` (원본 URL 금지: /embed/·/v/ 는 404) → title·author_name. 썸네일은 oEmbed 480px 무시, `i.ytimg.com/vi/<id>/maxresdefault.jpg → sddefault → hqdefault` HEAD **200 만** 인정(404 도 image/jpeg 플레이스홀더). canonical `watch?v=<id>`, /shorts/ 원본이면 site_name 'YouTube Shorts' | oEmbed 400 → unsupported('gone'). 네트워크 오류 → watch 페이지 og(1 MiB 캡, 첫 og 가 ~777 KB; 로케일 보일러플레이트 설명 필터) | 설명 없음은 의도. 채널·재생목록은 generic |
| instagram.com `/p\|reel\|reels\|tv/<code>`, instagr.am (단 `/reels/audio/`·`/p\|reel\|reels\|tv/{embed,explore,videos}` 는 shortcode 가 아니라 generic) | igsh/utm 제거 → `GET https://www.instagram.com/p/<code>/embed/captioned/` 512 KB(조기중단 없음, Caption 이 뒤). `<img class="EmbeddedMediaImage" src>`(&amp; 디코드, srcset 640w 우선) / `<span class="UsernameText">` / `<div class="Caption">` 에서 `CaptionUsername` 제거·`CaptionComments` 이전·`<br>`→\n·태그 제거·엔티티 디코드. title = 캡션 첫 줄(≤80) 없으면 '@user • Instagram'. 이미지 **즉시** 복사(oe= ~4.4일 만료, 쿼리 제거 시 403). imageHosts *.cdninstagram.com·*.fbcdn.net | `EmbedBrokenMedia` 또는 302→프로필 → unsupported. `EmbeddedMediaImage` 없음/로그인/429 → 게시물 페이지 og:image + twitter:title('이름 (@user) • Instagram reel') → 그래도 없으면 needs_client(parser 'instagram_embed', 폰이 같은 임베드 URL 파싱) | 캡션 저장 범위는 decisionsForUser. 비공식 마크업 |
| threads.com·threads.net | generic og: og:title 'Name (@handle) on Threads' → author, og:description → title 첫 줄+description, og:image 가 아바타(경로 `t51.82787-19`)면 이미지 제외. .net → .com 301 | `/embed` 의 TextContentContainer → needs_client | 첨부 미디어 글 미검증. oEmbed 는 placeholder html → 미사용 |
| x.com·twitter.com·mobile.twitter.com·t.co | t.co 는 **첫 Location 만 읽는다**(`firstHopOnly`, hopAllow 없음 — 홉 0 의 SSRF 검사는 그대로) 뒤 호스트로 분기: X/Twitter 호스트면 status/profile 흐름, 그 외(대부분 외부 기사)면 `runGeneric(location)`(generic fetch 가 자기 SSRF·홉 검사). t.co→t.co 는 3회까지(`tco_unresolved`), Location 없는 404/410 → `gone`, 그 외 비-리다이렉트 → `http_*`/`tco_unresolved`, Location 이 URL 아님 → `redirect_invalid`. (hopAllow 로 따라가면 외부 홉이 `ssrf:hop_host` 로 영구 실패하던 것을 고침.) 숫자 id(`/<u>/status/<id>`, `/i/status/`, `/i/web/status/`), /photo/N·?s·?t 제거. `GET https://x.com/i/status/<id>` 32 KB(307 상대 Location). **404 는 'Post Not Found' og 를 담으니 상태코드 게이트** → unsupported. og:description → title, og:title 'Name (@h) on X' → author. twitter:card=summary_large_image 면 og:image 를 `?format=jpg&name=small` 로 복사; summary(아바타) 면 이미지 없음. 병행 `https://publish.x.com/oembed?url=<enc>&omit_script=true&dnt=true&hide_thread=true`(content-type JSON 확인; author_name, 첫 `<p>` 텍스트, 끝 `pic.twitter.com` 앵커 제거) | JS 셸이면 oEmbed 만으로 텍스트 카드 → needs_client | `/i/web/status/` 는 oEmbed 404 → 페이지 경로로만. 프로필 URL 은 'Posts by @h' ready |
| blog.naver.com·m.blog.naver.com (PostView.naver/.nhn) | 데스크톱은 og 없는 2.8 KB 프레임셋 → fetchUrl `https://m.blog.naver.com/<blogId>/<logNo>` 로 재작성(110 KB, og 완비). PostView 폼도 같이 정규화, canonical `blog.naver.com/<blogId>/<logNo>`, author=blogId. og:image `blogthumb.pstatic.net …?type=w2` **쿼리 변경 금지**(w800 → 404) | PostView.naver 데스크톱 → needs_client | 서로이웃 글 미검증 |
| n.news.naver.com·news.naver.com | `read.naver?oid&aid` → `n.news.naver.com/mnews/article/<oid>/<aid>` 직접 재작성. og 전부(엔티티 `&quot;` `&#x3D;` 디코드), imgnews.pstatic.net 복사 | generic | entertain/sports 호스트 미검증 → generic |
| naver.me | manual **1홉 Location 만**. map.naver.com + `pinId` 있으면 title=decodeURIComponent(title)(URLSearchParams — 순서 가변), canonical `map.naver.com/p/entry/place/<pinId>`, site_name '네이버 지도', 이미지 `https://ssl.pstatic.net/static/maps/assets/images/og-map-400x200.png`(지도 전용 허용 플레이스홀더) → ready(source 'redirect'). title 없는 신형(`/p/entry/place/<id>?placePath=`)·저장목록 → '네이버 지도' + needs_client('needs:webview'). 그 외 대상은 {*.naver.com, naver.me, *.pstatic.net} ≤6홉(http→https 1홉 추가) 후 generic | — | 레지스트리 'Naver Clip' oEmbed 는 지도 링크에 500 → 미사용 |
| map.naver.com·m.place·pcmap.place | **서버 fetch 안 함**(SPA 셸 / 첫 요청부터 429). place id → canonical, '네이버 지도' + 지도 og 이미지, needs_client('needs:webview') | 폰 fetch 1단계는 건너뜀(429 확실) → v2 WebView | 키 있는 Local Search API 범위 외 |
| smartstore·brand·shopping·search.shopping.naver.com | **서버 fetch 안 함**(429 '시스템오류' 정적 페이지 / 418). `/<storeId>/products/<pid>` → canonical, title = 공유 텍스트 힌트 또는 '<storeId> 스토어 상품', site_name '네이버 스마트스토어', needs_client('blocked:naver_shop') | 폰 fetch 1회(통과 여부 미검증) → 실패 시 'needs:webview' | m.smartstore 는 데스크톱 302 → 동일 |
| cafe.naver.com·m.cafe.naver.com | 글 단위 og 가 어떤 폼에도 없음. 데스크톱 `cafe.naver.com/<cafe>/<id>` 64 KB → `<title>` '중고나라 : 네이버 카페' 의 카페명(**charset=MS949/KSC5601/euc-kr → 'euc-kr' 디코더**). title '<카페명> 글', site_name '네이버 카페', ready. 글 폼 인식: `/<cafe>/<id>` · `/ca-fe\|f-e/cafes/<clubid>/articles/<id>`(`f-e` 는 2024 PC 개편 주소창 폼 `?boardtype=L&menuid=…`; canonical 은 `ca-fe` 폼, title = 힌트 ?? '네이버 카페 글', 네트워크 0회) · `ArticleRead.nhn?clubid&articleid` · `iframe_url`. 예약 첫 세그먼트(`ca-fe`, `f-e`, `*.nhn`) 는 카페명이 아니다 | URL 의 cafeName. **글이 아닌 카페 홈/게시판은 canonical = 자기 URL**(호스트만 cafe.naver.com 으로, 추적 파라미터 제거) 이라 다른 URL 과 canonical 을 공유하지 않는다(findDonor 가 '아이폰 팝니다' 를 다른 글에 복사하던 사고 차단); clubid 만 아는 게시판은 title null(도메인 카드, donor 불가) | 내부 article API 는 500. `/f-e/` 글 페이지가 SPA 셸인지는 미검증(네트워크 없이 고침) |
| link.coupang.com/a/<code> | manual **Location 만** 읽음(본문 0 B, www 로 따라가지 않음). `/vp/products/(\d+)` + itemId·vendorItemId → canonical `www.coupang.com/vp/products/<pid>?itemId=&vendorItemId=`(lptag·wPcid·mcid·traceid·itime·sharesource 제거). 없으면(만료 코드는 홈으로 302) unsupported('coupang_unresolved'). 허용 홉 호스트 {www., m.coupang.com} | 상품 페이지는 아래 | 1회 HEAD = 파트너스 클릭 1회로 집계될 수 있음 |
| www.coupang.com·m.coupang.com | **서버·폰 fetch 모두 안 함**(Akamai 403 'Access Denied', IP·헤더 무관 확인). title = 공유 텍스트 힌트 또는 '쿠팡 상품 <pid>', site_name '쿠팡', needs_client('needs:webview') | v2 WebView(og 추출, image 호스트 *.coupangcdn.com 만) | shop.coupang.com 은 generic og 정상 |
| tiktok.com·vm./vt.tiktok.com | 단축 해석(*.tiktok.com ≤5홉) → `/@u/video/<id>` 1 MiB → `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">` JSON `__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct.{desc, author.nickname, author.uniqueId, video.cover}`. cover 즉시 복사(x-expires) | 본문 <5 KB·'slardar_us_waf'·헤더 x-tt-system-error → needs_client(parser 'tiktok_ssr'); statusCode≠0 → unsupported | og 전무, oEmbed 는 html 만. 비공식 |
| pinterest.com·*.pinterest.com·pin.it | pin.it 해석(*.pinterest.com) → generic og(1.38 MB 지만 </head> 조기중단; i.pinimg.com 비서명). og:url 이 canonical | `www.pinterest.com/oembed.json?url=` (title·author_name·236px) | — |
| reddit.com·redd.it | HTML(JS 챌린지 200)·.json(403)·old(로그인) 전부 fetch 안 함. 앱 공유 링크 `/r/<sub>/s/<shareId>` 는 **첫 Location 으로 permalink(`/r/<sub>/comments/<id>/…`) 를 얻어** 그것을 canonical 로(같은 글이 하나로 모임; Location 이 reddit 밖 → `offsite_redirect`, 404/410 → `gone`, 리다이렉트 없음 → `reddit_unresolved`). 그 뒤 `https://www.reddit.com/oembed?url=<enc>` → title·author_name, site_name 'r/<sub>'(경로) | failed(재시도) | 이미지 없음. `/s/` 리다이렉터가 데이터센터 IP 에 로그인 페이지를 주면 oEmbed 404 → `gone` — 라이브 미검증 |
| facebook.com·linkedin.com/posts·lnkd.in | generic og. FB: og:description(본문) → title, og:title(페이지명) → author, 텍스트 글은 og:image 없음. LinkedIn: og + JSON-LD SocialMediaPosting, `static.licdn.com` 이미지는 플레이스홀더. **lnkd.in 은 첫 Location 만 읽고 분기**: `*.linkedin.com` 이면 LinkedIn 흐름(trk 등 제거한 URL 이 canonical; `/in\|company\|school/` → `login_wall`), 외부 기사면 `runGeneric(location)`(provider 는 `linkedin` 유지), lnkd.in→lnkd.in/리다이렉트 없음 → `lnkd_unresolved`, 404/410 → `gone` | LinkedIn 999 → needs_client 1회 → unsupported; `/in/` 프로필은 바로 unsupported | 데이터센터 IP 에서 로그인 벽 가능. (hopAllow 로 따라가면 lnkd.in 의 외부 기사가 전부 `ssrf:hop_host` 영구 실패였다) |
| medium.com·*.medium.com·*.notion.site | fetch 안 함(Medium: Cloudflare JS 챌린지 cf-mitigated — 폰 fetch 도 불가 / Notion: HTML 에 제목 없음, og 는 전역 기본값). 슬러그 제목(Medium 끝 12-hex 제거, Notion 32-hex 앞) → ready(source 'slug') | v2 WebView | — |
| github.com·brunch.co.kr·*.tistory.com·velog.io·v.daum.net·m.cafe.daum.net·place.map.kakao.com·kko.to/kko.kakao.com·ohou.se·kurly.com·daangn.com·chosun.com·joongang.co.kr·yes24.com·namu.wiki·그 외 전부 | **generic**: new URL 정규화(IDN→punycode) → SSRF → manual ≤8홉(홉마다 SSRF·상대 Location) → 2xx 아니면 저장 금지(4xx 의 `<title>Attention Required!` 저장 사고 차단; 404/410 → unsupported) → Content-Type 선분류(image/* → 자기 URL 복사·title=파일명·source 'direct'; application/pdf → title=파일명; 그 외 non-HTML → 파일명) → 1 MiB 스트림 캡 → charset(**BOM → 헤더 → `<meta>`** → utf-8 fatal → euc-kr — WHATWG decode 순서; euc-kr 헤더에 UTF-8(BOM) 파일을 올린 레거시 서버가 있어 BOM 이 헤더보다 앞; 라벨 trim·따옴표 제거, ms949/cp949/ksc5601/ks_c_5601-1987 → 'euc-kr', `new TextDecoder` try/catch; **응답마다** 판정 — yes24 는 메인 ks_c_5601-1987·상품 'UTF8') → 속성 순서·따옴표 무관 meta/title/link 파서(태그 끝 `>` 는 따옴표 안이면 건너뜀 — `content="홈 > 패션"`; 16 KB 상한, 선형) → 우선순위 title: og:title→twitter:title→`<title>`; description: og→twitter→meta[name=description]; image: og:image:secure_url→og:image→twitter:image→twitter:image:src→link[rel=image_src]→JSON-LD image→apple-touch-icon → 엔티티(명명·`&#039;` 0패딩·hex·세미콜론 누락)·`new URL(v, finalUrl)`(루트상대 nts.go.kr, 프로토콜상대 namu/kakao, 상대 og:url daum) → http(s) 외 스킴 거부(vnd.youtube://) → 플레이스홀더 제외(images.velog.io/velog.png, tistory_admin/…/opengraph.png, static.licdn.com, app.notion.com/…/default.png) → 보일러플레이트 설명은 **명시 패턴만** 버림(`BOILERPLATE_DESCRIPTION_PATTERNS`, 컬리 전역 문구; "og:description == meta description && og:type=website" 추론은 Stack Overflow·MDN·Next.js 템플릿의 진짜 설명을 날려서 뺐다) → 제어문자(\u0000) 제거·NFC·공백 정리 → 이미지 후보 2xx+image/*+매직바이트(SVG 제외) 검증. 유용함 = og:title || twitter:title || (`<title>` ≠ site_name ≠ hostname). og:title 없고 `<meta http-equiv=refresh>` 있으면 1회 추적(gov.kr) | SPA 셸(og 0 + 가시 텍스트 <300자 + noscript/빈 #root) → needs_client('needs:webview'). 403 + (server: cloudflare \| `Attention Required!` \| AkamaiGHost) → needs_client('blocked:…'). 타임아웃·DNS → failed | http 이미지(daum cfile, kakao staticmap)는 서버가 받아 https Storage 로. chosun resizer `auth=` 서명 → 즉시 복사 |
| musinsa.com·29cm.co.kr·gmarket·auction·ppomppu·clien·imdb·stackoverflow | fetch 안 함(무신사·29cm) 또는 generic 이 403 시그니처로 needs_client('blocked:cloudflare'). 임시 제목 = 슬러그/상품 id | 폰 fetch 1회 → 'needs:webview' | UA 스푸핑·우회 금지 |
| vimeo·open.spotify·soundcloud·flickr | 고정 oEmbed 엔드포인트(`vimeo.com/api/oembed.json`, `open.spotify.com/oembed`, `soundcloud.com/oembed?format=json`, `www.flickr.com/services/oembed/?format=json`) → title/author_name/description/thumbnail_url | generic | content-type JSON 확인 |
| Microlink | **v1 미구현**. `MICROLINK_API_KEY` 가 있을 때만 sweep 에서 켜지는 어댑터 자리만 | — | 키 없이 5회/일, 키 25회/일, 이미지 URL 도 원본이라 가치 낮음 |

## 7. 정규화·파서·이미지 규칙 요약

- `posts.url` 은 사용자 원문 그대로. fetchUrl/canonical 은 추적 파라미터(utm_*, igsh, igshid, si, fbclid, gclid, ref_src, feature, pp, x.com s/t, 쿠팡 lptag/wPcid/mcid/traceid/itime/sharesource, 네이버 fromRss/trackingCode/placePath) 제거 + 소문자 호스트 + 프래그먼트 제거 + 사이트별 재작성. 클라이언트 `normalizeForCompare(url)` 는 중복 저장 검사 전용.
- 이미지: 후보 순회 → SSRF → GET 8 s·3 MiB 스트림 → 2xx + `image/*` + 매직바이트(JPEG FFD8FF, PNG 89504E47, GIF 474946, WEBP RIFF…WEBP, AVIF ftyp) 일치 → 확장자는 매직바이트 기준 → `posts/<post_id>/<sha256 앞 16자>.<ext>` `upload(…, {contentType, cacheControl:'31536000', upsert:true})` → `getPublicUrl`. 실패는 상태 실패가 아니다: 텍스트만 ready, `preview_image_src` 에 원본 보관, error 'image:<reason>'.
- 폰 보조 파서(`parseOnDevice`, Hermes): UA 미설정, Microlink 없음, redirect follow, response.ok 게이트(아니면 `{blocked:true, http_status}`), content-type text/html 확인, content-length > 2 MB 면 `text()` 전에 중단(네 fetcher 모두; Android OkHttp 는 gzip 을 풀며 헤더를 떼므로 문자열화 뒤 길이로 한 번 더), 스캔 1 MiB, 태그 속성 16 KB(ATTR_RE 는 서버와 같은 선형 패턴), 인스타 캡션 64 KB + CaptionComments 없으면 첫 `</div>`, URL 힌트 2048자, 자르기는 코드포인트 단위(이모지 서로게이트 안 깨짐), 자기 예산 초과는 `timedOut:true`(assist 호출자가 "빈 결과" 와 구분해 제출하지 않음). 서버와 같은 메타 규칙, charset 이 euc-kr/ms949/ksc5601 이면 텍스트 필드 null(레거시 TextDecoder 없음 → 깨진 글자 저장 방지; 이미지·canonical 만). 인스타는 `/p/<code>/embed/captioned/` 를 같은 규칙으로 파싱(폰 IP 가 핵심 가치; description 에 캡션을 보내지만 서버 `applyCaptionPolicy` 가 §10-2 정책대로 버린다), YouTube 는 oEmbed, TikTok 은 영상 URL(`/video/<id>`·vm/vt·`/t/`) 만 SSR JSON 이고 그 외 *.tiktok.com 은 generic og, 쿠팡·medium·notion·map/cafe.naver·place 는 즉시 빈 결과.

## 8. 트리거 흐름 (Android 공유 시트 포함)

1. **저장**: `useCreatePost` / `useCreateFolderWithPost` 가 `insert({url, description, folder_id, …(titleHint 가 있을 때만 preview_title)}).select('id').single()` — `preview_title` 키는 힌트가 있을 때만 싣는다(null 이라도 키가 실리면 005 미적용 DB 에서 PostgREST PGRST204 로 저장 자체가 실패한다). `titleHint` = 공유 텍스트(ShareApp `sharedText`, useShareIntent `text`)에서 URL 을 뺀 나머지(공백 정리, ≤200자, 2자 미만이면 null). RETURNING 은 BEFORE 트리거가 group_id 를 채운 뒤 SELECT 정책을 통과해야 한다(003 과 반대 조건) — **라이브 1회 검증 필수**, 실패 시 `.select` 제거 + 트리거/catch-up 만으로 동작. 성공 뒤 POST_LIST 와 GROUP_ACTIVITY invalidate, 가속 fetch 가 끝나면 둘을 한 번 더(활동 피드의 '도메인' 제목이 채워진 제목으로 바뀌게).
2. **DB 트리거**(Vault 비밀 있을 때): pg_net → `mode:'webhook'` → 202 → `waitUntil(processPost)`. 공유 시트가 280 ms 뒤 Activity 를 닫아도, 프로세스가 죽어도 서버가 끝낸다.
3. **앱 가속**: id 를 얻은 즉시 `void requestPreviewFetch(id, deviceHints)` (await 안 함). `fetchWithAuth` 는 `getSession()` 뒤 바로 디스패치되므로 보통 닫힘 전에 떠나지만 토큰 만료 직전엔 갱신으로 늦을 수 있다 — 그래서 '가속' 이다. deviceHints = SaveLinkSheet 가 저장 전에 이미 얻은 `parseMetadata(url)` 결과(없으면 null). 웹훅과 겹쳐도 claim 이 하나만 통과 — 트리거가 켜져 있으면 보통 webhook 이 이기므로, 서버가 ≤10 s 그 행을 기다렸다가 needs_client/failed 로 끝나면 힌트를 assist 로 적용한다(§5). 호출자는 owner/editor 여야 한다(저장한 사람이니 당연히 그렇다; viewer 는 저장 자체가 RLS 로 막힌다).
4. **폴더 catch-up**(`usePreviewCatchUp`, 유일한 백필·재시도 메커니즘): FolderDetail 진입/목록 갱신 시 `pending` + `failed`(일시 코드 `TRANSIENT_PREVIEW_ERRORS` = timeout/http_5xx/dns_failed/network/fetch_failed/unexpected, attempts<3) + stale `fetching`(2분 초과) 행을 최신순 최대 24건, 8개씩 순차 `fetch`, 청크마다 invalidate(POST_LIST + GROUP_ACTIVITY). **폴더당 배치 하나**(`fetchInFlight`) — 청크 invalidate 로 rows 가 바뀌어 효과가 다시 돌아도 새 배치를 띄우지 않고, 배치가 끝난 invalidate 가 다음 24건을 잇는다(100행 폴더에서 Edge 호출이 겹겹이 뜨지 않게). `canEdit` 이면 `needs_client`(단, error 가 `needs:webview`/provider ∈ {coupang, naver_map} 은 건너뜀) 행을 동시성 2·8건·폴더당 묶음 하나로 `parseOnDevice` → `assist`(빈 결과도 보내 서버가 failed 로 종결 → 무한 루프 방지; 단 폰 타임아웃(`timedOut`)·화면 이탈로 끊긴 빈 결과는 보내지 않고 다음 기회로). 세션 Set 은 **서버에 닿은 요청만** 기억한다 — 전송 실패(오프라인·401·미배포)한 id 는 Set 에서 빼서 다음 평가에 다시 보내고, 수동 재시도는 `forgetPreviewRetryState(postId)` 로 그 id 를 다시 대상으로 만든다. + 서버 attempts 상한. 기존 ~100행은 사용자가 폴더를 여는 순서대로 채워지고, 원하면 curl 로 `sweep` 가속.
5. **폴링**: `usePostsQuery.refetchInterval = (q) => rows.some(isPreviewLoading) ? 3000 : false`, `isPreviewLoading` = pending && created_at 10분 이내 || fetching && claimed_at 2분 이내(막힌 행이 영구 폴링을 만들지 않음). 함수형은 @tanstack/query-core 5.90 에서 확인됨. FolderDetail 의 카드 콜백은 `postListRef` 로 목록을 읽어 deps 가 비어 있다 — 폴링마다 전 카드가 리렌더되지 않게(`React.memo` 유지).
6. **수동 재시도**: 롱프레스 → 「메모 수정」 시트 하단 '미리보기 다시 불러오기'(canEdit, status failed 만; unsupported 는 숨김) → `useRefreshPreview` → `onMutate`: `forgetPreviewRetryState` + 낙관적으로 fetching/claimed_at 세팅해 폴링 시작 → 폰 파싱(≤4 s) → **요청 직전에 낙관 행을 다시 세움**(그 사이 폴링이 DB 의 failed 로 되돌렸을 수 있다) → `fetch force`. 서버는 처리했으면 결과가 failed 여도 `success:true` 를 주므로 토스트는 `results[0]` 으로 가른다: `ready` → '미리보기를 다시 불러왔어요'; `skipped:'in_progress'`/fetching → '이미 불러오는 중이에요'(낙관 행 유지, 폴링이 채움); failed/unsupported/needs_client/not_found → '미리보기를 불러오지 못했어요'; 429 cooldown → '잠시 후 다시 시도해주세요'; 403 forbidden → '미리보기를 다시 불러올 권한이 없어요'. onError 는 그 행만(아직 낙관 상태일 때만) 되돌리고, `onSettled` 가 POST_LIST + GROUP_ACTIVITY 를 invalidate 해 전송 실패 뒤의 어긋남도 DB 상태로 맞춘다.
7. **카드**: DB 컬럼만 렌더. 로딩 창 밖의 pending/needs_client/failed/unsupported 는 **도메인 카드**(이니셜 타일 + `preview_site_name || domainInfo 라벨` + `preview_title || domain`). 큰 카드 부제 = `preview_description || preview_author`. 에러 화면·에러 토스트는 존재하지 않는다.

## 9. 보안

- 공개 URL(`--no-verify-jwt`) → 모든 mode 가 함수 내부 인증. 사용자 모드는 userClient RLS 가시성, assist 는 owner/editor + 대상 상태 `needs_client|failed` 만(ready 덮어쓰기 금지) + claim 경유(sweep 와 경합 방지) + `preview_assisted_by` 감사. **fetch 의 `device`/`force` 도 같은 owner/editor 게이트**(viewer 가 폰 힌트로 공유 미리보기를 덮어쓰거나 force 로 멀쩡한 ready 를 재수집시키지 못하게; 힌트 없는 fetch 는 viewer 허용). 폰 canonical 은 posts.url 과 같은 사이트일 때만 저장(findDonor 가 그룹에 퍼뜨리는 값). 인스타 캡션 저장 정책은 서버가 강제(폰 힌트의 description 도 플래그 없으면 버림). 웹훅 비밀은 상수시간 비교, Vault 와 Edge Secret 두 곳에만.
- 쓰기 무결성: 컬럼 단위 GRANT(클라이언트는 insert 에 preview_title 힌트만, update 는 description/folder_id), https CHECK, 길이 CHECK, 상태 CHECK. 서버는 service_role, 상태 전이는 claim RPC 로 원자적.
- SSRF(`ssrf.ts`): http/https·포트 80/443·userinfo 거부, 호스트 블록(localhost, *.local, *.internal, metadata.google.internal, 자기 SUPABASE_URL·*.supabase.co), `Deno.resolveDns` A/AAAA → 실패/미지원 시 DoH `https://cloudflare-dns.com/dns-query`(application/dns-json) 폴백 → 둘 다 실패 또는 결과 0 → **거부(fail-closed)**. 차단 범위 0/8·10/8·100.64/10·127/8·169.254/16·172.16/12·192.0.0/24·192.168/16·198.18/15·224/4·240/4, ::1·::/96·::ffff:0:0/96(내장 v4 재검사)·64:ff9b::/96(NAT64)·fc00::/7·fe80::/10. 홉마다 재검사(naver.me 는 호스트가 3번 바뀜), ≤8홉, provider 별 리다이렉트 호스트 허용목록. DNS 리바인딩은 Deno fetch 가 IP 고정을 못 해 잔여 위험 — 본문은 호출자에게 중계되지 않고 제목/설명 필드만 길이 캡 후 저장되므로 blind probe 로 축소. DoH 는 저장 URL 의 호스트명을 Cloudflare 에 보낸다(프라이버시 노트).
- 리소스: HTML 1 MiB·이미지 3 MiB 스트림 캡, 10/8/25 s, 배치 8·동시 2, Edge 256 MB·CPU 2 s·150 s 안. 비 2xx·차단 페이지 본문은 절대 파싱·저장 안 함.
- Storage: 공개 버킷(URL 을 아는 누구나 썸네일 조회 — 공유 그룹 프라이버시 주의로 수용), 경로는 서버 생성(사용자 입력 없음), 쓰기 정책 없음(authenticated 업로드 불가), SVG 거부.
- 프라이버시: 쿠키·Referer 없음, 추적 토큰은 fetch URL 에서 제거, 로그는 post_id·host·status·error 코드만. Microlink(제3자) 는 키 설정 시에만.
- Meta 약관: oEmbed 는 쓰지 않는다(메타 영속 금지 조항 직접 적용 회피). 공개 임베드 페이지 파싱 결과의 저장 범위는 decisionsForUser.

## 10. 실패 모드 (요약)

| 상황 | 처리 |
|---|---|
| 공유 시트 저장 직후 프로세스 kill | 트리거 활성이면 서버가 수집. 아니면 pending → 다음 폴더 진입 catch-up. 그동안 도메인 카드 |
| 함수 미배포·404·5xx | invoke reject 는 `.catch(noop)`, 카드는 도메인 카드, 폴링은 10분 창 후 멈춤 |
| 005 적용 + 구앱 | 컬럼 nullable·구앱 insert/update/select 영향 없음(컬럼 GRANT 는 구앱이 쓰는 범위와 일치 — 라이브 검증 4-3) |
| 005 미적용 + 새 앱 (**지원하지 않는 조합 — 새 앱은 005 를 요구한다**) | 힌트 없는 저장(FAB·URL 만 공유)은 `preview_title` 키를 싣지 않아 성공, status undefined → 도메인 카드, invoke 404 무시. **힌트 있는 저장**(공유 텍스트에 제목·쿠팡 상품명)은 PGRST204 로 실패('링크 추가에 실패했어요'), **활동 피드**는 명시 select 의 `preview_*` 로 42703 → 빈 피드. 그래서 롤아웃은 005 먼저, **되돌릴 때는 앱을 먼저 되돌린 뒤 005 되돌리기** |
| `insert().select('id')` 42501 | 출시 전 라이브 검증. 실패 시 `.select` 제거(트리거·catch-up 만으로 동작) |
| 서버 IP 차단(403/429/999/WAF 200/JS 챌린지) | 시그니처 판정 → needs_client + 코드, 본문 미저장 → 폰 1회 → 'needs:webview' → 도메인/브랜드 카드 |
| 삭제·비공개(IG BrokenMedia/302, X 404, YT 400) | unsupported(영구). 재시도 버튼 숨김 |
| 일시 실패(timeout·5xx·dns·연결 리셋/TLS = `network`·그 외 fetch 예외 = `fetch_failed`) | failed + 코드 → catch-up 이 attempts<3 재시도(`TRANSIENT_PREVIEW_ERRORS` 가 서버 코드와 1:1) |
| 웹훅·앱·catch-up 동시 도착 / 워커 사망 | claim 원자 선점 / claimed_at 2분 stale 재선점은 attempts<5 까지(매번 죽는 행을 영원히 재선점하지 않음), 그 뒤는 force 만. 저장 직후 폰 힌트가 webhook 선점에 밀리면 서버가 ≤10 s 기다려 assist 로 적용 |
| og:image 404·SVG·과대·서명 만료·http | 다음 후보 → 텍스트만 ready. http 는 서버가 받아 https 로. 수집과 같은 호출에서 즉시 복사 |
| EUC-KR / 응답마다 charset 다름 | BOM→헤더→meta→utf-8 fatal→euc-kr(BOM 이 헤더를 이김 — euc-kr 헤더 + UTF-8(BOM) 파일인 레거시 서버), 치환문자 >5% 면 텍스트 버리고 ASCII 필드만 + needs_client |
| 거대 head(YouTube 777 KB) | oEmbed 로 우회. generic 은 1 MiB + 조기중단 |
| Vault 미설치·권한 부족 | 트리거 전체 exception 흡수 → insert 성공, 수집은 앱 경로 |
| Storage 고아 | tombstone 트리거 + 매 fetch/sweep/assist 호출 끝 10건 GC(행 삭제 RETURNING 으로 선점 → `posts.preview_image_path` 가 아직 가리키는 경로는 남김 → remove; 재업로드된 라이브 객체를 지우지 않음) + delete-account 명시 정리. remove 실패는 고아로 남고 로그만 |
| 폰 힌트 조작(악의적 editor / viewer) | 길이·제어문자·스킴 검증, image_url 재다운로드+매직바이트, **viewer 는 assist 와 fetch(device/force) 모두 403**, 폰 canonical·제출 HTML og:url 은 posts.url 과 같은 사이트일 때만(다른 글의 canonical 을 사칭해 findDonor 로 그룹에 퍼뜨리는 것 차단), 인스타 description 은 서버 플래그 없으면 버림, 서버 결과 우선 |

## 11. 롤아웃 순서 (구버전 앱 무중단)

1. 005 SQL 실행(컬럼 추가·GRANT·트리거는 비밀 없으면 inert) → 구앱 정상.
2. `link-preview` 배포 → 아직 호출하는 앱 없음, 무해.
3. (권장) Vault 비밀 + Edge Secret → 이 순간부터 모든 insert 가 서버 수집(구앱 저장도 포함 → 백필 가속).
4. `bun run update-types` → 앱 코드 머지 → 개발 빌드로 라이브 검증(RETURNING RLS, 데이터센터 IP 샘플 10개) → 앱 배포(Alpha 중 Play 업로드 금지). **새 앱은 005 를 요구한다**(§10 표) — 1 보다 먼저 깔면 공유 텍스트 힌트가 있는 저장과 활동 피드가 깨진다.
5. delete-account 재배포.
6. 되돌리기 순서는 반대: **앱을 먼저 구버전으로** → 함수는 두어도 무해 → 005 되돌리기(pg_cron 을 켰다면 `cron.unschedule` 이 맨 앞, 005 하단 주석).

## 12. 알려진 한계

- 쿠팡 상품·스마트스토어·네이버 플레이스·일반 SPA 는 v1 에서 공유 텍스트 힌트가 없으면 브랜드 카드. v2 WebView 러너(`registerWebViewRunner`, `client_task.runner:'webview'`, error 접두 `needs:webview`) 자리만 둠.
- 네이버 카페 글 제목·X 미디어 외 영상 og·FB 비디오·kko.* 단축·m.entertain/sports·개인 네이버 블로그·IG 사진/캐러셀은 미검증. 네트워크 없이 고친 것들도 라이브 미검증: Reddit `/r/<sub>/s/<id>` 리다이렉터가 데이터센터 IP 에도 permalink 를 주는지, lnkd.in 리다이렉트, 카페 `/f-e/` 글 페이지가 SPA 셸인지.
- 모든 프로브는 주거용 IP·curl 기본 UA. Edge egress 결과는 배포 후 샘플 검증으로만 확인된다(`serverFetch` 플래그로 1줄 전환).
- 저장 직후 폰 힌트의 경합 보정(§5)은 fetch 바디 8 KB 안의 텍스트·이미지 힌트만 적용한다 — 인스타 임베드 원문처럼 서버 재파싱이 필요한 것은 폴더 catch-up 의 assist 가 맡는다. 10 s 안에 다른 워커가 끝나지 않으면 힌트는 버려지고 catch-up 이 다시 폰 파싱한다.
- tombstone GC 에는 DB 왕복 1회 크기의 잔여 경합 창이 남아 있다(선점 직후 같은 경로가 재업로드·UPDATE 되는 경우). 원자 RPC 로 닫을 수 있다 — HANDOFF §13.
- `index.ts` 의 fetch 판단 로직(게이트·쿨다운·경합 보정)은 URL import 때문에 bun 으로 import 되지 않아 자동 테스트가 없다 — 순수 모듈로 분리하는 것이 후속 과제.
- 공유 그룹에서 다른 멤버가 저장한 글의 갱신은 폴더 재진입 시 반영(Realtime 미사용).
- Instagram 임베드·TikTok SSR 은 비공식 마크업 — 변경 시 needs_client 가 늘어나며 모니터링 SQL 로 감지.
