import React, { useEffect, useMemo, useState } from 'react';

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';

import { colors, getFolderColor, moods, resolveMoodKey, typo } from '../../constants/theme';
import { useGroup } from '../../contexts/GroupContext';
import { useAllFoldersQuery, useCreatePost } from '../../hooks/queries';
import { readClipboardUrl } from '../../utils/clipboard';
import { getDomainInfo } from '../../utils/domainInfo';
import { lightTap } from '../../utils/haptics';
import { parseMetadata } from '../../utils/parseMetadata';
import { queryKeys } from '../../utils/react-query/queryKeys';
import { isValidUrl } from '../../utils/validateUrl';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import FaviconBadge from '../FaviconBadge';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, HomeIcon, LockIcon, XIcon } from '../icons';
import Input from '../Input';
import MoodWash from '../MoodWash';
import Skeleton from '../Skeleton';
import { useToast } from '../Toast';

/**
 * 링크 저장 시트 — "확인 + 위치 선택" (2026-07-16 재설계).
 *
 * 원칙(Pocket/Raindrop 관습): URL 은 자동으로 채워지고, 사용자는 '어디에 저장'만 원탭.
 *  - 상단 고정: 링크 프리뷰(파비콘 + og:title[로딩=스켈레톤] + 도메인). URL 은 공유
 *    인텐트 > 클립보드에서 자동 채움, 없을 때만 입력창 폴백.
 *  - 본문: 최근 폴더(원탭) + 그룹 아코디언(접기/펼치기, 적응형 기본). 로딩 중엔 폴더
 *    스켈레톤(§3 progressive-loading — 거짓 빈 화면 방지).
 *  - 하단 고정: 「폴더명」에 저장 CTA(선택 결과 명시).
 */

const RECENT_FOLDER_KEY = 'moaring.recentFolderId';

interface SaveLinkSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 공유 인텐트로 받은 URL (없으면 자동 채움/직접 입력 모드) */
  initialUrl?: string | null;
  /** 폴더가 하나도 없을 때 「폴더 만들러 가기」 동작 (기본: 시트 닫기 → 홈에서 만들기) */
  onCreateFolder?: () => void;
}

type AnyFolder = {
  id: number;
  name: string;
  color: string | null;
  group: { id: string; name: string; color: string | null; type: string } | null;
};

