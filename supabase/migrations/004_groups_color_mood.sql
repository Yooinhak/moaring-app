-- ----------------------------------------------------------------------------
-- 004_groups_color_mood.sql  (2026-07-22)
--
-- 그룹 아이덴티티를 이모지 → 무드(공기)로 전환한다.
--   ① groups.color 를 무드 키 저장소로 재활용 (기존 CHECK 가 폴더 색 6종만 허용해
--      생성·수정이 23514 groups_color_check 로 실패했다)
--   ② preview_invite RPC 를 emoji → color 로 교체 (컬럼을 지우면 함수가 깨진다)
--   ③ groups.emoji 컬럼 제거 (앱에서 그룹 이모지 전면 폐기)
--
-- ⚠️ 실행 순서: **앱을 먼저 최신 코드로 리로드한 뒤** 이 SQL 을 실행한다.
--    구버전 앱은 groups.emoji 를 select 하므로 컬럼 삭제 후 그룹 목록 조회가 실패한다.
--
-- ⚠️ 되돌리기: emoji 컬럼 삭제는 값이 사라진다. 그룹 이모지는 앱에서 이미 표시하지
--    않으므로 복구 가치가 없다고 판단했다. 남기고 싶으면 실행 전에
--    `select id, name, emoji from public.groups;` 결과를 따로 보관할 것.
--
-- folders.color / folders.emoji 는 그대로다 — 폴더는 6색 팔레트 + 이모지를 계속 쓴다.
-- ----------------------------------------------------------------------------

begin;

-- ① color CHECK 를 무드 키로 교체 (레거시 6색도 허용해 기존 행 보존 →
--    클라이언트 resolveMoodKey 가 미지값·레거시를 sunset 으로 폴백)
alter table public.groups drop constraint if exists groups_color_check;

alter table public.groups
  add constraint groups_color_check
  check (color is null or color in (
    'sunset', 'mint', 'rose', 'citrus', 'dusk',         -- 무드 키 (신규)
    'blue', 'purple', 'pink', 'orange', 'green', 'gray' -- 레거시 보존
  ));

-- ② preview_invite: group_emoji → group_color (컬럼 삭제 전에 먼저 교체)
create or replace function public.preview_invite(p_token text)
returns json
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  inv record;
  result json;
begin
  select i.group_id, i.role, g.name, g.color into inv
  from public.group_invites i
  join public.groups g on g.id = i.group_id
  where i.token = p_token
    and i.revoked_at is null
    and i.expires_at > now()
    and i.used_count < i.max_uses;

  if not found then
    return json_build_object('valid', false);
  end if;

  select json_build_object(
    'valid', true,
    'group_name', inv.name,
    'group_color', inv.color,
    'role', inv.role,
    'member_count', (select count(*) from public.group_members where group_id = inv.group_id)
  ) into result;

  return result;
end;
$$;

revoke all on function public.preview_invite from public;
grant execute on function public.preview_invite to authenticated, anon;

-- ③ emoji 컬럼 제거 (앱·RPC 어디서도 더 이상 참조하지 않음)
alter table public.groups drop column if exists emoji;

commit;

-- ----------------------------------------------------------------------------
-- 적용 후: supabase gen types typescript --project-id <ref> > src/utils/supabase/types.ts
-- ----------------------------------------------------------------------------
