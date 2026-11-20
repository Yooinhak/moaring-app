import React, { useState } from 'react';

import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AlertDialog from '../components/AlertDialog';
import { Avatar } from '../components/AvatarStack';
import BottomSheet from '../components/BottomSheet';
import Button from '../components/Button';
import GlassBackground from '../components/GlassBackground';
import { ChevronLeftIcon, PlusIcon, TrashIcon } from '../components/icons';
import Input from '../components/Input';
import MemberRow from '../components/MemberRow';
import MoodSwatchRow from '../components/MoodSwatchRow';
import InviteSheet from '../components/sheets/InviteSheet';
import { useToast } from '../components/Toast';
import { colors, glass, moods, resolveMoodKey, shadows, typo } from '../constants/theme';
import { useGroup } from '../contexts/GroupContext';
import {
  useActiveInviteQuery,
  useChangeMemberRole,
  useCreateInvite,
  useDeleteGroup,
  useGroupMembersQuery,
  useKickMember,
  useLeaveGroup,
  useUpdateGroup,
} from '../hooks/queries/useGroups';
import { useCurrentMood } from '../hooks/useCurrentMood';
import { MainStackParamList } from '../navigation/types';
import { copyToClipboard, isClipboardAvailable } from '../utils/clipboard';
import { lightTap } from '../utils/haptics';
import { buildInviteUrl } from '../utils/inviteLink';
import { supabase } from '../utils/supabase/client';

/**
 * 그룹 관리 — 블루 글래스 시안 08 (웜 공기, 풀스크린).
 * 유리 백 버튼 헤더 / 그룹 카드 / 초대 링크 박스 / MEMBERS 리스트 /
 * 친구 초대 / (owner) 링크 재설정·그룹 삭제 / (멤버) 나가기.
 */

type MemberManageRouteProp = RouteProp<MainStackParamList, 'MemberManage'>;
type Nav = NativeStackNavigationProp<MainStackParamList, 'MemberManage'>;

const DELETE_CONFIRMATION_TEXT = '삭제';

