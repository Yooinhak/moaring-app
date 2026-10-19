import React, { useState } from 'react';

import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AlertDialog from '../components/AlertDialog';
import BottomSheet from '../components/BottomSheet';
import Button from '../components/Button';
import GlassBackground from '../components/GlassBackground';
import {
  ChevronRightIcon,
  FileTextIcon,
  LogOutIcon,
  ShieldIcon,
  TrashIcon,
} from '../components/icons';
import Input from '../components/Input';
import Skeleton from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { colors, glass, shadows } from '../constants/theme';
import { EXTERNAL_URLS } from '../constants/urls';
import { useGroup } from '../contexts/GroupContext';
import { normalizeAvatarUrl } from '../utils/avatarUrl';
import { queryKeys } from '../utils/react-query/queryKeys';
import { supabase } from '../utils/supabase/client';

/**
 * 프로필 — 블루 글래스 시안 11.
 * 유리 프로필 카드 + 통계(전체 링크/그룹) + 유리 메뉴 카드 + 버전.
 */

// 계정 삭제를 최종 확정시키기 위해 사용자가 반드시 타이핑해야 하는 문구.
const DELETE_CONFIRMATION_TEXT = '삭제';

/**
 * 내 프로필 아바타 — http→https 정규화 + 로드 실패 시 이메일 첫 글자 폴백.
 * (카카오 http 아바타는 릴리즈 APK 에서 차단되므로 폴백이 없으면 회색 원이 남았다.)
 */
