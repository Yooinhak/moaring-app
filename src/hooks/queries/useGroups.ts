import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { StackAvatar } from '../../components/AvatarStack';
import { useToast } from '../../components/Toast';
import { queryKeys } from '../../utils/react-query/queryKeys';
import { supabase } from '../../utils/supabase/client';

/** 그룹 역할 (001_groups_sharing.sql check 제약과 동일) */
export type GroupRole = 'owner' | 'editor' | 'viewer';

export interface GroupSummary {
  id: string;
  name: string;
  /** 무드 키 저장소 (레거시 폴더색·null 은 resolveMoodKey 가 sunset 으로 폴백) */
  color: string | null;
  type: 'personal' | 'shared';
  createdAt: string;
  /** 내 역할 */
  role: GroupRole;
  memberCount: number;
}

export interface GroupMember {
  userId: string;
  role: GroupRole;
  joinedAt: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface InvitePreview {
  valid: boolean;
  group_name?: string;
  /** 그룹 무드 키 (preview_invite 가 아직 안 내려주면 undefined → sunset 폴백) */
  group_color?: string | null;
  role?: GroupRole;
  member_count?: number;
}

// ----------------------------------------------------------------------------
// 조회
// ----------------------------------------------------------------------------

/** 내가 속한 그룹 목록 (개인 그룹 먼저, 이후 참여일 순) */
export function useMyGroupsQuery(enabled = true) {
  return useQuery({
    queryKey: [queryKeys.GROUP_LIST],
    enabled,
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return [];

      const { data, error } = await supabase
        .from('group_members')
        .select('role, joined_at, group:groups(id, name, color, type, created_at, members:group_members(count))')
        .eq('user_id', uid);
      if (error) throw error;

      const groups: GroupSummary[] = (data ?? [])
        .filter((row) => row.group != null)
        .map((row) => {
          const g = row.group!;
          const countRow = Array.isArray(g.members) ? g.members[0] : null;
          return {
            id: g.id,
            name: g.name,
            color: g.color,
            type: (g.type === 'personal' ? 'personal' : 'shared') as GroupSummary['type'],
            createdAt: g.created_at,
            role: row.role as GroupRole,
            memberCount: (countRow as { count?: number } | null)?.count ?? 1,
          };
        });

      return groups.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'personal' ? -1 : 1;
        return a.createdAt.localeCompare(b.createdAt);
      });
    },
  });
}

/**
 * 그룹 멤버 목록 + 프로필.
 * group_members ↔ profiles 는 직접 FK가 없어 PostgREST 중첩 조회가 불가 →
 * 2단계 조회 후 클라이언트에서 병합한다.
 */
export function useGroupMembersQuery(groupId: string | null) {
  return useQuery({
    queryKey: [queryKeys.GROUP_MEMBERS, groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<GroupMember[]> => {
      const { data: members, error } = await supabase
        .from('group_members')
        .select('user_id, role, joined_at')
        .eq('group_id', groupId!)
        .order('joined_at', { ascending: true });
      if (error) throw error;
      if (!members || members.length === 0) return [];

      const ids = members.map((m) => m.user_id);
      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url')
        .in('id', ids);
      if (pErr) throw pErr;

      const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
      // owner 먼저 정렬
      const roleOrder: Record<string, number> = { owner: 0, editor: 1, viewer: 2 };
      return members
        .map((m) => ({
          userId: m.user_id,
          role: m.role as GroupRole,
          joinedAt: m.joined_at,
          displayName: profileMap.get(m.user_id)?.display_name ?? null,
          avatarUrl: profileMap.get(m.user_id)?.avatar_url ?? null,
        }))
        .sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) || a.joinedAt.localeCompare(b.joinedAt));
    },
  });
}

export interface GroupMembersPreview {
  count: number;
  /** 합류순 최대 3명 (레일은 2+N 로 자름) */
  members: StackAvatar[];
}

/** 레일 칩 마이크로 아바타용 — 내 공유 그룹 전체의 멤버 프리뷰를 한 번에. */
export function useGroupMembersPreviewQuery(groupIds: string[]) {
  const key = [...groupIds].sort().join(',');
  return useQuery({
    queryKey: [queryKeys.GROUP_MEMBERS_PREVIEW, key],
    enabled: groupIds.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, GroupMembersPreview>> => {
      const { data: rows, error } = await supabase
        .from('group_members')
        .select('group_id, user_id, joined_at')
        .in('group_id', groupIds)
        .order('joined_at', { ascending: true });
      if (error) throw error;

      const ids = [...new Set((rows ?? []).map((r) => r.user_id))];
      const profileMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();
      if (ids.length > 0) {
        const { data: profiles, error: pErr } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url')
          .in('id', ids);
        if (pErr) throw pErr;
        for (const p of profiles ?? []) profileMap.set(p.id, p);
      }

      const out: Record<string, GroupMembersPreview> = {};
      for (const r of rows ?? []) {
        const entry = (out[r.group_id] ??= { count: 0, members: [] });
        entry.count += 1;
        if (entry.members.length < 3) {
          entry.members.push({
            userId: r.user_id,
            displayName: profileMap.get(r.user_id)?.display_name ?? null,
            avatarUrl: profileMap.get(r.user_id)?.avatar_url ?? null,
          });
        }
      }
      return out;
    },
  });
}

