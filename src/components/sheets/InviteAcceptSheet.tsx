import React from 'react';

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, moods, resolveMoodKey } from '../../constants/theme';
import { useGroup } from '../../contexts/GroupContext';
import { useInvitePreviewQuery, useJoinGroup } from '../../hooks/queries/useGroups';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import { PencilIcon, UsersIcon } from '../icons';
import MoodWash from '../MoodWash';
import { useToast } from '../Toast';

/**
 * 초대 수락 시트 — 시안 ④ (딥링크 진입).
 * 미리보기(그룹 이모지·이름·멤버 수·권한 안내) + 참여하기.
 * 예외 2종: 만료/무효 · 이미 참여 중.
 */

interface InviteAcceptSheetProps {
  token: string | null;
  onClose: () => void;
}

export default function InviteAcceptSheet({ token, onClose }: InviteAcceptSheetProps) {
  const { showToast } = useToast();
  const { selectGroup, refetchGroups } = useGroup();
  const { data: preview, isLoading } = useInvitePreviewQuery(token);
  const joinGroup = useJoinGroup();

  const handleJoin = () => {
    if (!token) return;
    joinGroup.mutate(token, {
      onSuccess: (result) => {
        refetchGroups();
        selectGroup(result.group_id);
        showToast('success', result.already_member ? '이미 참여 중인 그룹이에요' : '그룹에 참여했어요');
        onClose();
      },
      onError: () => {
        showToast('error', '초대가 만료되었거나 사용할 수 없어요');
        onClose();
      },
    });
  };

  const valid = preview?.valid === true;
  const isEditor = preview?.role !== 'viewer';
  // 아직 그룹에 속하지 않은 사용자가 보는 시트라 useCurrentMood 를 쓸 수 없다 →
  // 초대 프리뷰가 알려준 그룹 색으로 무드를 해석 (미지값/누락은 sunset 폴백).
  const m = moods[resolveMoodKey(preview?.group_color)];

  return (
    <BottomSheet visible={!!token} onClose={onClose} title="그룹 초대">
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : !valid ? (
        /* 만료/무효 상태 */
        <View style={styles.center}>
          <View style={styles.expiredTile}>
            <Text style={styles.expiredEmoji}>⏰</Text>
          </View>
          <Text style={styles.expiredTitle}>초대가 만료됐어요</Text>
          <Text style={styles.expiredDesc}>초대한 친구에게 새 링크를 요청해보세요</Text>
          <Button variant="secondary" onPress={onClose} style={styles.fullBtn}>
            확인
          </Button>
        </View>
      ) : (
        <View style={styles.center}>
          <View style={[styles.groupTile, { backgroundColor: m.tile, shadowColor: m.accent }]}>
            <MoodWash colors={[m.stops[0], m.stops[2]]} />
          </View>
          <Text style={styles.groupName}>{preview?.group_name}</Text>
          <View style={styles.metaRow}>
            <UsersIcon size={14} color={colors.textFaint} />
            <Text style={styles.metaText}>멤버 {preview?.member_count ?? 1}명</Text>
          </View>

          <View style={styles.roleBox}>
            <PencilIcon size={15} color={colors.primary} />
            <Text style={styles.roleText}>
              {isEditor ? '함께 편집할 수 있어요' : '링크를 구경할 수 있어요'}
            </Text>
          </View>

          <Button onPress={handleJoin} loading={joinGroup.isPending} style={styles.fullBtn} size="large">
            참여하기
          </Button>
          <Button variant="ghost" onPress={onClose} style={styles.fullBtn}>
            나중에
          </Button>
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  // 그룹 아이덴티티 = 무드 → 이모지 대신 색유리 스와치 타일.
  // backgroundColor/shadowColor 는 사용처에서 해당 그룹 무드로 인라인 주입.
  groupTile: {
    width: 70,
    height: 70,
    borderRadius: 22,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 3,
  },
  groupName: {
    fontSize: 23,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.69, // -0.03em
    marginTop: 13,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
  },
  metaText: {
    fontSize: 13,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
  },
  roleBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'stretch',
    justifyContent: 'center',
    backgroundColor: colors.primaryTint,
    borderRadius: 12,
    paddingVertical: 11,
    marginTop: 16,
  },
  roleText: {
    fontSize: 12.5,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.primary,
  },
  fullBtn: {
    alignSelf: 'stretch',
    marginTop: 10,
  },
  expiredTile: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expiredEmoji: {
    fontSize: 30,
  },
  expiredTitle: {
    fontSize: 19,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    marginTop: 14,
  },
  expiredDesc: {
    fontSize: 13,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
    marginTop: 6,
    marginBottom: 10,
  },
});
