import React, { useCallback, useState } from 'react';

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { suggestIdentity } from '../../constants/emojiData';
import { colors, FolderColorKey, moods, resolveMoodKey } from '../../constants/theme';
import type { GroupSummary } from '../../hooks/queries';
import { lightTap } from '../../utils/haptics';
import FolderIdentityPicker from '../FolderIdentityPicker';
import FolderTilePreview from '../FolderTilePreview';
import { HomeIcon, LockIcon } from '../icons';
import Input from '../Input';
import MoodWash from '../MoodWash';

/**
 * 저장 시트 안 「새 폴더」 화면 조각 (docs/02-design/features/share-new-folder.design.md).
 *
 * BottomSheet 슬롯이 셋(fixedTop / children / footer)으로 나뉘어 있어 하나의 폼 컴포넌트로
 * 감쌀 수 없다. 그래서 상태는 useNewFolderDraft 하나에 두고, 슬롯마다 조각을 끼운다:
 *  - fixedTop  → NewFolderNameRow (미리보기 타일 + 이름 입력)
 *  - children  → NewFolderOptions (그룹 칩 + 노출 안내 + 색/이모지 피커)
 *  - footer    → 호출부의 「만들고 바로 저장」 버튼
 *
 * 이름→이모지·색 자동 추천은 홈 화면 폴더 생성과 같은 규칙(사용자가 직접 바꾸면 추천 중단).
 */

export type NewFolderDraft = ReturnType<typeof useNewFolderDraft>;

export function useNewFolderDraft() {
  const [name, setNameRaw] = useState('');
  const [color, setColor] = useState<FolderColorKey>('blue');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [identityTouched, setIdentityTouched] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const setName = useCallback(
    (text: string) => {
      setNameRaw(text);
      if (!identityTouched) {
        const s = suggestIdentity(text);
        setColor(s.color);
        setEmoji(s.emoji);
      }
    },
    [identityTouched],
  );

  const setIdentity = useCallback((next: { color: FolderColorKey; emoji: string | null }) => {
    setColor(next.color);
    setEmoji(next.emoji);
  }, []);

  /** 새 폴더 화면에 들어올 때마다 빈 입력 + 기본 그룹으로 초기화 */
  const reset = useCallback((defaultGroupId: string | null) => {
    setNameRaw('');
    setColor('blue');
    setEmoji(null);
    setGroupId(defaultGroupId);
    setIdentityTouched(false);
    setSearchOpen(false);
  }, []);

  return {
    name,
    color,
    emoji,
    groupId,
    searchOpen,
    setName,
    setIdentity,
    setGroupId,
    setSearchOpen,
    markIdentityTouched: () => setIdentityTouched(true),
    reset,
  };
}

/** 상단 고정: 완성 모습 미리보기 타일(탭 = 이모지 검색 토글) + 이름 입력 */
export function NewFolderNameRow({ draft, onSubmit }: { draft: NewFolderDraft; onSubmit: () => void }) {
  return (
    <View style={styles.nameRow}>
      <FolderTilePreview
        color={draft.color}
        emoji={draft.emoji}
        active={draft.searchOpen}
        onPress={() => draft.setSearchOpen(!draft.searchOpen)}
      />
      <View style={styles.nameInput}>
        <Input
          placeholder="폴더 이름을 입력해주세요"
          value={draft.name}
          onChangeText={draft.setName}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={onSubmit}
          accessibilityLabel="새 폴더 이름"
        />
      </View>
    </View>
  );
}

/** 본문: 어느 그룹에 만들지 + 공유 그룹 노출 안내 + 색/이모지 */
export function NewFolderOptions({
  draft,
  groups,
  onLockedGroup,
}: {
  draft: NewFolderDraft;
  /** GroupContext 의 그룹 전체 (폴더 0개 그룹 포함, 개인 그룹 먼저) */
  groups: GroupSummary[];
  /** 보기 전용 그룹 칩을 눌렀을 때 */
  onLockedGroup: () => void;
}) {
  const selected = groups.find((g) => g.id === draft.groupId) ?? null;

  return (
    <View>
      <View style={styles.section}>
        <Text style={styles.label}>어느 그룹에 만들까요?</Text>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {groups.map((g) => {
            const locked = g.role === 'viewer';
            const on = g.id === draft.groupId;
            const label = g.type === 'personal' ? '나의 서랍' : g.name;
            const mood = moods[resolveMoodKey(g.color)];
            return (
              <TouchableOpacity
                key={g.id}
                style={[styles.chip, on && styles.chipOn, locked && styles.chipLocked]}
                onPress={() => {
                  if (locked) {
                    onLockedGroup();
                    return;
                  }
                  lightTap();
                  draft.setGroupId(g.id);
                }}
                activeOpacity={0.7}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled: locked }}
                accessibilityLabel={locked ? `${label} — 보기 전용이라 만들 수 없어요` : label}
              >
                {locked ? (
                  <LockIcon size={12} color={colors.textDisabled} />
                ) : g.type === 'personal' ? (
                  <HomeIcon size={12} color={on ? colors.primaryDeep : colors.textFaint} strokeWidth={2.2} />
                ) : (
                  // 그룹은 저장 위치 목록과 같은 무드 세로 바로 식별
                  <View style={styles.moodBar}>
                    <MoodWash colors={[mood.illust.pastel, mood.accent]} />
                  </View>
                )}
                <Text
                  style={[styles.chipText, on && styles.chipTextOn, locked && styles.chipTextLocked]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {selected?.type === 'shared' && (
          <Text style={styles.notice}>
            {`「${selected.name}」 멤버 ${selected.memberCount}명이 함께 보는 폴더예요`}
          </Text>
        )}
      </View>

      <FolderIdentityPicker
        name={draft.name}
        color={draft.color}
        emoji={draft.emoji}
        onChange={draft.setIdentity}
        onManualChange={draft.markIdentityTouched}
        searchOpen={draft.searchOpen}
        onSearchOpenChange={draft.setSearchOpen}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  nameInput: { flex: 1 },
  // FolderIdentityPicker 의 섹션/라벨과 같은 리듬
  section: { marginTop: 4, gap: 11 },
  label: { fontSize: 13, fontFamily: 'LINESeedKR-Bold', color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    height: 36,
    paddingHorizontal: 13,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primaryTint },
  chipLocked: { borderStyle: 'dashed', backgroundColor: colors.fieldBg },
  chipText: { flexShrink: 1, fontSize: 13, fontFamily: 'LINESeedKR-Bold', color: colors.textMuted },
  chipTextOn: { color: colors.primaryDeep },
  chipTextLocked: { color: colors.textDisabled },
  moodBar: { width: 3, height: 14, borderRadius: 2, overflow: 'hidden' },
  notice: { fontSize: 12, fontFamily: 'LINESeedKR', color: colors.textFaint, lineHeight: 18, marginTop: -3 },
});
