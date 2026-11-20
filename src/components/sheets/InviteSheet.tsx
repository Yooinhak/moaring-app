import React, { useEffect, useState } from 'react';

import { Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, moods, typo } from '../../constants/theme';
import { GroupRole, useActiveInviteQuery, useCreateInvite } from '../../hooks/queries/useGroups';
import { useCurrentMood } from '../../hooks/useCurrentMood';
import { copyToClipboard, isClipboardAvailable } from '../../utils/clipboard';
import { lightTap } from '../../utils/haptics';
import { buildInviteMessage, buildInviteUrl } from '../../utils/inviteLink';
import BottomSheet from '../BottomSheet';
import { LinkIcon, Share2Icon } from '../icons';
import MoodWash from '../MoodWash';
import { useToast } from '../Toast';

/**
 * 친구 초대 시트 — 블루 글래스 시안 04 (생성 직후 자동 연결).
 * 이모지 타일 헤더 + ROLE 라디오 카드(함께 편집=기본 / 보기만 가능) +
 * 초대 링크 복사(파랑) + 카카오톡·메시지 공유(옐로) + "7일/10명" 힌트.
 */

interface InviteSheetProps {
  visible: boolean;
  onClose: () => void;
  groupId: string | null;
  groupName: string;
}

type InviteRole = Exclude<GroupRole, 'owner'>;

const ROLE_OPTIONS: { key: InviteRole; label: string; desc: string }[] = [
  { key: 'editor', label: '함께 편집', desc: '폴더·링크를 추가하고 수정할 수 있어요' },
  { key: 'viewer', label: '보기만 가능', desc: '저장된 링크를 볼 수만 있어요' },
];

export default function InviteSheet({ visible, onClose, groupId, groupName }: InviteSheetProps) {
  // 초대는 공유 그룹에서만 열린다 (생성 직후에는 아직 현재 그룹이 아닐 수 있어 sunset 폴백)
  const mood = useCurrentMood() ?? moods.sunset;
  const { showToast } = useToast();
  const [role, setRole] = useState<InviteRole>('editor');

  const { data: activeInvite, isLoading } = useActiveInviteQuery(visible ? groupId : null);
  const createInvite = useCreateInvite(groupId ?? '');

  // 유효한 초대가 없거나 역할이 다르면 새로 발급 (기존 링크는 무효화)
  useEffect(() => {
    if (!visible || !groupId || isLoading || createInvite.isPending) return;
    if (activeInvite && activeInvite.role === role) return;
    createInvite.mutate({ role, revokeExisting: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, groupId, isLoading, activeInvite?.role, role]);

  const token = activeInvite?.role === role ? activeInvite?.token : null;

  const handleCopy = async () => {
    if (!token) return;
    lightTap();
    if (isClipboardAvailable) {
      const ok = await copyToClipboard(buildInviteUrl(token));
      if (ok) {
        showToast('success', '링크가 복사되었어요');
        return;
      }
    }
    // 클립보드 모듈 미설치 폴백 → 시스템 공유 시트
    Share.share({ message: buildInviteMessage(groupName, token) });
  };

  const handleShare = () => {
    if (!token) return;
    lightTap();
    Share.share({ message: buildInviteMessage(groupName, token) });
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {/* 헤더: 이모지 타일 + 타이틀 (시안 04) */}
      <View style={styles.headerRow}>
        {/* 그룹 타일 = 그 그룹의 공기 (이모지 폐지) */}
        <View style={[styles.moodTile, { shadowColor: mood.accent }]}>
          <MoodWash colors={[mood.stops[0], mood.stops[2]]} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>친구를 초대해보세요</Text>
          <Text style={styles.desc} numberOfLines={1}>{`'${groupName}' 그룹에 함께해요`}</Text>
        </View>
      </View>

      {/* ROLE 라디오 카드 */}
      <Text style={styles.capsLabel}>ROLE</Text>
      <View style={styles.roleList}>
        {ROLE_OPTIONS.map((opt) => {
          const active = role === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.roleCard, active && styles.roleCardActive]}
              onPress={() => {
                lightTap();
                setRole(opt.key);
              }}
              activeOpacity={0.75}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
            >
              <View style={[styles.radio, active && styles.radioActive]} />
              <View style={styles.roleBody}>
                <Text style={[styles.roleLabel, !active && { color: colors.textSub }]}>{opt.label}</Text>
                <Text style={[styles.roleDesc, !active && { color: colors.textDisabled }]}>{opt.desc}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* 초대 링크 복사 */}
      <TouchableOpacity
        style={[styles.copyBtn, !token && { opacity: 0.4 }]}
        onPress={handleCopy}
        disabled={!token}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="초대 링크 복사"
      >
        <LinkIcon size={16} color={colors.white} strokeWidth={2.2} />
        <Text style={styles.copyText}>{token ? '초대 링크 복사' : '링크 만드는 중...'}</Text>
      </TouchableOpacity>

      {/* 카카오톡/메시지 공유 */}
      <TouchableOpacity
        style={[styles.shareBtn, !token && { opacity: 0.4 }]}
        onPress={handleShare}
        disabled={!token}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="초대 링크 공유"
      >
        <Share2Icon size={16} color={colors.kakaoText} strokeWidth={2.2} />
        <Text style={styles.shareText}>카카오톡·메시지로 공유</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>초대 링크는 7일 동안, 최대 10명까지 쓸 수 있어요</Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 4,
  },
  // backgroundColor/shadowColor 는 사용처에서 현재 무드로 인라인 주입
  moodTile: {
    width: 50,
    height: 50,
    borderRadius: 16,
    overflow: 'hidden', // MoodWash(absoluteFill) 클리핑
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 2,
  },
  headerText: { flex: 1, minWidth: 0, gap: 2 },
  title: {
    fontSize: 20,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.6, // -0.03em
  },
  desc: {
    fontSize: 13,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
  },
  capsLabel: {
    ...typo.sectionLabel,
    marginTop: 20,
    marginBottom: 9,
  },
  roleList: {
    gap: 8,
  },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: colors.fieldBg,
    borderRadius: 16,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  roleCardActive: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.iconFaint,
    backgroundColor: colors.white,
  },
  radioActive: {
    borderWidth: 6,
    borderColor: colors.primary,
  },
  roleBody: { flex: 1, gap: 1 },
  roleLabel: {
    fontSize: 14,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
  },
  roleDesc: {
    fontSize: 12,
    fontFamily: 'LINESeedKR',
    color: colors.textMuted,
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.primary,
    marginTop: 18,
    shadowColor: '#8B7EF2',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 5,
  },
  copyText: {
    fontSize: 15,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.white,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.kakao,
    marginTop: 8,
  },
  shareText: {
    fontSize: 15,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.kakaoText,
  },
  hint: {
    textAlign: 'center',
    fontSize: 12,
    fontFamily: 'LINESeedKR',
    color: colors.textDisabled,
    marginTop: 12,
    marginBottom: 4,
  },
});