function domainOf(url: string): string {
  const label = getDomainInfo(url)?.label;
  if (label) return label;
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

export default function SaveLinkSheet({ visible, onClose, initialUrl = null, onCreateFolder }: SaveLinkSheetProps) {
  const { showToast } = useToast();
  const { groups, currentGroupId } = useGroup();
  const createPost = useCreatePost();

  const { data: allFolders, isLoading } = useAllFoldersQuery(visible);
  const [url, setUrl] = useState('');
  const [editingUrl, setEditingUrl] = useState(false); // 프리뷰 대신 입력창 표시
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [recentFolderId, setRecentFolderId] = useState<number | null>(null);
  const [toggles, setToggles] = useState<Record<string, boolean>>({}); // 아코디언 사용자 토글

  // 시트 열릴 때: 상태 초기화 + URL 자동 채움(공유 인텐트 > 클립보드)
  useEffect(() => {
    if (!visible) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setSelectedId(null);
    setToggles({});
    setUrl(initialUrl ?? '');
    setEditingUrl(!initialUrl);
    /* eslint-enable react-hooks/set-state-in-effect */
    AsyncStorage.getItem(RECENT_FOLDER_KEY).then((v) => setRecentFolderId(v ? Number(v) : null));
    if (!initialUrl) {
      // 클립보드에 링크가 있으면 타이핑 없이 자동 채움
      readClipboardUrl()
        .then((clip) => {
          if (clip) {
            setUrl(clip);
            setEditingUrl(false);
          }
        })
        .catch(() => {});
    }
  }, [visible, initialUrl]);

  const trimmedUrl = url.trim();
  const roleByGroup = useMemo(() => new Map(groups.map((g) => [g.id, g.role])), [groups]);

  const sections = useMemo(() => {
    const list = (allFolders ?? []) as unknown as AnyFolder[];
    const byGroup = new Map<string, { name: string; color: string | null; type: string; folders: AnyFolder[] }>();
    for (const f of list) {
      if (!f.group) continue;
      const entry = byGroup.get(f.group.id) ?? {
        name: f.group.name,
        color: f.group.color,
        type: f.group.type,
        folders: [],
      };
      entry.folders.push(f);
      byGroup.set(f.group.id, entry);
    }
    return [...byGroup.entries()]
      .map(([id, v]) => ({ id, ...v, viewer: roleByGroup.get(id) === 'viewer' }))
      .sort((a, b) => (a.type === b.type ? 0 : a.type === 'personal' ? -1 : 1));
  }, [allFolders, roleByGroup]);

  const recentFolder = useMemo(() => {
    if (!recentFolderId || !allFolders) return null;
    const list = allFolders as unknown as AnyFolder[];
    const f = list.find((x) => x.id === recentFolderId);
    return f && roleByGroup.get(f.group?.id ?? '') !== 'viewer' ? f : null;
  }, [recentFolderId, allFolders, roleByGroup]);

  const hasFolders = sections.some((s) => s.folders.length > 0);
  const totalFolders = useMemo(() => sections.reduce((n, s) => n + s.folders.length, 0), [sections]);

  // 아코디언 기본 펼침(적응형): 적으면 전부, 많으면 현재 그룹 + 최근 폴더 그룹만
  const defaultExpanded = useMemo(() => {
    const set = new Set<string>();
    if (sections.length <= 1 || totalFolders <= 8) {
      sections.forEach((s) => set.add(s.id));
    } else {
      if (currentGroupId) set.add(currentGroupId);
      const rg = recentFolder?.group?.id;
      if (rg) set.add(rg);
      if (set.size === 0 && sections[0]) set.add(sections[0].id);
    }
    return set;
  }, [sections, totalFolders, currentGroupId, recentFolder]);

  const isExpanded = (groupId: string) => toggles[groupId] ?? defaultExpanded.has(groupId);
  const toggleGroup = (groupId: string) => {
    lightTap();
    setToggles((p) => ({ ...p, [groupId]: !isExpanded(groupId) }));
  };

  // 링크 메타데이터 프리뷰 (제목/파비콘). 유효한 URL 일 때만 조회.
  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: [queryKeys.METADATA, trimmedUrl],
    queryFn: () => parseMetadata(trimmedUrl),
    enabled: isValidUrl(trimmedUrl),
  });

  const selectedFolder = useMemo(() => {
    if (!selectedId || !allFolders) return null;
    return (allFolders as unknown as AnyFolder[]).find((f) => f.id === selectedId) ?? null;
  }, [selectedId, allFolders]);

  const canSave = !!selectedId && !!trimmedUrl && !createPost.isPending;

  const handleSave = () => {
    if (!selectedId) return;
    if (!isValidUrl(trimmedUrl)) {
      showToast('error', '올바른 URL 형식이 아니에요 (https://...)');
      return;
    }
    createPost.mutate(
      { url: trimmedUrl, description: null, folder_id: selectedId },
      {
        onSuccess: () => {
          AsyncStorage.setItem(RECENT_FOLDER_KEY, String(selectedId)).catch(() => {});
          showToast('success', '링크를 저장했어요');
          onClose();
        },
      },
    );
  };

  const selectFolder = (id: number, locked: boolean) => {
    if (locked) {
      showToast('error', '보기 전용 그룹이에요');
      return;
    }
    lightTap();
    setSelectedId(id);
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="어디에 저장할까요?"
      // ── 상단 고정: 링크 프리뷰(자동 채움) 또는 입력창 ──
      fixedTop={
        editingUrl ? (
          <View style={styles.urlField}>
            <Input
              placeholder="https:// 링크를 붙여넣어주세요"
              value={url}
              onChangeText={setUrl}
              onBlur={() => {
                if (isValidUrl(url.trim())) setEditingUrl(false);
              }}
              autoCapitalize="none"
              keyboardType="url"
              autoFocus
            />
          </View>
        ) : (
          <TouchableOpacity
            style={styles.previewCard}
            activeOpacity={0.75}
            onPress={() => setEditingUrl(true)}
            accessibilityRole="button"
            accessibilityLabel="저장할 링크 변경"
          >
            <FaviconBadge url={trimmedUrl} size={30} />
            <View style={styles.previewBody}>
              {metaLoading ? (
                <Skeleton width="72%" height={13} borderRadius={6} />
              ) : (
                <Text style={styles.previewTitle} numberOfLines={1}>
                  {meta?.title || domainOf(trimmedUrl)}
                </Text>
              )}
              <Text style={styles.previewDomain} numberOfLines={1}>
                {domainOf(trimmedUrl)}
              </Text>
            </View>
            <XIcon size={15} color={colors.textFaint} strokeWidth={2.2} />
          </TouchableOpacity>
        )
      }
      // ── 하단 고정: 선택 결과를 명시한 저장 CTA ──
      footer={
        hasFolders || isLoading ? (
          <Button onPress={handleSave} loading={createPost.isPending} disabled={!canSave}>
            {selectedFolder ? `「${selectedFolder.name}」에 저장` : '여기에 저장'}
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <FolderListSkeleton />
      ) : hasFolders ? (
        <>
          {recentFolder && (
            <View style={styles.recentWrap}>
              <Text style={styles.capsLabel}>최근 저장</Text>
              <FolderPickRow
                folder={recentFolder}
                subtitle={
                  recentFolder.group
                    ? recentFolder.group.type === 'personal'
                      ? '나의 서랍'
                      : recentFolder.group.name
                    : undefined
                }
                selected={selectedId === recentFolder.id}
                locked={false}
                recent
                onPress={() => selectFolder(recentFolder.id, false)}
              />
            </View>
          )}

          {sections.map((section) => {
            const expanded = isExpanded(section.id);
            const label = section.type === 'personal' ? '나의 서랍' : section.name;
            return (
              <View key={section.id}>
                <TouchableOpacity
                  style={styles.sectionRow}
                  onPress={() => toggleGroup(section.id)}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  accessibilityLabel={`${label} 그룹, 폴더 ${section.folders.length}개, ${expanded ? '접기' : '펼치기'}`}
                >
                  {expanded ? (
                    <ChevronDownIcon size={15} color={colors.textFaint} strokeWidth={2.4} />
                  ) : (
                    <ChevronRightIcon size={15} color={colors.textFaint} strokeWidth={2.4} />
                  )}
                  {section.type === 'personal' ? (
                    <HomeIcon size={13} color={colors.primaryDeep} strokeWidth={2.2} />
                  ) : (
                    // 그룹은 무드 세로 바로 식별 (이모지 폐지)
                    <View style={styles.sectionBarWrap}>
                      <MoodWash
                        colors={[
                          moods[resolveMoodKey(section.color)].illust.pastel,
                          moods[resolveMoodKey(section.color)].accent,
                        ]}
                      />
                    </View>
                  )}
                  <Text style={styles.sectionName}>{label}</Text>
                  {section.viewer && (
                    <View style={styles.viewerBadge}>
                      <Text style={styles.viewerBadgeText}>보기 전용</Text>
                    </View>
                  )}
                  <Text style={styles.sectionCount}>{section.folders.length}</Text>
                </TouchableOpacity>
                {expanded &&
                  section.folders.map((f) => (
                    <FolderPickRow
                      key={f.id}
                      folder={f}
                      selected={selectedId === f.id}
                      locked={section.viewer}
                      onPress={() => selectFolder(f.id, section.viewer)}
                    />
                  ))}
              </View>
            );
          })}
        </>
      ) : (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>{'아직 폴더가 없어요.\n폴더를 먼저 만들면 링크를 담을 수 있어요.'}</Text>
          <Button size="small" onPress={onCreateFolder ?? onClose}>
            폴더 만들러 가기
          </Button>
        </View>
      )}
    </BottomSheet>
  );
}

