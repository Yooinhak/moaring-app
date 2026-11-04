import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Reanimated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import { colors, glass, shadows } from '../constants/theme';
import { useDeferredDeletePost } from '../hooks/queries';
import { getDomainInfo } from '../utils/domainInfo';
import { mediumTap, selectionTap, warningTap } from '../utils/haptics';
import { openLink } from '../utils/openLink';
import { parseMetadata } from '../utils/parseMetadata';
import { queryKeys } from '../utils/react-query/queryKeys';
import { relativeTime } from '../utils/relativeTime';

import { Avatar } from './AvatarStack';
import FaviconBadge from './FaviconBadge';
import { TrashIcon } from './icons';
import Skeleton from './Skeleton';

export type ViewMode = 'large' | 'compact';

export interface LinkPreviewCardHandle {
  close: () => void;
}

interface LinkPreviewCardProps {
  id: number;
  url: string;
  userDescription: string | null;
  folderId: string;
  viewMode?: ViewMode;
  onEditPress?: (id: number, description: string | null) => void;
  onSwipeStart?: (handle: LinkPreviewCardHandle) => void;
  /** viewer 권한이면 false — 스와이프 삭제/메모 수정 진입점 전부 숨김 (시안 권한 규칙) */
  canEdit?: boolean;
  /** 시안 ⑦ "추가한 사람" — 공유 그룹에서만 전달 (개인 그룹 = 미표시).
   *  memo 최적화를 위해 원시값으로 받는다. */
  addedByUserId?: string | null;
  addedByName?: string | null;
  addedByAvatar?: string | null;
  addedByIsMine?: boolean;
  createdAt?: string | null;
}

const RIGHT_ACTION_WIDTH = 80;
const SELECTION_THRESHOLD = 40;
const HAPTIC_RESET_THRESHOLD = 10;

