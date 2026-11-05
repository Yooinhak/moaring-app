import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../utils/react-query/queryKeys';
import { supabase } from '../../utils/supabase/client';

/**
 * 그룹별 최근 활동 — 리텐션 훅(안읽음 배지)용.
 *
 * 링크가 담길 때마다 그룹에 '새 소식'이 생긴다. 새 테이블/푸시 없이, 이미 있는 posts
 * 데이터(created_at + 폴더의 group_id)를 재구성해 "그룹별 가장 최근 활동 시각"을 만든다.
 * GroupRail 이 이 값과 로컬 lastSeen 을 비교해 안읽음 점을 띄운다.
 *
 * RLS 가 내가 볼 수 있는 posts 로 이미 제한하므로 조건 없이 최근 N개만 훑으면 된다.
 */

export type GroupActivityMap = Record<string, string>; // groupId -> 최신 created_at(ISO)

type ActivityRow = {
  created_at: string | null;
  folder: { group_id: string } | null;
};

export function useGroupActivityQuery(enabled = true) {
  return useQuery({
    queryKey: [queryKeys.GROUP_ACTIVITY],
    enabled,
    // 활동은 자주 바뀌므로 짧게 신선 유지
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('posts')
        .select('created_at, folder:folders(group_id)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as ActivityRow[];
    },
    select: (rows): GroupActivityMap => {
      const latest: GroupActivityMap = {};
      for (const r of rows) {
        const gid = r.folder?.group_id;
        if (!gid || !r.created_at) continue;
        if (!latest[gid] || r.created_at > latest[gid]) latest[gid] = r.created_at;
      }
      return latest;
    },
  });
}

/**
 * 활동 피드 항목 — "○○님이 «폴더»에 링크 추가". 공유 그룹만.
 * ActivityScreen 에서 날짜별로 묶어 보여준다.
 */
export type ActivityFeedItem = {
  id: number;
  url: string;
  description: string | null;
  /** 서버(Edge Function link-preview)가 수집한 미리보기 — 피드 행은 기기에서 메타를 긁지 않고 이 값만 그린다 */
  previewTitle: string | null;
  /** Storage 공개 URL(https). 지금은 피드에 안 그리지만 카드와 같은 컬럼을 들고 있어 썸네일을 붙일 때 쿼리 수정이 없다 */
  previewImageUrl: string | null;
  /** PREVIEW_STATUSES 중 하나. 005 미적용·구행이면 null 로 본다 */
  previewStatus: string | null;
  createdAt: string | null;
  userId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  folderId: number;
  folderName: string;
  folderColor: string | null;
  folderEmoji: string | null;
  groupId: string;
  groupName: string;
  /** 그룹 무드 키 (resolveMoodKey 로 해석) */
  groupColor: string | null;
};

type FeedRow = {
  id: number;
  url: string;
  description: string | null;
  preview_title: string | null;
  preview_image_url: string | null;
  preview_status: string | null;
  created_at: string | null;
  user_id: string | null;
  folder: {
    id: number;
    name: string;
    color: string | null;
    emoji: string | null;
    group_id: string;
    group: { id: string; name: string; color: string | null; type: string } | null;
  } | null;
};

/**
 * 최근 활동 피드. RLS 로 내가 볼 수 있는 posts 만 조회 → 공유 그룹 항목만 남긴다.
 * 추가자 이름/아바타는 profiles 에서 별도 조회해 매핑(멤버 쿼리와 동일 패턴).
 */
export function useActivityFeedQuery(enabled = true) {
  return useQuery({
    queryKey: [queryKeys.GROUP_ACTIVITY, 'feed'],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<ActivityFeedItem[]> => {
      const { data, error } = await supabase
        .from('posts')
        // 명시 컬럼 목록이라 preview_* 는 직접 적어야 들어온다 (usePostsQuery 의 와일드카드와 다름)
        .select(
          'id, url, description, preview_title, preview_image_url, preview_status, created_at, user_id, folder:folders(id, name, color, emoji, group_id, group:groups(id, name, color, type))',
        )
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      const rows = (data ?? []) as unknown as FeedRow[];
      const shared = rows.filter((r) => r.folder?.group && r.folder.group.type !== 'personal');

      const ids = [...new Set(shared.map((r) => r.user_id).filter((v): v is string => !!v))];
      const profileMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();
      if (ids.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url')
          .in('id', ids);
        for (const p of profiles ?? []) profileMap.set(p.id, p);
      }

      return shared.map((r) => ({
        id: r.id,
        url: r.url,
        description: r.description,
        previewTitle: r.preview_title,
        previewImageUrl: r.preview_image_url,
        previewStatus: r.preview_status,
        createdAt: r.created_at,
        userId: r.user_id,
        displayName: r.user_id ? (profileMap.get(r.user_id)?.display_name ?? null) : null,
        avatarUrl: r.user_id ? (profileMap.get(r.user_id)?.avatar_url ?? null) : null,
        folderId: r.folder!.id,
        folderName: r.folder!.name,
        folderColor: r.folder!.color,
        folderEmoji: r.folder!.emoji,
        groupId: r.folder!.group!.id,
        groupName: r.folder!.group!.name,
        groupColor: r.folder!.group!.color,
      }));
    },
  });
}