/** 폴더 목록 로딩 플레이스홀더 — 섹션 2개 + 폴더 행 시머(§3 progressive-loading). */
function FolderListSkeleton() {
  return (
    <View accessible accessibilityLabel="폴더 불러오는 중" style={styles.skelWrap}>
      {[0, 1].map((s) => (
        <View key={s}>
          <View style={styles.skelSection}>
            <Skeleton width={92} height={12} borderRadius={6} />
          </View>
          {[0, 1, 2].map((r) => (
            <View key={r} style={styles.skelRow}>
              <Skeleton width={36} height={36} borderRadius={11} />
              <Skeleton width="52%" height={13} borderRadius={6} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function FolderPickRow({
  folder,
  subtitle,
  selected,
  locked,
  recent = false,
  onPress,
}: {
  folder: AnyFolder;
  subtitle?: string;
  selected: boolean;
  locked: boolean;
  recent?: boolean;
  onPress: () => void;
}) {
  const fc = getFolderColor(folder.color);
  return (
    <TouchableOpacity
      style={[styles.row, recent && styles.rowRecent, selected && styles.rowSelected, locked && { opacity: 0.45 }]}
      onPress={onPress}
      activeOpacity={locked ? 1 : 0.65}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: locked }}
      accessibilityLabel={locked ? `${folder.name} — 보기 전용` : `${folder.name}에 저장`}
    >
      <View style={[styles.rowTile, { backgroundColor: fc.bg }]}>
        <FolderIcon size={17} color={fc.icon} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {folder.name}
        </Text>
        {subtitle && (
          <Text style={styles.rowSub} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {locked ? (
        <LockIcon size={15} color={colors.textFaint} />
      ) : (
        selected && <CheckIcon size={18} color={colors.primary} strokeWidth={2.6} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  urlField: {
    marginTop: 4,
  },
  // 링크 프리뷰 카드
  previewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    marginTop: 4,
    backgroundColor: colors.fieldBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  previewBody: { flex: 1, minWidth: 0, gap: 2 },
  previewTitle: { fontSize: 14, fontFamily: 'LINESeedKR-Bold', color: colors.ink },
  previewDomain: { fontSize: 11.5, fontFamily: 'LINESeedKR', color: colors.textFaint },
  recentWrap: { marginBottom: 4 },
  capsLabel: {
    ...typo.sectionLabel,
    color: colors.textDisabled,
    marginTop: 15,
    marginBottom: 6,
  },
  // 아코디언 그룹 헤더 (탭 타깃 확보)
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 8,
  },
  sectionBarWrap: { width: 3, height: 16, borderRadius: 2, overflow: 'hidden' },
  sectionName: { fontSize: 12, fontFamily: 'LINESeedKR-Bold', color: colors.textMuted },
  sectionCount: {
    marginLeft: 'auto',
    fontSize: 11,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.textDisabled,
  },
  viewerBadge: {
    backgroundColor: colors.divider,
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  viewerBadgeText: { fontSize: 10, fontFamily: 'LINESeedKR-Bold', color: colors.textFaint },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderRadius: 13,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  rowRecent: { backgroundColor: colors.fieldBg, borderRadius: 14 },
  rowSelected: {
    backgroundColor: colors.primaryTint,
    borderWidth: 1.5,
    borderColor: colors.primary,
    paddingVertical: 7.5,
    paddingHorizontal: 10.5,
  },
  rowTile: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowName: { fontSize: 14, fontFamily: 'LINESeedKR-Bold', color: colors.ink },
  rowSub: { fontSize: 11, fontFamily: 'LINESeedKR', color: colors.textDisabled },
  // 폴더 로딩 스켈레톤
  skelWrap: { marginTop: 6 },
  skelSection: { marginTop: 15, marginBottom: 8 },
  skelRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9, paddingHorizontal: 12 },
  emptyWrap: { alignItems: 'center', gap: 16, paddingVertical: 24 },
  emptyText: {
    fontSize: 14,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 21,
  },
});