export function LinkPreviewCardSkeleton({ viewMode = 'large' }: { viewMode?: ViewMode }) {
  if (viewMode === 'compact') {
    return (
      <View style={compactStyles.card}>
        <Skeleton width={40} height={40} borderRadius={11} />
        <View style={compactStyles.body}>
          <Skeleton width="70%" height={15} />
          <Skeleton width="50%" height={12} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Skeleton width="100%" height={120} borderRadius={12} />
      <View style={styles.body}>
        <Skeleton width="70%" height={16} />
        <Skeleton width="100%" height={14} />
        <Skeleton width="50%" height={12} />
      </View>
    </View>
  );
}

// UI-thread worklet 으로 우측 삭제 액션을 렌더. translation 이 임계값을 처음 cross 할 때
// selectionTap 햅틱을 1회 발생시키고, 닫힘 근처로 돌아오면 다시 발사 가능 상태로 리셋한다.
// 스와이프 자체는 다이얼로그를 트리거하지 않으며, 사용자가 노출된 버튼을 탭해야 onPress 가 호출된다.
function RightAction({ translation, onPress }: { translation: SharedValue<number>; onPress: () => void }) {
  const hapticFired = useSharedValue(false);

  useAnimatedReaction(
    () => translation.value,
    (current) => {
      if (current <= -SELECTION_THRESHOLD && !hapticFired.value) {
        hapticFired.value = true;
        runOnJS(selectionTap)();
      } else if (current > -HAPTIC_RESET_THRESHOLD && hapticFired.value) {
        hapticFired.value = false;
      }
    },
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          translation.value,
          [-RIGHT_ACTION_WIDTH, 0],
          [0, RIGHT_ACTION_WIDTH],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  return (
    <Reanimated.View style={[swipeStyles.rightActionContainer, animatedStyle]}>
      <TouchableOpacity
        style={swipeStyles.rightAction}
        onPress={onPress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="링크 삭제"
      >
        <TrashIcon size={22} color={colors.white} strokeWidth={2} />
        <Text style={swipeStyles.rightActionText}>삭제</Text>
      </TouchableOpacity>
    </Reanimated.View>
  );
}

const LinkPreviewCard = forwardRef<LinkPreviewCardHandle, LinkPreviewCardProps>(function LinkPreviewCard(
  {
    id,
    url,
    userDescription,
    folderId,
    viewMode = 'large',
    onEditPress,
    onSwipeStart,
    canEdit = true,
    addedByUserId = null,
    addedByName = null,
    addedByAvatar = null,
    addedByIsMine = false,
    createdAt = null,
  },
  ref,
) {
  const [imageFailed, setImageFailed] = useState(false);
  const deferredDelete = useDeferredDeletePost(folderId);
  const swipeableRef = useRef<SwipeableMethods>(null);

  const handle = useMemo<LinkPreviewCardHandle>(() => ({ close: () => swipeableRef.current?.close() }), []);

  useImperativeHandle(ref, () => handle, [handle]);

  const { data: metadata, isLoading } = useQuery({
    queryKey: [queryKeys.METADATA, url],
    queryFn: () => parseMetadata(url),
    enabled: !!url,
  });

  // 스와이프로 노출된 삭제 버튼을 탭하면 즉시 삭제한다. 확인창 대신 6초 실행취소
  // 토스트(useDeferredDeletePost)가 안전장치 역할을 한다 — 마찰을 줄인 삭제 흐름(2026-07-16).
  const handleDelete = useCallback(() => {
    warningTap();
    deferredDelete.execute(id);
    swipeableRef.current?.close();
  }, [deferredDelete, id]);

  // 카드 롱프레스 → 메모 수정(오버레이 버튼을 없앤 대신의 진입점).
  const handleLongPress = useCallback(() => {
    if (!onEditPress) return;
    mediumTap();
    onEditPress(id, userDescription);
  }, [onEditPress, id, userDescription]);

  const renderRightActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <RightAction translation={translation} onPress={handleDelete} />
    ),
    [handleDelete],
  );

  // 드래그 시작 시점에 부모(FolderDetailScreen)에 자신의 핸들을 전달한다.
  // 부모는 이전에 열려 있던 카드를 닫아 'iOS Mail' 패턴의 단일 오픈 상태를 유지한다.
  const handleSwipeStartDrag = useCallback(() => {
    onSwipeStart?.(handle);
  }, [onSwipeStart, handle]);

  const domain = (() => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url;
    }
  })();

  // 표시용 서비스명 — 알려진 서비스는 브랜드명(YouTube, 티스토리 등), 그 외엔 도메인
  const domainLabel = getDomainInfo(url)?.label ?? domain;

  const cardContent =
    viewMode === 'compact' ? (
      <TouchableOpacity
        style={compactStyles.card}
        onPress={() => openLink(url)}
        onLongPress={canEdit ? handleLongPress : undefined}
        delayLongPress={280}
        activeOpacity={0.6}
        accessibilityRole="link"
        accessibilityLabel={`${metadata?.title || domain} 링크 열기`}
        accessibilityHint={canEdit ? '길게 눌러 메모 수정' : undefined}
      >
        {/* Compact Thumbnail */}
        {isLoading ? (
          <Skeleton width={40} height={40} borderRadius={11} />
        ) : metadata?.image && !imageFailed ? (
          <Image
            source={{ uri: metadata.image }}
            style={compactStyles.thumbnail}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={200}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <View style={compactStyles.thumbnailFallback}>
            <Text style={compactStyles.thumbnailFallbackText}>{domain.charAt(0).toUpperCase()}</Text>
          </View>
        )}

        {/* Compact Content */}
        <View style={compactStyles.body}>
          {isLoading ? (
            <View style={{ gap: 6 }}>
              <Skeleton width="70%" height={15} />
              <Skeleton width="50%" height={12} />
            </View>
          ) : (
            <>
              <Text style={compactStyles.title} numberOfLines={1}>
                {metadata?.title || domain}
              </Text>
              <View style={compactStyles.domainRow}>
                <FaviconBadge url={url} size={13} />
                <Text style={compactStyles.domain} numberOfLines={1}>
                  {domainLabel}
                </Text>
                {/* 시안 ⑦: compact 는 추가한 사람 아바타만 */}
                {addedByUserId && (
                  <Avatar
                    member={{ userId: addedByUserId, displayName: addedByName, avatarUrl: addedByAvatar }}
                    size={14}
                  />
                )}
              </View>
              {userDescription && (
                <Text style={compactStyles.memo} numberOfLines={1}>
                  {userDescription}
                </Text>
              )}
            </>
          )}
        </View>

      </TouchableOpacity>
    ) : (
      <TouchableOpacity
        style={styles.card}
        onPress={() => openLink(url)}
        onLongPress={canEdit ? handleLongPress : undefined}
        delayLongPress={280}
        activeOpacity={0.6}
        accessibilityRole="link"
        accessibilityLabel={`${metadata?.title || domain} 링크 열기`}
        accessibilityHint={canEdit ? '길게 눌러 메모 수정' : undefined}
      >
        {/* Thumbnail + 도메인 배지 오버레이 (시안 07: INSTAGRAM 스타일) */}
        {isLoading ? (
          <Skeleton width="100%" height={110} borderRadius={12} />
        ) : (
          <View>
            {metadata?.image && !imageFailed ? (
              <Image
                source={{ uri: metadata.image }}
                style={styles.thumbnail}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={200}
                onError={() => setImageFailed(true)}
              />
            ) : (
              // 메타 이미지가 없으면 틴트 배경 + 흰 이니셜 타일
              <View style={styles.thumbnailFallback}>
                <View style={styles.thumbnailFallbackTile}>
                  <Text style={styles.thumbnailFallbackText}>{domain.charAt(0).toUpperCase()}</Text>
                </View>
              </View>
            )}
            <View style={styles.domainBadge}>
              <FaviconBadge url={url} size={11} />
              <Text style={styles.domainBadgeText} numberOfLines={1}>
                {domainLabel.toUpperCase()}
              </Text>
            </View>
          </View>
        )}

        {/* Content */}
        <View style={styles.body}>
          {isLoading ? (
            <View style={{ gap: 8 }}>
              <Skeleton width="70%" height={16} />
              <Skeleton width="100%" height={14} />
            </View>
          ) : (
            <>
              <Text style={styles.title} numberOfLines={2}>
                {metadata?.title || domain}
              </Text>
              {!!metadata?.description && (
                <Text style={styles.description} numberOfLines={2}>
                  {metadata.description}
                </Text>
              )}
            </>
          )}

          {/* 메모 — 시안 07: 💬 인용 박스 (파란 좌측 보더) */}
          {userDescription && (
            <View style={styles.memo}>
              <Text style={styles.memoText} numberOfLines={2}>
                💬 {userDescription}
              </Text>
            </View>
          )}

          {/* 시안 ⑦: 추가한 사람 푸터 — 공유 그룹에서만. 내가 추가한 링크는 이름 생략 */}
          {addedByUserId && (
            <View style={styles.addedByRow}>
              <Avatar
                member={{ userId: addedByUserId, displayName: addedByName, avatarUrl: addedByAvatar }}
                size={18}
              />
              <Text style={styles.addedByText} numberOfLines={1}>
                {addedByIsMine
                  ? relativeTime(createdAt)
                  : `${addedByName ?? '멤버'}님이 추가 · ${relativeTime(createdAt)}`}
              </Text>
            </View>
          )}
        </View>

      </TouchableOpacity>
    );

  // viewer 는 스와이프 삭제도 비노출 — Swipeable 래핑 자체를 생략
  if (!canEdit) {
    return cardContent;
  }

  return (
    <>
      <ReanimatedSwipeable
        ref={swipeableRef}
        renderRightActions={renderRightActions}
        onSwipeableOpenStartDrag={handleSwipeStartDrag}
        friction={1.5}
        rightThreshold={40}
        overshootFriction={8}
        overshootRight={false}
      >
        {cardContent}
      </ReanimatedSwipeable>
    </>
  );
});

