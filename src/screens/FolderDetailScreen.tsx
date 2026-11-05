import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  FlatList,
  LayoutAnimation,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AvatarStack from '../components/AvatarStack';
import BottomSheet from '../components/BottomSheet';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import GlassBackground from '../components/GlassBackground';
import {
  ArrowUpDownIcon,
  ChevronLeftIcon,
  LayoutGridIcon,
  ListIcon as ListGlyphIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from '../components/icons';
import Input from '../components/Input';
import LinkPreviewCard, {
  type LinkPreviewCardHandle,
  LinkPreviewCardSkeleton,
  ViewMode,
} from '../components/LinkPreviewCard';
import { useToast } from '../components/Toast';
import { colors, glass, shadows } from '../constants/theme';
import { useGroup } from '../contexts/GroupContext';
import { useCreatePost, useGroupMembersQuery, usePostsQuery, useRefreshPreview, useUpdatePost } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { useCurrentMood } from '../hooks/useCurrentMood';
import { usePreviewCatchUp } from '../hooks/usePreviewCatchUp';
import { MainStackParamList } from '../navigation/types';
import { mediumTap } from '../utils/haptics';
import { canRetryPreview, normalizeForCompare } from '../utils/preview/types';
import { isValidUrl } from '../utils/validateUrl';

// Android LayoutAnimation 활성화
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type FolderDetailRouteProp = RouteProp<MainStackParamList, 'FolderDetail'>;
type Nav = NativeStackNavigationProp<MainStackParamList, 'FolderDetail'>;
type SortOrder = 'newest' | 'oldest';
// 메모 수정 시트가 든 행. url·preview_status 는 시트 하단 '미리보기 다시 불러오기' 가 쓴다 (failed 일 때만 노출)
type EditTarget = { id: number; description: string; url: string; preview_status: string | null };

// 보기 모드·정렬 순서는 사용자 선호로 기억한다 (방문마다 리셋되지 않도록).
const VIEW_MODE_KEY = 'moaring.folderViewMode';
const SORT_ORDER_KEY = 'moaring.folderSortOrder';

/**
 * 폴더 상세 — 블루 글래스 시안 07 "링크 피드".
 * 커스텀 헤더(유리 백 버튼 + 브레드크럼 + 아바타 스택) + 정렬 칩 + 유리 링크 카드.
 * 네이티브 스택 헤더는 끔 (MainStack headerShown: false) — 공기 배경 위에 직접 그린다.
 */
export default function FolderDetailScreen() {
  const mood = useCurrentMood();
  const route = useRoute<FolderDetailRouteProp>();
  const navigation = useNavigation<Nav>();
  const { folderId, folderName, folderEmoji } = route.params;
  const insets = useSafeAreaInsets(); // Android edge-to-edge 하단 대응
  const { showToast } = useToast();

  const [viewMode, setViewMode] = useState<ViewMode>('large');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [createVisible, setCreateVisible] = useState(false);
  const [postUrl, setPostUrl] = useState('');
  const [postDescription, setPostDescription] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // 링크 수정 상태
  const [editVisible, setEditVisible] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  const { data: postList, isLoading, refetch, isRefetching } = usePostsQuery(folderId);
  // 아래 handleEditPress·handleRetryPreview 가 postList 를 deps 로 잡으면 pending 행이 있는 동안 3 s 폴링마다
  // renderItem 이 새로 만들어져 보이는 카드 전부의 React.memo 가 깨진다. 콜백은 눌렀을 때만 행을 찾으니
  // 최신 목록을 ref 로 읽어 identity 를 고정한다 (렌더마다 갱신)
  const postListRef = useRef(postList);
  postListRef.current = postList;
  const createPost = useCreatePost();
  const updatePost = useUpdatePost(folderId);
  // mutate 만 꺼내는 이유: useMutation 결과 객체는 렌더마다 새로 만들어지지만 mutate 참조는 고정이라
  // 아래 handleRetryPreview 의 useCallback 이 (그리고 카드의 React.memo 가) 깨지지 않는다
  const { mutate: refreshPreview } = useRefreshPreview(folderId);

  const filteredList = useMemo(() => {
    let list = postList ?? [];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      // 서버가 수집한 제목도 검색 대상 — 사용자는 URL 이 아니라 "그 영상 제목" 으로 기억한다
      list = list.filter(
        (item) =>
          item.url.toLowerCase().includes(q) ||
          (item.description && item.description.toLowerCase().includes(q)) ||
          item.preview_title?.toLowerCase().includes(q),
      );
    }

    return [...list].sort((a, b) => {
      const dateA = new Date(a.created_at ?? 0).getTime();
      const dateB = new Date(b.created_at ?? 0).getTime();
      return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
    });
  }, [postList, searchQuery, sortOrder]);

  const handleCreate = () => {
    const url = postUrl.trim();
    if (!url) {
      showToast('error', 'URL을 입력해주세요');
      return;
    }
    if (!isValidUrl(url)) {
      showToast('error', '올바른 URL 형식이 아니에요 (https://...)');
      return;
    }

    // 추적 파라미터(utm_*, igsh, si …)·호스트 대소문자·끝 슬래시만 다른 링크는 같은 글이다. posts.url 자체는 원문 보존
    const target = normalizeForCompare(url);
    const isDuplicate = postList?.some((item) => normalizeForCompare(item.url) === target);
    if (isDuplicate) {
      showToast('error', '이미 저장된 링크예요');
      return;
    }

    createPost.mutate(
      { url, description: postDescription.trim() || null, folder_id: Number(folderId) },
      {
        onSuccess: () => {
          setPostUrl('');
          setPostDescription('');
          setCreateVisible(false);
        },
      },
    );
  };

  const handleUpdateDescription = () => {
    if (!editTarget) return;
    updatePost.mutate(
      { id: editTarget.id, description: editTarget.description.trim() || null },
      {
        onSuccess: () => setEditVisible(false),
      },
    );
  };

  // 저장된 보기/정렬 선호를 로드 (없으면 기본값 유지)
  useEffect(() => {
    AsyncStorage.multiGet([VIEW_MODE_KEY, SORT_ORDER_KEY])
      .then((entries) => {
        const map = Object.fromEntries(entries);
        if (map[VIEW_MODE_KEY] === 'large' || map[VIEW_MODE_KEY] === 'compact') {
          setViewMode(map[VIEW_MODE_KEY]);
        }
        if (map[SORT_ORDER_KEY] === 'newest' || map[SORT_ORDER_KEY] === 'oldest') {
          setSortOrder(map[SORT_ORDER_KEY]);
        }
      })
      .catch(() => {});
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    mediumTap();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setViewMode(mode);
    AsyncStorage.setItem(VIEW_MODE_KEY, mode).catch(() => {});
  }, []);

  const handleSortToggle = useCallback(() => {
    mediumTap();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSortOrder((prev) => {
      const next = prev === 'newest' ? 'oldest' : 'newest';
      AsyncStorage.setItem(SORT_ORDER_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const toggleSearch = useCallback(() => {
    mediumTap();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSearchVisible((v) => {
      if (v) setSearchQuery('');
      return !v;
    });
  }, []);

  const handleEditPress = useCallback(
    (id: number, description: string | null) => {
      // 카드는 id·메모만 넘기므로 시트의 '미리보기 다시 불러오기' 에 필요한 url·상태는 행에서 꺼낸다
      const row = postListRef.current?.find((p) => p.id === id);
      setEditTarget({
        id,
        description: description ?? '',
        url: row?.url ?? '',
        preview_status: row?.preview_status ?? null,
      });
      setEditVisible(true);
    },
    [],
  );

  // '미리보기 다시 불러오기' — 메모 수정 시트(주 진입점)와 failed 카드 안의 링크(보조 진입점)가 같이 쓴다.
  // 폰이 먼저 파싱해 힌트를 만들고 서버에 force 재수집을 보낸다 (쿨다운·토스트는 훅 안).
  const handleRetryPreview = useCallback(
    (id: number) => {
      const row = postListRef.current?.find((p) => p.id === id);
      if (row) refreshPreview({ postId: id, url: row.url });
    },
    [refreshPreview],
  );

  // ── 그룹 권한 + 멤버 정보 (권한 규칙 / 추가한 사람) ──
  const { myRole, isPersonal, currentGroupId, currentGroup } = useGroup();
  const canEdit = myRole !== 'viewer';
  // 미리보기 백필·재시도의 유일한 경로: pending·일시 failed·stale fetching 행을 서버에 다시 맡기고,
  // canEdit 이면 서버가 차단당한(needs_client) 행을 폰 IP 로 한 번 보조한다. 토스트·에러 화면 없음
  usePreviewCatchUp(folderId, postList, canEdit);
  const { session } = useAuth();
  const myUserId = session?.user?.id ?? null;
  const { data: members = [] } = useGroupMembersQuery(!isPersonal ? currentGroupId : null);
  const memberMap = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);

  // iOS Mail 패턴: 한 번에 한 카드만 열린 상태로 유지.
  const lastOpenedRef = useRef<LinkPreviewCardHandle | null>(null);
  const handleSwipeStart = useCallback((handle: LinkPreviewCardHandle) => {
    if (lastOpenedRef.current && lastOpenedRef.current !== handle) {
      lastOpenedRef.current.close();
    }
    lastOpenedRef.current = handle;
  }, []);

  const renderItem = useCallback(
    ({
      item,
    }: {
      item: {
        id: number;
        url: string;
        description: string | null;
        user_id: string | null;
        created_at: string | null;
        preview_title: string | null;
        preview_description: string | null;
        preview_author: string | null;
        preview_site_name: string | null;
        preview_image_url: string | null;
        preview_status: string | null;
        preview_claimed_at: string | null;
      };
    }) => {
      const member = !isPersonal && item.user_id ? memberMap.get(item.user_id) : undefined;
      return (
        <LinkPreviewCard
          id={item.id}
          url={item.url}
          userDescription={item.description}
          folderId={folderId}
          viewMode={viewMode}
          onEditPress={canEdit ? handleEditPress : undefined}
          onSwipeStart={handleSwipeStart}
          canEdit={canEdit}
          addedByUserId={!isPersonal ? item.user_id : null}
          addedByName={member?.displayName ?? null}
          addedByAvatar={member?.avatarUrl ?? null}
          addedByIsMine={item.user_id === myUserId}
          createdAt={item.created_at}
          previewTitle={item.preview_title}
          previewDescription={item.preview_description}
          previewAuthor={item.preview_author}
          previewSiteName={item.preview_site_name}
          previewImageUrl={item.preview_image_url}
          previewStatus={item.preview_status}
          previewClaimedAt={item.preview_claimed_at}
          onRetryPreview={canEdit ? handleRetryPreview : undefined}
        />
      );
    },
    [
      folderId,
      viewMode,
      handleEditPress,
      handleRetryPreview,
      handleSwipeStart,
      canEdit,
      isPersonal,
      memberMap,
      myUserId,
    ],
  );

  const keyExtractor = useCallback((item: { id: number }) => String(item.id), []);

  const ItemSeparator = useCallback(() => <View style={{ height: viewMode === 'compact' ? 8 : 11 }} />, [viewMode]);

  const count = postList?.length ?? 0;
  // 크롬에서 이모지 폐지 — 공간 구분은 배경 공기와 무드색이 담당한다
  const crumb = isPersonal
    ? `나의 서랍 · ${count}개의 링크`
    : `${currentGroup?.name ?? '그룹'} · ${count}개의 링크`;

  return (
    <View style={styles.container}>
      <GlassBackground variant="personal" mood={mood?.key} />

      {/* ── 커스텀 헤더: 유리 백 버튼 + 타이틀/브레드크럼 + 아바타 ── */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="뒤로 가기"
          >
            <ChevronLeftIcon size={17} color={colors.ink} strokeWidth={2.4} />
          </TouchableOpacity>
          <View style={styles.headerTitleWrap}>
            <View style={styles.headerTitleRow}>
              {folderEmoji ? <Text style={styles.headerEmoji}>{folderEmoji}</Text> : null}
              <Text style={styles.headerTitle} numberOfLines={1}>
                {folderName || '폴더'}
              </Text>
            </View>
            <Text style={[styles.headerCrumb, { color: mood?.metaText ?? colors.textFaint }]} numberOfLines={1}>
              {crumb}
            </Text>
          </View>
        </View>
        {!isPersonal && members.length > 0 && (
          <TouchableOpacity
            onPress={() => currentGroupId && navigation.navigate('MemberManage', { groupId: currentGroupId })}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="그룹 관리"
          >
            <AvatarStack members={members} size={30} />
          </TouchableOpacity>
        )}
      </View>

      {/* ── 필터 칩: 정렬 + 보기 전환 + 검색 ── */}
      <View style={styles.filterRow}>
        <TouchableOpacity
          style={styles.sortChip}
          onPress={handleSortToggle}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={`정렬 기준: ${sortOrder === 'newest' ? '최신순' : '오래된순'}. 눌러서 전환`}
        >
          <ArrowUpDownIcon size={13} color={colors.textMuted} strokeWidth={2.2} />
          <Text style={styles.sortChipText}>{sortOrder === 'newest' ? '최신순' : '오래된순'}</Text>
        </TouchableOpacity>

        <View style={styles.viewToggle}>
          <TouchableOpacity
            style={[styles.viewToggleBtn, viewMode === 'large' && styles.viewToggleBtnActive]}
            onPress={() => handleViewModeChange('large')}
            activeOpacity={0.6}
            accessibilityRole="radio"
            accessibilityState={{ checked: viewMode === 'large' }}
            accessibilityLabel="큰 카드 보기"
          >
            <LayoutGridIcon size={15} color={viewMode === 'large' ? colors.primary : colors.textFaint} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.viewToggleBtn, viewMode === 'compact' && styles.viewToggleBtnActive]}
            onPress={() => handleViewModeChange('compact')}
            activeOpacity={0.6}
            accessibilityRole="radio"
            accessibilityState={{ checked: viewMode === 'compact' }}
            accessibilityLabel="간단히 보기"
          >
            <ListGlyphIcon size={15} color={viewMode === 'compact' ? colors.primary : colors.textFaint} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.searchChip, searchVisible && styles.searchChipActive]}
          onPress={toggleSearch}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={searchVisible ? '검색 닫기' : '검색'}
        >
          {searchVisible ? (
            <XIcon size={15} color={colors.primary} strokeWidth={2.2} />
          ) : (
            <SearchIcon size={15} color={colors.textMuted} strokeWidth={2.2} />
          )}
        </TouchableOpacity>
      </View>

      {/* ── 검색 바 (토글) ── */}
      {searchVisible && (
        <View style={styles.searchBarWrap}>
          <View style={styles.searchBar}>
            <SearchIcon size={15} color={colors.textDisabled} />
            <TextInput
              style={styles.searchInput}
              placeholder="링크 검색..."
              placeholderTextColor={colors.textDisabled}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
          </View>
        </View>
      )}

      {isLoading ? (
        <View style={styles.list}>
          {[1, 2, 3].map((i) => (
            <View key={i} style={{ marginBottom: 11 }}>
              <LinkPreviewCardSkeleton viewMode={viewMode} />
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={filteredList}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
          ItemSeparatorComponent={ItemSeparator}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
          ListEmptyComponent={
            searchQuery ? (
              <EmptyState type="search" title="검색 결과가 없어요" subtitle="다른 키워드로 검색해보세요" mood={mood?.key} />
            ) : (
              <EmptyState
                type="link"
                title="아직 링크가 없어요"
                subtitle={
                  isPersonal
                    ? '인스타에서 본 맛집, 유튜브에서 본 카페 —\n첫 링크를 모아보세요'
                    : '친구와 함께 첫 링크를 모아보세요'
                }
                mood={mood?.key}
                // 킬러기능(공유하기로 저장) 은 앱 안에서 발견될 길이 없어 여기서 알린다.
                // 저장 권한이 없는 viewer 에겐 CTA 와 같은 조건으로 숨긴다.
                hint={canEdit ? '유튜브·인스타에서 공유하기 → 모아링을 눌러도 저장돼요' : undefined}
              >
                {canEdit && (
                  <Button
                    size="small"
                    onPress={() => {
                      setPostUrl('');
                      setPostDescription('');
                      setCreateVisible(true);
                    }}
                  >
                    ＋ 첫 링크 저장하기
                  </Button>
                )}
              </EmptyState>
            )
          }
        />
      )}

      {/* viewer 는 링크 추가 FAB 숨김 (권한 규칙) */}
      {canEdit && (
        <TouchableOpacity
          style={[styles.fab, { bottom: 26 + insets.bottom }]}
          onPress={() => {
            setPostUrl('');
            setPostDescription('');
            setCreateVisible(true);
          }}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="링크 추가"
        >
          <PlusIcon size={24} color={colors.white} strokeWidth={2.8} />
        </TouchableOpacity>
      )}

      {/* 링크 추가 바텀시트 */}
      <BottomSheet visible={createVisible} onClose={() => setCreateVisible(false)} title="링크 추가">
        <View style={styles.form}>
          <Input
            label="URL"
            placeholder="https://"
            value={postUrl}
            onChangeText={setPostUrl}
            autoCapitalize="none"
            keyboardType="url"
            autoFocus
          />
          <Input
            label="메모 (선택)"
            placeholder="이 링크에 대한 메모"
            value={postDescription}
            onChangeText={setPostDescription}
          />
        </View>
        <View style={styles.sheetBtns}>
          <Button variant="secondary" onPress={() => setCreateVisible(false)} style={{ flex: 1 }}>
            취소
          </Button>
          <Button onPress={handleCreate} loading={createPost.isPending} style={{ flex: 1.4 }}>
            추가
          </Button>
        </View>
      </BottomSheet>

      {/* 메모 수정 바텀시트 */}
      <BottomSheet visible={editVisible} onClose={() => setEditVisible(false)} title="메모 수정">
        <Input
          placeholder="메모를 입력해주세요"
          value={editTarget?.description ?? ''}
          onChangeText={(t) => setEditTarget((p) => (p ? { ...p, description: t } : null))}
          autoFocus
        />
        <View style={styles.sheetBtns}>
          <Button variant="secondary" onPress={() => setEditVisible(false)} style={{ flex: 1 }}>
            취소
          </Button>
          <Button onPress={handleUpdateDescription} loading={updatePost.isPending} style={{ flex: 1.4 }}>
            저장
          </Button>
        </View>
        {/* 수동 재수집 — 일시 실패(failed) 만. unsupported(삭제·비공개) 는 다시 눌러도 같으니 숨긴다 */}
        {canEdit && canRetryPreview(editTarget?.preview_status) && (
          <Button
            variant="secondary"
            size="small"
            style={styles.sheetRetryBtn}
            onPress={() => {
              if (editTarget) handleRetryPreview(editTarget.id);
              setEditVisible(false);
            }}
          >
            미리보기 다시 불러오기
          </Button>
        )}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F9FE' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    gap: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleWrap: { flexShrink: 1, gap: 1 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  headerEmoji: { fontSize: 18 },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.6, // -0.03em
  },
  headerCrumb: {
    fontSize: 12,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  sortChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: glass.bgSoft,
    borderWidth: 1,
    borderColor: glass.borderSoft,
    borderRadius: 19,
    paddingLeft: 11,
    paddingRight: 13,
    paddingVertical: 8,
  },
  sortChipText: {
    fontSize: 12,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.textSub,
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: glass.bgSoft,
    borderWidth: 1,
    borderColor: glass.borderSoft,
    borderRadius: 19,
    padding: 2,
  },
  viewToggleBtn: {
    width: 34,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewToggleBtnActive: {
    backgroundColor: glass.bgStrong,
    ...shadows.card,
  },
  searchChip: {
    marginLeft: 'auto',
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: glass.bgSoft,
    borderWidth: 1,
    borderColor: glass.borderSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchChipActive: {
    backgroundColor: glass.bgStrong,
    borderColor: glass.border,
  },
  searchBarWrap: {
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: glass.bgStrong,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 14,
    paddingHorizontal: 13,
    height: 42,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'LINESeedKR',
    color: colors.ink,
    paddingVertical: 0,
  },
  list: { paddingHorizontal: 20, paddingTop: 14 },
  form: { gap: 16 },
  sheetBtns: { flexDirection: 'row', gap: 10, marginTop: 26, marginBottom: 8 },
  // 취소/저장 행 아래 보조 동작 — 행 사이 간격을 가로 gap(10)과 맞춘다
  sheetRetryBtn: { marginTop: 2, marginBottom: 8 },
  fab: {
    position: 'absolute',
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.fab,
  },
});
