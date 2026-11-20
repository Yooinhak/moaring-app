import React, { useCallback, useMemo } from 'react';

import { SectionList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '../components/AvatarStack';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import FaviconBadge from '../components/FaviconBadge';
import GlassBackground from '../components/GlassBackground';
import Skeleton from '../components/Skeleton';
import { colors, glass, moods } from '../constants/theme';
import { useGroup } from '../contexts/GroupContext';
import { type ActivityFeedItem, useActivityFeedQuery } from '../hooks/queries';
import { useActivityUnread } from '../hooks/useActivityUnread';
import { MainStackParamList, TabParamList } from '../navigation/types';
import { getDomainInfo } from '../utils/domainInfo';
import { relativeTime } from '../utils/relativeTime';

/**
 * 활동 화면 — 공유 그룹 전용 전역 피드 (리텐션). 하단 [활동] 탭.
 * "○○님이 «폴더»에 링크 추가"를 날짜별로 묶어 최신순으로 보여준다.
 * 탭 포커스 시 모든 공유 그룹을 '읽음' 처리해 탭 배지·레일 점을 함께 끈다.
 */

// 탭 화면이지만 부모 스택의 FolderDetail 로 이동하므로 스택 nav 타입으로 단언한다.
type Nav = NativeStackNavigationProp<MainStackParamList>;
// 형제 탭(홈)으로 옮길 때는 탭 nav 타입으로 본다 — 같은 navigation 객체를 다른 각도로 보는 것.
type TabNav = BottomTabNavigationProp<TabParamList>;

function sectionTitle(iso: string | null): string {
  if (!iso) return '기타';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '기타';
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (dayDiff <= 0) return '오늘';
  if (dayDiff === 1) return '어제';
  if (dayDiff < 7) return '이번 주';
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function domainOf(url: string): string {
  const label = getDomainInfo(url)?.label;
  if (label) return label;
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

/**
 * 피드 한 행. 제목은 서버가 저장 시점에 수집해 둔 posts.preview_title 을 그대로 쓴다 —
 * 행마다 기기에서 메타를 긁던 시절(Microlink 5회/일 → 429) 과 달리 네트워크 호출이 없고,
 * 아직 수집 전이거나 실패한 글은 도메인 라벨로 멀쩡히 보인다.
 */
function ActivityRow({ item, onPress }: { item: ActivityFeedItem; onPress: () => void }) {
  const name = item.displayName ?? '멤버';
  const domain = domainOf(item.url);

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={`${name}님이 ${item.folderName}에 추가한 링크 열기`}
    >
      <Avatar
        member={{ userId: item.userId ?? '', displayName: item.displayName, avatarUrl: item.avatarUrl }}
        size={36}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowText}>
          <Text style={styles.rowName}>{name}</Text>
          {`님이 ${item.folderName}에 추가 · `}
          <Text style={styles.rowTime}>{relativeTime(item.createdAt)}</Text>
        </Text>
        <View style={styles.linkCard}>
          <FaviconBadge url={item.url} size={16} />
          <View style={styles.linkBody}>
            <Text style={styles.linkTitle} numberOfLines={1}>
              {item.previewTitle || domain}
            </Text>
            <Text style={styles.linkDomain} numberOfLines={1}>
              {domain}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

/** 활동 항목 로딩 플레이스홀더 — 실제 행과 같은 모양(§3 progressive-loading). */
function ActivityRowSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={36} height={36} borderRadius={18} />
      <View style={styles.rowBody}>
        <Skeleton width="70%" height={13} borderRadius={6} />
        <View style={styles.linkCard}>
          <Skeleton width={16} height={16} borderRadius={5} />
          <View style={styles.linkBody}>
            <Skeleton width="80%" height={12} borderRadius={6} />
            <Skeleton width="45%" height={10} borderRadius={5} style={styles.skelGap} />
          </View>
        </View>
      </View>
    </View>
  );
}

export default function ActivityScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { selectGroup, groups } = useGroup();
  const { data: feed, isLoading } = useActivityFeedQuery(true);
  const { markAllSeen, markGroupSeen } = useActivityUnread();

  // 활동 피드는 공유 그룹 전용 — 그룹이 하나도 없으면 "새 소식 없음"이 아니라 "만들 게 있음"이다
  const hasSharedGroup = groups.some((g) => g.type === 'shared');
  const goHome = useCallback(() => {
    (navigation as unknown as TabNav).navigate('Home');
  }, [navigation]);

  // 탭이 포커스될 때마다(그리고 활동 데이터가 로드되면) 모두 읽음
  useFocusEffect(
    useCallback(() => {
      markAllSeen();
    }, [markAllSeen]),
  );

  const sections = useMemo(() => {
    const out: { title: string; data: ActivityFeedItem[] }[] = [];
    let cur: { title: string; data: ActivityFeedItem[] } | null = null;
    for (const it of feed ?? []) {
      const t = sectionTitle(it.createdAt);
      if (!cur || cur.title !== t) {
        cur = { title: t, data: [] };
        out.push(cur);
      }
      cur.data.push(it);
    }
    return out;
  }, [feed]);

  const handleOpen = useCallback(
    (item: ActivityFeedItem) => {
      selectGroup(item.groupId); // 폴더 상세의 컨텍스트(권한/브레드크럼)를 그 그룹으로 맞춤
      markGroupSeen(item.groupId);
      navigation.navigate('FolderDetail', {
        folderId: String(item.folderId),
        folderName: item.folderName,
        folderColor: item.folderColor ?? undefined,
        folderEmoji: item.folderEmoji ?? undefined,
      });
    },
    [navigation, selectGroup, markGroupSeen],
  );

  return (
    <View style={styles.container}>
      <GlassBackground variant="group" />

      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          활동
        </Text>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <ActivityRow item={item} onPress={() => handleOpen(item)} />}
        renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
        contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          isLoading ? (
            <View accessible accessibilityLabel="불러오는 중">
              {[0, 1, 2, 3, 4].map((i) => (
                <ActivityRowSkeleton key={i} />
              ))}
            </View>
          ) : (
            <EmptyState
              type="link"
              title={hasSharedGroup ? '아직 새 소식이 없어요' : '함께 모을 친구가 없어요'}
              subtitle={
                hasSharedGroup
                  ? '친구가 링크를 담으면\n여기에 모여요'
                  : '그룹을 만들어 친구를 초대하면\n서로 담은 링크가 여기 모여요'
              }
            >
              {/* 그룹이 없으면 이 화면은 막다른 길 — 그룹을 만들 수 있는 홈으로 보낸다.
                  (활동 화면이 그룹 생성 시트 상태를 따로 들 이유가 없다) */}
              {!hasSharedGroup && (
                <Button size="small" onPress={goHome}>
                  그룹 만들기
                </Button>
              )}
            </EmptyState>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F9FE' },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.6,
  },
  list: { paddingHorizontal: 20, paddingTop: 8 },
  sectionHeader: {
    fontSize: 11,
    fontFamily: 'LINESeedKR-Bold',
    letterSpacing: 0.6,
    // 전 그룹 통합 피드 — 특정 그룹 무드가 없어 중립 웜(sunset) 유지
    color: moods.sunset.metaText,
    marginTop: 16,
    marginBottom: 2,
  },
  row: {
    flexDirection: 'row',
    gap: 11,
    paddingVertical: 11,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowText: {
    fontSize: 13.5,
    fontFamily: 'LINESeedKR',
    color: colors.textSub,
    lineHeight: 20,
  },
  rowName: { fontFamily: 'LINESeedKR-Bold', color: colors.ink },
  rowTime: { color: colors.textFaint },
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 8,
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  linkBody: { flex: 1, minWidth: 0 },
  linkTitle: { fontSize: 13, fontFamily: 'LINESeedKR-Bold', color: colors.ink },
  linkDomain: { fontSize: 11, fontFamily: 'LINESeedKR', color: colors.textFaint, marginTop: 1 },
  skelGap: { marginTop: 6 },
});