/** 현재 유효한 초대 (있으면 재사용, 없으면 null) */
export function useActiveInviteQuery(groupId: string | null) {
  return useQuery({
    queryKey: [queryKeys.GROUP_INVITE, groupId],
    enabled: !!groupId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('group_invites')
        .select('id, token, role, expires_at, max_uses, used_count')
        .eq('group_id', groupId!)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** 초대 미리보기 (수락 시트용, 비로그인도 호출 가능) */
export function useInvitePreviewQuery(token: string | null) {
  return useQuery({
    queryKey: [queryKeys.INVITE_PREVIEW, token],
    enabled: !!token,
    queryFn: async (): Promise<InvitePreview> => {
      const { data, error } = await supabase.rpc('preview_invite', { p_token: token! });
      if (error) throw error;
      return data as unknown as InvitePreview;
    },
  });
}

// ----------------------------------------------------------------------------
// 뮤테이션
// ----------------------------------------------------------------------------

export function useCreateGroup() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: { name: string; color: string }) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error('AUTH_REQUIRED');

      const { data, error } = await supabase
        .from('groups')
        .insert({ ...params, type: 'shared', created_by: uid })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_LIST] });
    },
    onError: () => {
      showToast('error', '그룹 생성에 실패했어요');
    },
  });
}

export function useUpdateGroup() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: { id: string; name?: string; color?: string }) => {
      const { id, ...rest } = params;
      const { error } = await supabase.from('groups').update(rest).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_LIST] });
      showToast('success', '그룹이 수정되었어요');
    },
    onError: () => showToast('error', '그룹 수정에 실패했어요'),
  });
}

/** 그룹 삭제 (owner 전용 — RLS가 이중 방어) */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (groupId: string) => {
      const { error } = await supabase.from('groups').delete().eq('id', groupId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_LIST] });
      showToast('success', '그룹이 삭제되었어요');
    },
    onError: () => showToast('error', '그룹 삭제에 실패했어요'),
  });
}

/** 그룹 나가기 (owner는 RLS에서 차단됨 — UI에서도 비노출) */
export function useLeaveGroup() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (groupId: string) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error('AUTH_REQUIRED');
      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', uid);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_LIST] });
      showToast('success', '그룹에서 나갔어요');
    },
    onError: () => showToast('error', '그룹 나가기에 실패했어요'),
  });
}

export function useChangeMemberRole(groupId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: { userId: string; role: Exclude<GroupRole, 'owner'> }) => {
      const { error } = await supabase
        .from('group_members')
        .update({ role: params.role })
        .eq('group_id', groupId)
        .eq('user_id', params.userId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_MEMBERS, groupId] });
      showToast('success', '역할이 변경되었어요');
    },
    onError: () => showToast('error', '역할 변경에 실패했어요'),
  });
}

export function useKickMember(groupId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', userId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_MEMBERS, groupId] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_MEMBERS_PREVIEW] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_LIST] });
      showToast('success', '멤버를 내보냈어요');
    },
    onError: () => showToast('error', '멤버 내보내기에 실패했어요'),
  });
}

/**
 * 초대 생성. `revokeExisting`이면 기존 유효 초대를 먼저 무효화(링크 재설정).
 */
export function useCreateInvite(groupId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: { role: Exclude<GroupRole, 'owner'>; revokeExisting?: boolean }) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error('AUTH_REQUIRED');

      if (params.revokeExisting) {
        await supabase
          .from('group_invites')
          .update({ revoked_at: new Date().toISOString() })
          .eq('group_id', groupId)
          .is('revoked_at', null);
      }

      const { data, error } = await supabase
        .from('group_invites')
        .insert({ group_id: groupId, role: params.role, created_by: uid })
        .select('id, token, role, expires_at, max_uses, used_count')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_INVITE, groupId] });
    },
    onError: () => showToast('error', '초대 링크 생성에 실패했어요'),
  });
}

/** 초대 수락 (딥링크 토큰) */
export function useJoinGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (token: string) => {
      const { data, error } = await supabase.rpc('join_group_with_token', { p_token: token });
      if (error) throw error;
      return data as unknown as { group_id: string; already_member: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_LIST] });
      queryClient.invalidateQueries({ queryKey: [queryKeys.GROUP_MEMBERS_PREVIEW] });
    },
  });
}