function ProfileAvatar({ avatarUrl, email }: { avatarUrl?: string | null; email?: string | null }) {
  const uri = normalizeAvatarUrl(avatarUrl);
  const [failed, setFailed] = useState(false);
  const [loadedUri, setLoadedUri] = useState(uri);
  if (uri !== loadedUri) {
    setLoadedUri(uri);
    setFailed(false);
  }

  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={styles.avatar}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={200}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View style={styles.avatarFallback}>
      <Text style={styles.avatarLetter}>{email?.charAt(0).toUpperCase() ?? '?'}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { groups } = useGroup();
  const [logoutVisible, setLogoutVisible] = useState(false);
  const [deleteSheetVisible, setDeleteSheetVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const { data: user, isLoading } = useQuery({
    queryKey: [queryKeys.USER_PROFILE],
    queryFn: async () => await supabase.auth.getUser(),
    select: (data) => data.data.user,
  });

  // 시안 11 통계: 내가 볼 수 있는 전체 링크 수 (RLS 기준, count 만 조회)
  const { data: totalLinks } = useQuery({
    queryKey: ['profile-total-links'],
    queryFn: async () => {
      const { count } = await supabase.from('posts').select('id', { count: 'exact', head: true });
      return count ?? 0;
    },
  });

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      showToast('error', '로그아웃에 실패했어요');
    }
  };

  const openDeleteSheet = () => {
    setDeleteConfirmText('');
    setDeleteSheetVisible(true);
  };

  const closeDeleteSheet = () => {
    if (isDeleting) return;
    setDeleteSheetVisible(false);
    setDeleteConfirmText('');
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText.trim() !== DELETE_CONFIRMATION_TEXT) return;
    setIsDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke<{
        success: boolean;
        step?: string;
        error?: string;
      }>('delete-account', { method: 'POST' });

      if (error || !data?.success) {
        const message = data?.error ?? error?.message ?? '계정 삭제에 실패했어요';
        showToast('error', message);
        setIsDeleting(false);
        return;
      }

      // 성공: 서버에서 auth.users가 제거되어 현재 JWT는 무효 상태.
      await supabase.auth.signOut();
      setDeleteSheetVisible(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : '계정 삭제에 실패했어요';
      showToast('error', message);
      setIsDeleting(false);
    }
  };

  const canDelete = deleteConfirmText.trim() === DELETE_CONFIRMATION_TEXT && !isDeleting;

  return (
    <View style={styles.container}>
      <GlassBackground variant="personal" />

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 16, paddingBottom: 130 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.headerTitle} accessibilityRole="header">
          내 정보
        </Text>

        {/* 프로필 카드 */}
        <View style={[styles.card, styles.profileCard]}>
          {isLoading ? (
            <Skeleton width={56} height={56} borderRadius={28} />
          ) : (
            <ProfileAvatar avatarUrl={user?.user_metadata?.avatar_url} email={user?.email} />
          )}
          <View style={styles.profileInfo}>
            {isLoading ? (
              <Skeleton width={160} height={18} />
            ) : (
              <>
                <Text style={styles.name} numberOfLines={1}>
                  {user?.user_metadata?.full_name ?? user?.email?.split('@')[0] ?? ''}
                </Text>
                <Text style={styles.email} numberOfLines={1}>
                  {user?.email ?? ''}
                </Text>
              </>
            )}
          </View>
        </View>

        {/* 통계 카드 */}
        <View style={styles.statsRow}>
          <View style={[styles.card, styles.statCard]}>
            <Text style={[styles.statNumber, { color: colors.primary }]}>{totalLinks ?? '–'}</Text>
            <Text style={styles.statLabel}>모은 링크</Text>
          </View>
          <View style={[styles.card, styles.statCard]}>
            <Text style={styles.statNumber}>{groups.filter((g) => g.type !== 'personal').length}</Text>
            <Text style={styles.statLabel}>그룹</Text>
          </View>
        </View>

        {/* 문서 메뉴 */}
        <View style={[styles.card, styles.menuCard]}>
          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => Linking.openURL(EXTERNAL_URLS.PRIVACY_POLICY)}
            activeOpacity={0.5}
            accessibilityRole="link"
            accessibilityLabel="개인정보 처리방침"
          >
            <ShieldIcon size={18} color={colors.textMuted} />
            <Text style={styles.menuLabel}>개인정보 처리방침</Text>
            <ChevronRightIcon size={15} color={colors.iconFaint} />
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => Linking.openURL(EXTERNAL_URLS.TERMS_OF_SERVICE)}
            activeOpacity={0.5}
            accessibilityRole="link"
            accessibilityLabel="이용약관"
          >
            <FileTextIcon size={18} color={colors.textMuted} />
            <Text style={styles.menuLabel}>이용약관</Text>
            <ChevronRightIcon size={15} color={colors.iconFaint} />
          </TouchableOpacity>
        </View>

        {/* 위험 메뉴 */}
        <View style={[styles.card, styles.menuCard]}>
          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => setLogoutVisible(true)}
            activeOpacity={0.5}
            accessibilityRole="button"
            accessibilityLabel="로그아웃"
          >
            <LogOutIcon size={18} color={colors.danger} />
            <Text style={[styles.menuLabel, { color: colors.danger }]}>로그아웃</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity
            style={styles.menuRow}
            onPress={openDeleteSheet}
            activeOpacity={0.5}
            accessibilityRole="button"
            accessibilityLabel="계정 삭제"
          >
            <TrashIcon size={18} color={colors.danger} />
            <Text style={[styles.menuLabel, { color: colors.danger }]}>계정 삭제</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footerText}>모아링 v0.0.6</Text>
      </ScrollView>

      <AlertDialog
        visible={logoutVisible}
        onClose={() => setLogoutVisible(false)}
        title="로그아웃 할까요?"
        description="다시 로그인하면 데이터는 그대로 유지돼요"
        confirmText="로그아웃"
        onConfirm={handleSignOut}
        destructive
      />

      <BottomSheet
        visible={deleteSheetVisible}
        onClose={closeDeleteSheet}
        title="계정을 삭제할까요?"
        description={`저장한 모든 폴더와 링크가 영구적으로 삭제되며, 복구할 수 없어요.\n계속하려면 아래에 "${DELETE_CONFIRMATION_TEXT}" 라고 입력해주세요.`}
      >
        <View style={styles.deleteBody}>
          <Input
            value={deleteConfirmText}
            onChangeText={setDeleteConfirmText}
            placeholder={DELETE_CONFIRMATION_TEXT}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isDeleting}
          />
          <View style={styles.deleteButtonRow}>
            <Button variant="secondary" onPress={closeDeleteSheet} disabled={isDeleting} style={{ flex: 1 }} accessibilityLabel="취소">
              취소
            </Button>
            <Button
              variant="danger"
              onPress={handleDeleteAccount}
              disabled={!canDelete}
              loading={isDeleting}
              style={{ flex: 1 }}
              accessibilityLabel="계정 삭제 확인"
            >
              계정 삭제
            </Button>
          </View>
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F9FE' },
  scroll: { paddingHorizontal: 22 },
  headerTitle: {
    fontSize: 26,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -1.04, // -0.04em
    paddingBottom: 16,
  },
  card: {
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    ...shadows.glassCard,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderRadius: 20,
    padding: 15,
  },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarFallback: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.primaryGlow,
  },
  avatarLetter: { fontSize: 23, fontFamily: 'LINESeedKR-Bold', color: colors.white },
  profileInfo: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 18, fontFamily: 'LINESeedKR-Bold', color: colors.ink, letterSpacing: -0.36 },
  email: { fontSize: 13, fontFamily: 'LINESeedKR', color: colors.textFaint },
  statsRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  statCard: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 1,
  },
  statNumber: {
    fontSize: 22,
    fontFamily: 'LINESeedKR-Bold',
    letterSpacing: 0.4, // Space Grotesk 근사
    color: colors.ink,
  },
  statLabel: { fontSize: 12, fontFamily: 'LINESeedKR', color: colors.textFaint },
  menuCard: {
    borderRadius: 18,
    marginTop: 12,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 15,
    paddingVertical: 14,
  },
  menuLabel: { flex: 1, fontSize: 15, fontFamily: 'LINESeedKR', color: colors.text },
  divider: { height: 1, backgroundColor: 'rgba(20,30,55,0.05)', marginLeft: 46 },
  footerText: {
    textAlign: 'center',
    fontSize: 12,
    fontFamily: 'LINESeedKR',
    color: '#A29BC4', // 라벤더 공기 위 푸터 (v3)
    marginTop: 22,
  },
  deleteBody: { paddingBottom: 16, gap: 20 },
  deleteButtonRow: { flexDirection: 'row', gap: 11 },
});
