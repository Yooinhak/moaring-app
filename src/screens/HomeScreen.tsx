import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Animated, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AlertDialog from '../components/AlertDialog';
import AvatarStack from '../components/AvatarStack';
import BottomSheet from '../components/BottomSheet';
import Button from '../components/Button';
import ContextMenu, { ContextMenuItem } from '../components/ContextMenu';
import { pushRecentEmoji } from '../components/EmojiPicker';
import EmptyState from '../components/EmptyState';
import FolderCardSkeleton from '../components/FolderCardSkeleton';
import FolderIdentityPicker from '../components/FolderIdentityPicker';
import FolderTilePreview from '../components/FolderTilePreview';
import GlassBackground from '../components/GlassBackground';
import GroupRail from '../components/GroupRail';
import { FolderIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, TrashIcon } from '../components/icons';
import Input from '../components/Input';
import CreateGroupSheet from '../components/sheets/CreateGroupSheet';
import InviteAcceptSheet from '../components/sheets/InviteAcceptSheet';
import InviteSheet from '../components/sheets/InviteSheet';
import SaveLinkSheet from '../components/sheets/SaveLinkSheet';
import { useToast } from '../components/Toast';
import { suggestIdentity } from '../constants/emojiData';
import { colors, FolderColorKey, getFolderColor, glass, shadows, typo } from '../constants/theme';
import { useGroup } from '../contexts/GroupContext';
import {
  useCreateFolder,
  useDeferredDeleteFolder,
  useFoldersQuery,
  useGroupMembersQuery,
  useUpdateFolder,
} from '../hooks/queries';
import { useActivityUnread } from '../hooks/useActivityUnread';
import { useCurrentMood } from '../hooks/useCurrentMood';
import { useInviteDeepLink } from '../hooks/useInviteDeepLink';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { useShareIntent } from '../hooks/useShareIntent';
import { MainStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<MainStackParamList, 'MainTabs'>;

// ── 폴더 그리드 (블루 글래스 시안 02/06: 2열 유리 카드) ──────────
type FolderItem = {
  id: number;
  name: string;
  color: string | null;
  emoji?: string | null;
  posts?: Array<{ count: number }>;
};

/** 그리드 데이터 = 폴더 + (편집 가능 시) '새 폴더' 타일 */
type GridItem = { kind: 'folder'; folder: FolderItem } | { kind: 'add' };

type FolderCardProps = {
  item: FolderItem;
  postCount: number;
  canEdit: boolean;
  warmTone: boolean;
  /** 2열 그리드 카드 폭 (픽셀 고정 — flex 계산은 numColumns 와 조합 시 폭이 깨지는 사례 있음) */
  width: number;
  onOpen: (id: number, name: string, color: string | null, emoji: string | null) => void;
  onEdit: (id: number, name: string, color: FolderColorKey, emoji: string | null) => void;
  onDelete: (id: number) => void;
};

const FolderCard = React.memo(function FolderCard({
  item,
  postCount,
  canEdit,
  warmTone,
  width,
  onOpen,
  onEdit,
  onDelete,
}: FolderCardProps) {
  const fc = getFolderColor(item.color);
  const menuItems: ContextMenuItem[] = [
    {
      label: '폴더 수정',
      icon: <PencilIcon size={16} color={colors.textMuted} />,
      onPress: () => onEdit(item.id, item.name, (item.color ?? 'blue') as FolderColorKey, item.emoji ?? null),
    },
    {
      label: '삭제',
      icon: <TrashIcon size={16} color={colors.danger} />,
      destructive: true,
      onPress: () => onDelete(item.id),
    },
  ];

  return (
    <TouchableOpacity
      style={[styles.folderCard, { width }, warmTone ? shadows.warmCard : shadows.glassCard]}
      onPress={() => onOpen(item.id, item.name, item.color, item.emoji ?? null)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${item.name} 폴더, ${postCount}개의 링크`}
    >
      <View style={[styles.folderTile, { backgroundColor: fc.bg }]}>
        {item.emoji ? (
          <Text style={styles.folderEmoji}>{item.emoji}</Text>
        ) : (
          <FolderIcon size={17} color={fc.icon} />
        )}
      </View>
      <Text style={styles.folderName} numberOfLines={1}>
        {item.name}
      </Text>
      <Text style={styles.folderCount}>{postCount} LINKS</Text>

      {canEdit && (
        <View style={styles.folderMenu}>
          <ContextMenu
            items={menuItems}
            trigger={
              <View style={styles.folderMenuBtn}>
                <MoreHorizontalIcon size={18} color={colors.textMuted} />
              </View>
            }
          />
        </View>
      )}
    </TouchableOpacity>
  );
});

// 그리드 레이아웃 상수 — list paddingHorizontal 22 / 열 간격 11 과 동기화
const GRID_H_PADDING = 22;
const GRID_GAP = 11;

export default function HomeScreen() {
  const mood = useCurrentMood();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { showToast } = useToast();

  // 2열 카드 폭을 픽셀로 고정 (flex:1 + maxWidth% 는 특정 조합에서 폭이 붕괴 — 2026-07-11 실기기)
  const { width: windowWidth } = useWindowDimensions();
  const cardWidth = Math.floor((windowWidth - GRID_H_PADDING * 2 - GRID_GAP) / 2);

  // ── 그룹 상태 ──────────────────────────────────────────────
  const { currentGroup, currentGroupId, myRole, isPersonal } = useGroup();
  const canEdit = myRole !== 'viewer';

  // 리텐션: 폴더 열람 시 해당 그룹을 '읽음' 처리(활동 탭 배지·레일 점 해제)
  const { markGroupSeen } = useActivityUnread();

  // 공유 그룹이면 멤버 아바타 스택 표시 (탭 → 그룹 관리)
  const { data: members = [] } = useGroupMembersQuery(!isPersonal ? currentGroupId : null);

  // ── 시트/딥링크 상태 ───────────────────────────────────────
  const [createGroupVisible, setCreateGroupVisible] = useState(false);
  const [inviteTarget, setInviteTarget] = useState<{ id: string; name: string } | null>(null);
  const { inviteToken, clearInviteToken } = useInviteDeepLink();

  // ── 폴더 데이터 ────────────────────────────────────────────
  const { data: folderList, isLoading, refetch, isRefetching } = useFoldersQuery(currentGroupId);

  // 첫 로딩(캐시 없음)일 때만 스켈레톤 → 로드 완료 시 실제 그리드 페이드인.
  // isFetching 이 아니라 isLoading 을 써서 캐시된 공간 전환에선 번쩍임이 없다.
  const reduceMotion = useReduceMotion();
  const gridFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isLoading) return;
    if (reduceMotion) {
      gridFade.setValue(1);
      return;
    }
    gridFade.setValue(0);
    Animated.timing(gridFade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [isLoading, reduceMotion, gridFade]);
  const createFolder = useCreateFolder(currentGroupId);
  const updateFolder = useUpdateFolder(currentGroupId);
  const deferredDelete = useDeferredDeleteFolder(currentGroupId);

  // ── 공유 인텐트 → 저장 위치 선택 시트 (시안 09) ─────────────
  const { pendingUrl, pendingTitleHint, clearPendingUrl } = useShareIntent();

  // ── 폴더 CRUD 시트 상태 ────────────────────────────────────
  const [createVisible, setCreateVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderColor, setFolderColor] = useState<FolderColorKey>('blue');
  const [folderEmoji, setFolderEmoji] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<{
    id: number;
    name: string;
    color: FolderColorKey;
    emoji: string | null;
  } | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  // 이모지 검색 그리드 열림/닫힘 (기본 닫힘 — 미리보기 타일/더보기 탭으로 열림)
  const [createEmojiOpen, setCreateEmojiOpen] = useState(false);
  const [editEmojiOpen, setEditEmojiOpen] = useState(false);
  // 생성 시 이름→이모지·색 자동추천. 사용자가 수동으로 바꾸면 true 가 되어 추천 중단.
  const [identityTouched, setIdentityTouched] = useState(false);

  const openCreateFolder = useCallback(() => {
    setFolderName('');
    setFolderColor('blue');
    setFolderEmoji(null);
    setCreateEmojiOpen(false);
    setIdentityTouched(false);
    setCreateVisible(true);
  }, []);

  // 이름을 칠 때마다(사용자가 아직 손대지 않았으면) 어울리는 이모지+색을 자동 채움.
  const handleCreateNameChange = useCallback(
    (text: string) => {
      setFolderName(text);
      if (!identityTouched) {
        const s = suggestIdentity(text);
        setFolderColor(s.color);
        setFolderEmoji(s.emoji);
      }
    },
    [identityTouched],
  );

  const handleCreate = () => {
    if (!folderName.trim()) {
      showToast('error', '폴더 이름을 입력해주세요');
      return;
    }
    createFolder.mutate(
      { name: folderName.trim(), color: folderColor, emoji: folderEmoji },
      {
        onSuccess: () => {
          if (folderEmoji) pushRecentEmoji(folderEmoji);
          setFolderName('');
          setFolderColor('blue');
          setFolderEmoji(null);
          setCreateVisible(false);
        },
      },
    );
  };

  const handleUpdate = () => {
    if (!editTarget?.name.trim()) {
      showToast('error', '폴더 이름을 입력해주세요');
      return;
    }
    updateFolder.mutate(
      { id: editTarget.id, name: editTarget.name.trim(), color: editTarget.color, emoji: editTarget.emoji },
      {
        onSuccess: () => {
          if (editTarget.emoji) pushRecentEmoji(editTarget.emoji);
          setEditVisible(false);
        },
      },
    );
  };

  const handleDelete = () => {
    if (!deleteTargetId) return;
    deferredDelete.execute(deleteTargetId);
  };

  const getPostCount = (folder: FolderItem): number => {
    if (folder.posts && Array.isArray(folder.posts) && folder.posts.length > 0) {
      return folder.posts[0].count ?? 0;
    }
    return 0;
  };

  const handleOpenFolder = useCallback(
    (id: number, name: string, color: string | null, emoji: string | null) => {
      // 이 그룹의 폴더를 열었으니 해당 그룹은 '읽음' 처리(안읽음 점/배지 해제)
      if (currentGroupId) markGroupSeen(currentGroupId);
      navigation.navigate('FolderDetail', {
        folderId: String(id),
        folderName: name,
        folderColor: color ?? undefined,
        folderEmoji: emoji ?? undefined,
      });
    },
    [navigation, currentGroupId, markGroupSeen],
  );

  const handleEditFolder = useCallback((id: number, name: string, color: FolderColorKey, emoji: string | null) => {
    setEditTarget({ id, name, color, emoji });
    setEditEmojiOpen(false);
    setEditVisible(true);
  }, []);

  const handleDeleteFolder = useCallback((id: number) => {
    setDeleteTargetId(id);
    setDeleteVisible(true);
  }, []);

  // ── 그리드 데이터: 폴더 + '새 폴더' 대시 타일 ────────────────
  const gridData = useMemo<GridItem[]>(() => {
    const items: GridItem[] = ((folderList ?? []) as FolderItem[]).map((f) => ({ kind: 'folder', folder: f }));
    if (canEdit && items.length > 0) items.push({ kind: 'add' });
    return items;
  }, [folderList, canEdit]);

  const renderItem = useCallback(
    ({ item }: { item: GridItem }) => {
      if (item.kind === 'add') {
        return (
          <TouchableOpacity
            style={[
              styles.addTile,
              // 대시 보더도 무드를 따른다 (66 = 40% 알파) — 안 그러면 민트/로즈 그룹에서 보더만 주황으로 남는다
              { width: cardWidth, borderColor: `${mood?.accent ?? colors.primary}66` },
            ]}
            onPress={openCreateFolder}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel="새 폴더 만들기"
          >
            <View style={styles.addTileCircle}>
              <PlusIcon size={15} color={mood?.accent ?? colors.primary} strokeWidth={2.4} />
            </View>
            <Text style={[styles.addTileText, { color: mood?.metaText ?? colors.textMuted }]}>새 폴더</Text>
          </TouchableOpacity>
        );
      }
      return (
        <FolderCard
          item={item.folder}
          postCount={getPostCount(item.folder)}
          canEdit={canEdit}
          warmTone={!isPersonal}
          width={cardWidth}
          onOpen={handleOpenFolder}
          onEdit={handleEditFolder}
          onDelete={handleDeleteFolder}
        />
      );
    },
    [canEdit, isPersonal, mood, cardWidth, openCreateFolder, handleOpenFolder, handleEditFolder, handleDeleteFolder],
  );

  const keyExtractor = useCallback((item: GridItem) => (item.kind === 'add' ? 'add-tile' : String(item.folder.id)), []);

  const folderCount = folderList?.length ?? 0;
  const totalLinks = (folderList ?? []).reduce((sum, f) => sum + getPostCount(f as FolderItem), 0);
  const displayName = isPersonal ? '나의 서랍' : (currentGroup?.name ?? '나의 서랍');

  return (
    <View style={styles.container}>
      {/* 공기 배경 — 개인 = 라벤더, 공유 그룹 = 그 그룹의 무드 */}
      <GlassBackground variant="personal" mood={mood?.key} />

      <View style={{ paddingTop: insets.top + 10 }}>
        {/* ── 채널 레일: 그룹 전환 (전역 '활동'은 하단 탭으로 이동) ── */}
        <GroupRail onCreateGroup={() => setCreateGroupVisible(true)} />

        {/* ── 타이틀 블록 ── */}
        <View style={styles.titleRow}>
          <View style={styles.titleLeft}>
            <Text style={styles.title} numberOfLines={1}>
              {displayName}
            </Text>
            {isPersonal ? (
              <Text style={styles.subMeta}>{`${totalLinks}개의 링크 · 폴더 ${folderCount}개`}</Text>
            ) : (
              <TouchableOpacity
                style={styles.memberRow}
                onPress={() => currentGroupId && navigation.navigate('MemberManage', { groupId: currentGroupId })}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="그룹 관리"
              >
                {members.length > 0 && <AvatarStack members={members} size={22} />}
                <Text
                  style={[styles.warmMeta, { color: mood?.metaText ?? colors.textMuted }]}
                >{`멤버 ${members.length}명 · ${totalLinks}개의 링크`}</Text>
              </TouchableOpacity>
            )}
          </View>
          {!isPersonal && currentGroupId && (
            <Button
              variant="glass"
              size="small"
              onPress={() => setInviteTarget({ id: currentGroupId, name: currentGroup?.name ?? '' })}
            >
              + 초대
            </Button>
          )}
        </View>
      </View>

      {isLoading ? (
        // 첫 로딩: 실제 그리드와 같은 모양의 스켈레톤 6개(거짓 빈 화면·점프 방지)
        <View style={styles.list} accessible accessibilityLabel="폴더 불러오는 중">
          {[0, 1, 2].map((row) => (
            <View key={row} style={styles.skelRow}>
              <FolderCardSkeleton width={cardWidth} />
              <FolderCardSkeleton width={cardWidth} />
            </View>
          ))}
        </View>
      ) : (
        <Animated.View style={[styles.gridWrap, { opacity: gridFade }]}>
          <FlatList
            data={gridData}
            key="folder-grid-2col"
            numColumns={2}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            columnWrapperStyle={styles.gridRow}
            contentContainerStyle={[styles.list, { paddingBottom: 130 + insets.bottom }]}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={7}
            refreshControl={
              <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
            }
            ListEmptyComponent={
              // 진짜로 폴더가 0개일 때만 (로딩 중엔 위 스켈레톤이 담당)
              <EmptyState
                type="folder"
                title="폴더가 없어요"
                subtitle={
                  isPersonal
                    ? '인스타에서 본 맛집, 유튜브에서 본 카페 —\n폴더를 만들어 링크를 모아보세요'
                    : '친구와 함께 첫 폴더를 만들어보세요'
                }
                mood={mood?.key}
              >
                {canEdit && (
                  <Button size="small" onPress={openCreateFolder}>
                    ＋ 첫 폴더 만들기
                  </Button>
                )}
              </EmptyState>
            }
          />
        </Animated.View>
      )}

      {/* ── 그룹 시트들 ── */}
      <CreateGroupSheet
        visible={createGroupVisible}
        onClose={() => setCreateGroupVisible(false)}
        onCreated={(g) => setInviteTarget(g)}
      />
      <InviteSheet
        visible={!!inviteTarget}
        onClose={() => setInviteTarget(null)}
        groupId={inviteTarget?.id ?? null}
        groupName={inviteTarget?.name ?? ''}
      />
      <InviteAcceptSheet token={inviteToken} onClose={clearInviteToken} />

      {/* ── 공유 인텐트 → 저장 위치 선택 (시안 09) ── */}
      <SaveLinkSheet
        visible={!!pendingUrl}
        onClose={clearPendingUrl}
        initialUrl={pendingUrl}
        titleHint={pendingTitleHint}
      />

      {/* ── 폴더 생성 — 이름 입력은 상단 고정, 버튼은 하단 고정 (색상/이모지만 스크롤) ── */}
      <BottomSheet
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        title="새 폴더"
        description="링크를 모아볼 폴더를 만들어보세요"
        fixedTop={
          <View style={styles.sheetTopRow}>
            <FolderTilePreview
              color={folderColor}
              emoji={folderEmoji}
              active={createEmojiOpen}
              onPress={() => setCreateEmojiOpen((o) => !o)}
            />
            <View style={styles.sheetTopInput}>
              <Input placeholder="폴더 이름을 입력해주세요" value={folderName} onChangeText={handleCreateNameChange} autoFocus />
            </View>
          </View>
        }
        footer={
          <View style={styles.sheetBtns}>
            <Button variant="secondary" onPress={() => setCreateVisible(false)} style={{ flex: 1 }}>닫기</Button>
            <Button onPress={handleCreate} loading={createFolder.isPending} style={{ flex: 1.4 }}>만들기</Button>
          </View>
        }
      >
        <FolderIdentityPicker
          name={folderName}
          color={folderColor}
          emoji={folderEmoji}
          onChange={({ color, emoji }) => {
            setFolderColor(color);
            setFolderEmoji(emoji);
          }}
          onManualChange={() => setIdentityTouched(true)}
          searchOpen={createEmojiOpen}
          onSearchOpenChange={setCreateEmojiOpen}
        />
      </BottomSheet>

      {/* ── 폴더 수정 ── */}
      <BottomSheet
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        title="폴더 수정"
        fixedTop={
          <View style={styles.sheetTopRow}>
            <FolderTilePreview
              color={editTarget?.color ?? 'blue'}
              emoji={editTarget?.emoji ?? null}
              active={editEmojiOpen}
              onPress={() => setEditEmojiOpen((o) => !o)}
            />
            <View style={styles.sheetTopInput}>
              <Input placeholder="새로운 이름" value={editTarget?.name ?? ''} onChangeText={(t) => setEditTarget((p) => (p ? { ...p, name: t } : null))} autoFocus />
            </View>
          </View>
        }
        footer={
          <View style={styles.sheetBtns}>
            <Button variant="secondary" onPress={() => setEditVisible(false)} style={{ flex: 1 }}>취소</Button>
            <Button onPress={handleUpdate} loading={updateFolder.isPending} style={{ flex: 1.4 }}>저장</Button>
          </View>
        }
      >
        <FolderIdentityPicker
          name={editTarget?.name ?? ''}
          color={editTarget?.color ?? 'blue'}
          emoji={editTarget?.emoji ?? null}
          onChange={({ color, emoji }) => setEditTarget((p) => (p ? { ...p, color, emoji } : null))}
          searchOpen={editEmojiOpen}
          onSearchOpenChange={setEditEmojiOpen}
        />
      </BottomSheet>

      <AlertDialog visible={deleteVisible} onClose={() => setDeleteVisible(false)} title="폴더를 삭제할까요?" description="폴더 안의 모든 링크도 함께 삭제돼요" confirmText="삭제" onConfirm={handleDelete} destructive />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F9FE' },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 16,
    gap: 10,
  },
  titleLeft: { flexShrink: 1 },
  title: {
    fontSize: 26,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -1.04, // -0.04em
  },
  subMeta: { fontSize: 13, fontFamily: 'LINESeedKR', color: '#6A6488', marginTop: 4 }, // 라벤더 공기 위 메타 (v3)
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6 },
  // color 는 사용처에서 현재 무드로 인라인 주입 (StyleSheet 안에서는 훅을 쓸 수 없음)
  warmMeta: { fontSize: 12, fontFamily: 'LINESeedKR' },
  list: { paddingHorizontal: 22, paddingTop: 14 },
  gridWrap: { flex: 1 },
  skelRow: { flexDirection: 'row', gap: 11 },
  gridRow: { gap: 11 },
  folderCard: {
    // width 는 렌더 시 픽셀로 주입 (cardWidth)
    height: 102,
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 13,
    marginBottom: 11,
  },
  folderTile: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderName: {
    fontSize: 14,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.28, // -0.02em
    marginTop: 8,
  },
  folderCount: {
    ...typo.count,
    fontSize: 11,
    marginTop: 1,
  },
  folderMenu: { position: 'absolute', top: 8, right: 8 },
  folderMenuBtn: { padding: 5 },
  addTile: {
    // width 는 렌더 시 픽셀로 주입 (cardWidth)
    height: 102,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 11,
  },
  addTileCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: glass.bgStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTileText: { fontSize: 12, fontFamily: 'LINESeedKR-Bold', color: colors.textMuted },
  folderEmoji: { fontSize: 18 },
  sheetBtns: { flexDirection: 'row', gap: 10 }, // footer 고정 영역이 패딩을 담당
  sheetTopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sheetTopInput: { flex: 1 },
});