const swipeStyles = StyleSheet.create({
  rightActionContainer: {
    width: RIGHT_ACTION_WIDTH,
    marginLeft: 8,
  },
  rightAction: {
    flex: 1,
    backgroundColor: colors.destructive,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightActionText: {
    fontSize: 12,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.white,
    marginTop: 4,
  },
});

const compactStyles = StyleSheet.create({
  // 블루 글래스 시안 07: 유리 카드 (반투명 흰 + 흰 보더) — 그림자 없음 (유리 표면 규칙)
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 11,
    ...shadows.card,
  },
  thumbnail: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.divider,
  },
  thumbnailFallback: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailFallbackText: {
    fontSize: 18,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.primary,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.28, // -0.02em
  },
  domainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  domain: {
    flex: 1,
    fontSize: 11.5,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
  },
  memo: {
    fontSize: 12,
    color: colors.primary,
    fontFamily: 'LINESeedKR',
    marginTop: 1,
  },
});

const styles = StyleSheet.create({
  // 그림자와 클리핑 공존: overflow hidden 은 iOS 그림자를 죽이므로
  // 카드에는 그림자만 두고, 썸네일에 상단 radius 를 직접 지정한다.
  card: {
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 18,
    ...shadows.glassCard,
  },
  thumbnail: {
    width: '100%',
    height: 110,
    borderTopLeftRadius: 17,
    borderTopRightRadius: 17,
    backgroundColor: colors.divider,
  },
  thumbnailFallback: {
    width: '100%',
    height: 110,
    borderTopLeftRadius: 17,
    borderTopRightRadius: 17,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 시안 07: 썸네일 위 도메인 배지 — 유리 칩 + 대문자
  domainBadge: {
    position: 'absolute',
    bottom: 8,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: '70%',
  },
  domainBadgeText: {
    fontSize: 11,
    fontFamily: 'LINESeedKR-Bold',
    letterSpacing: 0.6,
    color: colors.textMuted,
  },
  thumbnailFallbackTile: {
    width: 48,
    height: 48,
    borderRadius: 13,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#141E37',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 3,
  },
  thumbnailFallbackText: {
    fontSize: 22,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.primary,
  },
  body: {
    paddingVertical: 11,
    paddingHorizontal: 13,
    gap: 5,
  },
  title: {
    fontSize: 14,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.28, // -0.02em
    lineHeight: 20,
  },
  description: {
    fontSize: 12.5,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
    lineHeight: 18,
  },
  domainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  domain: {
    flexShrink: 1,
    fontSize: 12,
    fontFamily: 'LINESeedKR',
    color: colors.textDisabled,
  },
  // 시안 07: 💬 인용 박스 — 파란 좌측 보더 + 연한 파랑 배경
  memo: {
    backgroundColor: 'rgba(139,126,242,0.1)',
    borderLeftWidth: 2,
    borderLeftColor: colors.primary,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginTop: 4,
  },
  memoText: {
    fontSize: 12,
    color: colors.textSub,
    lineHeight: 17,
    fontFamily: 'LINESeedKR',
  },
  addedByRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(20,30,55,0.06)',
  },
  addedByText: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
  },
});

// B-5: FlatList 리렌더 최소화를 위해 memo 적용. props 가 같으면 재렌더 스킵.
// forwardRef + memo 조합으로 ref 도 정상 전달된다.
export default React.memo(LinkPreviewCard);
