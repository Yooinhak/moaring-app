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