export default function MemberManageScreen() {
  // 이 화면은 항상 공유 그룹에서만 진입한다 (개인 공간엔 그룹 관리가 없음) → sunset 폴백은 방어용
  const mood = useCurrentMood() ?? moods.sunset;
  const route = useRoute<MemberManageRouteProp>();
  const navigation = useNavigation<Nav>();
  const { groupId } = route.params;
  const { showToast } = useToast();
  const insets = useSafeAreaInsets(); // Android edge-to-edge 하단 대응

  const { groups, selectGroup, refetchGroups } = useGroup();
  const group = groups.find((g) => g.id === groupId) ?? null;
  const isOwner = group?.role === 'owner';
  /** 관리 중인 그룹의 무드 — 스와치·타일이 같은 소스(group.color)를 본다 */
  const groupMood = moods[resolveMoodKey(group?.color)];

  const { data: members = [] } = useGroupMembersQuery(groupId);
  const changeRole = useChangeMemberRole(groupId);
  const kickMember = useKickMember(groupId);
  const createInvite = useCreateInvite(groupId);
  const deleteGroup = useDeleteGroup();
  const leaveGroup = useLeaveGroup();
  const updateGroup = useUpdateGroup();

  // 시안 08: 활성 초대 링크 박스 + 복사
  const { data: activeInvite } = useActiveInviteQuery(groupId);
  const inviteUrl = activeInvite ? buildInviteUrl(activeInvite.token) : null;

  const [myUserId, setMyUserId] = useState<string | null>(null);
  React.useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMyUserId(data.user?.id ?? null));
  }, []);

  const [inviteVisible, setInviteVisible] = useState(false);
  const [kickTarget, setKickTarget] = useState<string | null>(null);
  const [resetConfirmVisible, setResetConfirmVisible] = useState(false);
  const [leaveVisible, setLeaveVisible] = useState(false);
  const [deleteSheetVisible, setDeleteSheetVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const goHomeAfter = () => {
    refetchGroups();
    const personal = groups.find((g) => g.type === 'personal');
    if (personal) selectGroup(personal.id);
    navigation.goBack();
  };

  const handleResetInvite = () => {
    createInvite.mutate(
      { role: 'editor', revokeExisting: true },
      { onSuccess: () => showToast('success', '초대 링크가 재설정되었어요') },
    );
  };

  const handleCopyInvite = async () => {
    if (!inviteUrl) {
      setInviteVisible(true); // 활성 링크 없으면 초대 시트에서 발급
      return;
    }
    lightTap();
    if (isClipboardAvailable) {
      const ok = await copyToClipboard(inviteUrl);
      if (ok) {
        showToast('success', '링크가 복사되었어요');
        return;
      }
    }
    setInviteVisible(true);
  };

  const canDelete = deleteConfirmText.trim() === DELETE_CONFIRMATION_TEXT && !deleteGroup.isPending;

  return (
    <View style={styles.container}>
      <GlassBackground mood={mood.key} />

      {/* ── 커스텀 헤더 ── */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="뒤로 가기"
        >
          <ChevronLeftIcon size={17} color={colors.ink} strokeWidth={2.4} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} accessibilityRole="header">
          그룹 관리
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: 40 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        {/* 그룹 카드 — 이 화면에서 가장 궁금한 건 "누가 있나"라 얼굴을 먼저 보여준다 */}
        <View style={styles.groupCard}>
          {members.length > 0 && (
            <View style={styles.faceRow}>
              {members.slice(0, 4).map((m, i) => (
                <View key={m.userId} style={[styles.faceRing, i > 0 && styles.faceOverlap]}>
                  <Avatar member={m} size={30} />
                </View>
              ))}
            </View>
          )}
          <Text style={styles.groupName} numberOfLines={1}>
            {group?.name ?? '그룹'}
          </Text>
          <Text style={[styles.groupMeta, { color: groupMood.metaText }]}>멤버 {members.length}명</Text>
        </View>

        {/* 초대 링크 박스 (시안 08) */}
        <View style={styles.linkBox}>
          <Text style={styles.linkText} numberOfLines={1}>
            {inviteUrl ?? '아직 활성 초대 링크가 없어요'}
          </Text>
          <TouchableOpacity
            style={styles.copyBtn}
            onPress={handleCopyInvite}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="초대 링크 복사"
          >
            <Text style={styles.copyText}>{inviteUrl ? '복사' : '발급'}</Text>
          </TouchableOpacity>
        </View>

        {/* 무드 변경 — owner 전용. 저장하면 GROUP_LIST 무효화 → 레일 칩·배경이 따라 바뀐다 */}
        {isOwner && (
          <View style={styles.moodSection}>
            <Text style={[styles.capsLabel, styles.moodLabel, { color: mood.metaText }]}>무드</Text>
            <MoodSwatchRow
              value={resolveMoodKey(group?.color)}
              onChange={(key) => updateGroup.mutate({ id: groupId, color: key })}
            />
          </View>
        )}

        {/* 멤버 리스트 */}
        <Text style={[styles.capsLabel, { color: mood.metaText }]}>{`MEMBERS · ${members.length}`}</Text>
        <View style={styles.card}>
          {members.map((m, i) => (
            <View key={m.userId}>
              {i > 0 && <View style={styles.divider} />}
              <MemberRow
                member={m}
                isMe={m.userId === myUserId}
                canManage={isOwner && m.userId !== myUserId}
                onChangeRole={(userId, role) => changeRole.mutate({ userId, role })}
                onKick={(userId) => setKickTarget(userId)}
              />
            </View>
          ))}
        </View>

        {/* 친구 초대 */}
        <Button onPress={() => setInviteVisible(true)} style={styles.inviteBtn}>
          <PlusIcon size={16} color={colors.white} strokeWidth={2.4} />
          <Text style={styles.inviteBtnText}>친구 초대</Text>
        </Button>

        {/* 관리 섹션 */}
        <View style={styles.card}>
          {isOwner ? (
            <>
              <TouchableOpacity
                style={styles.menuRow}
                onPress={() => setResetConfirmVisible(true)}
                activeOpacity={0.5}
                accessibilityRole="button"
              >
                <Text style={styles.menuLabel}>초대 링크 재설정</Text>
              </TouchableOpacity>
              <View style={styles.divider} />
              <TouchableOpacity
                style={styles.menuRow}
                onPress={() => {
                  setDeleteConfirmText('');
                  setDeleteSheetVisible(true);
                }}
                activeOpacity={0.5}
                accessibilityRole="button"
              >
                <TrashIcon size={18} color={colors.danger} />
                <Text style={[styles.menuLabel, { color: colors.danger }]}>그룹 삭제</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => setLeaveVisible(true)}
              activeOpacity={0.5}
              accessibilityRole="button"
            >
              <Text style={[styles.menuLabel, { color: colors.danger }]}>그룹 나가기</Text>
            </TouchableOpacity>
          )}
        </View>
        {isOwner && (
          <Text style={styles.footNote}>{`삭제하려면 "${DELETE_CONFIRMATION_TEXT}" 입력 2단계 확인을 거쳐요`}</Text>
        )}
      </ScrollView>

      {/* 친구 초대 시트 */}
      <InviteSheet
        visible={inviteVisible}
        onClose={() => setInviteVisible(false)}
        groupId={groupId}
        groupName={group?.name ?? ''}
      />

      {/* 강퇴 확인 */}
      <AlertDialog
        visible={!!kickTarget}
        onClose={() => setKickTarget(null)}
        title="멤버를 내보낼까요?"
        description="내보낸 멤버는 초대 링크로 다시 참여할 수 있어요"
        confirmText="내보내기"
        onConfirm={() => {
          if (kickTarget) kickMember.mutate(kickTarget);
          setKickTarget(null);
        }}
        destructive
      />

      {/* 링크 재설정 확인 */}
      <AlertDialog
        visible={resetConfirmVisible}
        onClose={() => setResetConfirmVisible(false)}
        title="초대 링크를 재설정할까요?"
        description="기존에 공유한 링크는 더 이상 사용할 수 없어요"
        confirmText="재설정"
        onConfirm={handleResetInvite}
      />

      {/* 나가기 확인 */}
      <AlertDialog
        visible={leaveVisible}
        onClose={() => setLeaveVisible(false)}
        title="그룹에서 나갈까요?"
        description="다시 참여하려면 초대 링크가 필요해요"
        confirmText="나가기"
        onConfirm={() => {
          leaveGroup.mutate(groupId, { onSuccess: goHomeAfter });
        }}
        destructive
      />

      {/* 그룹 삭제 (2단계 확인) */}
      <BottomSheet
        visible={deleteSheetVisible}
        onClose={() => setDeleteSheetVisible(false)}
        title="그룹을 삭제할까요?"
        description={`그룹의 모든 폴더와 링크가 영구적으로 삭제되며, 복구할 수 없어요.\n계속하려면 아래에 "${DELETE_CONFIRMATION_TEXT}" 라고 입력해주세요.`}
      >
        <View style={styles.deleteBody}>
          <Input
            value={deleteConfirmText}
            onChangeText={setDeleteConfirmText}
            placeholder={DELETE_CONFIRMATION_TEXT}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.deleteBtns}>
            <Button variant="secondary" onPress={() => setDeleteSheetVisible(false)} style={{ flex: 1 }}>
              취소
            </Button>
            <Button
              variant="danger"
              disabled={!canDelete}
              loading={deleteGroup.isPending}
              onPress={() => {
                deleteGroup.mutate(groupId, {
                  onSuccess: () => {
                    setDeleteSheetVisible(false);
                    goHomeAfter();
                  },
                });
              }}
              style={{ flex: 1 }}
            >
              그룹 삭제
            </Button>
          </View>
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F9FE' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
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
  headerTitle: {
    fontSize: 20,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.6, // -0.03em
  },
  scroll: { paddingHorizontal: 20, paddingTop: 16 },
  groupCard: {
    alignItems: 'center',
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 13,
    ...shadows.warmCard,
  },
  faceRow: { flexDirection: 'row', marginBottom: 8 },
  faceRing: { borderRadius: 17, borderWidth: 2, borderColor: colors.white },
  faceOverlap: { marginLeft: -9 },
  groupName: { fontSize: 17, fontFamily: 'LINESeedKR-Bold', color: colors.ink, letterSpacing: -0.34 },
  // color 는 사용처에서 무드로 주입
  groupMeta: { fontSize: 12, fontFamily: 'LINESeedKR', marginTop: 3 },
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 48,
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 16,
    paddingLeft: 15,
    paddingRight: 7,
    marginTop: 12,
  },
  linkText: { flex: 1, fontSize: 13, fontFamily: 'LINESeedKR', color: colors.textSub },
  copyBtn: {
    backgroundColor: colors.primary,
    borderRadius: 11,
    height: 34,
    paddingHorizontal: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyText: { fontSize: 13, fontFamily: 'LINESeedKR-Bold', color: colors.white },
  // color 는 사용처에서 현재 무드로 인라인 주입 (StyleSheet 안에서는 훅을 쓸 수 없음)
  capsLabel: {
    ...typo.sectionLabel,
    marginTop: 18,
    marginBottom: 9,
    marginLeft: 2,
  },
  moodSection: { marginTop: 24, gap: 11 },
  // capsLabel 의 세로 여백은 moodSection 의 marginTop/gap 이 대신한다 (이중 여백 방지)
  moodLabel: { marginTop: 0, marginBottom: 0 },
  card: {
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
    borderRadius: 18,
    paddingHorizontal: 14,
    ...shadows.card,
  },
  divider: { height: 1, backgroundColor: 'rgba(20,30,55,0.05)', marginLeft: 51 },
  inviteBtn: { marginTop: 14, marginBottom: 18 },
  inviteBtnText: { fontSize: 14, fontFamily: 'LINESeedKR-Bold', color: colors.white },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 15,
  },
  menuLabel: { fontSize: 14, fontFamily: 'LINESeedKR', color: colors.text },
  footNote: {
    textAlign: 'center',
    fontSize: 11,
    fontFamily: 'LINESeedKR',
    color: '#B0A183',
    marginTop: 10,
  },
  deleteBody: { gap: 20, paddingBottom: 8 },
  deleteBtns: { flexDirection: 'row', gap: 11 },
});
