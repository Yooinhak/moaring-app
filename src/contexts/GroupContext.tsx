import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { GroupSummary, useMyGroupsQuery } from '../hooks/queries/useGroups';
import { useAuth } from '../hooks/useAuth';
import { appStorage } from '../utils/storage/appStorage';

/**
 * 현재 선택된 그룹 상태 (시안 ① GroupSwitcher 의 근간).
 *
 * - 그룹 목록은 React Query로 조회 (세션 있을 때만).
 * - 선택은 appStorage(iOS 는 공유 확장과 공유)에 영속 → 앱 재시작 시 마지막 그룹 유지.
 * - 선택된 그룹이 사라졌으면(나가기/삭제/강퇴) 개인 그룹으로 폴백.
 */

const STORAGE_KEY = 'moaring.currentGroupId';

interface GroupContextValue {
  groups: GroupSummary[];
  isLoading: boolean;
  currentGroup: GroupSummary | null;
  currentGroupId: string | null;
  /** 현재 그룹에서의 내 역할 (로딩 중엔 null) */
  myRole: GroupSummary['role'] | null;
  /** 현재 그룹이 개인 그룹인가 (공유 UI 미노출 기준) */
  isPersonal: boolean;
  selectGroup: (groupId: string) => void;
  refetchGroups: () => void;
}

const GroupContext = createContext<GroupContextValue | null>(null);

export function useGroup() {
  const ctx = useContext(GroupContext);
  if (!ctx) throw new Error('useGroup must be used within GroupProvider');
  return ctx;
}

export function GroupProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const { data: groups = [], isLoading, refetch } = useMyGroupsQuery(!!session);
  const [storedId, setStoredId] = useState<string | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);

  // 저장된 선택 복원
  useEffect(() => {
    appStorage
      .getItem(STORAGE_KEY)
      .then((v) => setStoredId(v))
      .finally(() => setStorageLoaded(true));
  }, []);

  const selectGroup = useCallback((groupId: string) => {
    setStoredId(groupId);
    appStorage.setItem(STORAGE_KEY, groupId).catch(() => {});
  }, []);

  // 유효성 검증: 저장된 그룹이 목록에 없으면 개인 그룹 폴백
  const currentGroup = useMemo(() => {
    if (groups.length === 0) return null;
    const found = storedId ? groups.find((g) => g.id === storedId) : null;
    return found ?? groups.find((g) => g.type === 'personal') ?? groups[0];
  }, [groups, storedId]);

  const value = useMemo<GroupContextValue>(
    () => ({
      groups,
      isLoading: isLoading || !storageLoaded,
      currentGroup,
      currentGroupId: currentGroup?.id ?? null,
      myRole: currentGroup?.role ?? null,
      isPersonal: currentGroup?.type !== 'shared',
      selectGroup,
      refetchGroups: refetch,
    }),
    [groups, isLoading, storageLoaded, currentGroup, selectGroup, refetch],
  );

  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
}
