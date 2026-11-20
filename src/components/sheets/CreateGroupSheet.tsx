import React, { useEffect, useRef, useState } from 'react';

import { StyleSheet, Text, View } from 'react-native';

import { suggestMood } from '../../constants/moodData';
import { colors, MoodKey, resolveMoodKey, typo } from '../../constants/theme';
import { useGroup } from '../../contexts/GroupContext';
import { useCreateGroup } from '../../hooks/queries/useGroups';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import { UsersIcon } from '../icons';
import Input from '../Input';
import MoodSwatchRow from '../MoodSwatchRow';
import { useToast } from '../Toast';

/**
 * 새 그룹 만들기 시트 — 무드 아이덴티티.
 * 이름 타이핑 → 무드 자동 추천(수동 개입 시 중단). 결정은 이름 하나면 충분하다.
 * 이모지 프리셋·직접입력은 폐지(설계: group-mood-air.design.md §3).
 */

interface CreateGroupSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 생성 성공 시 (초대 시트 자동 연결용) */
  onCreated: (group: { id: string; name: string }) => void;
}

export default function CreateGroupSheet({ visible, onClose, onCreated }: CreateGroupSheetProps) {
  const { showToast } = useToast();
  const { groups, selectGroup, refetchGroups } = useGroup();
  const createGroup = useCreateGroup();

  const [name, setName] = useState('');
  const [mood, setMood] = useState<MoodKey>('sunset');
  const [suggested, setSuggested] = useState<MoodKey | null>(null);
  const touchedRef = useRef(false);

  // 이름 → 무드 자동 추천 (250ms 디바운스, 수동 개입 시 중단 — FolderIdentityPicker 계약)
  useEffect(() => {
    if (touchedRef.current) return;
    const timer = setTimeout(() => {
      // 디바운스 대기 중 스와치를 탭했으면 예약된 추천은 버린다(수동 선택 우선).
      if (touchedRef.current) return;
      const used = groups.filter((g) => g.type === 'shared').map((g) => resolveMoodKey(g.color));
      const s = suggestMood(name, used);
      setSuggested(s);
      if (s) setMood(s);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const reset = () => {
    setName('');
    setMood('sunset');
    setSuggested(null);
    touchedRef.current = false;
  };

  // 닫을 때도 초기화한다 — 안 그러면 touchedRef 가 true 로 남아 다음 세션의 자동 추천이 죽는다.
  const handleClose = () => {
    reset();
    onClose();
  };

  const handlePickMood = (key: MoodKey) => {
    touchedRef.current = true;
    setSuggested(null);
    setMood(key);
  };

  const handleCreate = () => {
    if (!name.trim()) {
      showToast('error', '그룹 이름을 입력해주세요');
      return;
    }
    createGroup.mutate(
      { name: name.trim(), color: mood },
      {
        onSuccess: (group) => {
          showToast('success', '그룹이 만들어졌어요');
          refetchGroups();
          selectGroup(group.id);
          reset();
          onClose();
          onCreated({ id: group.id, name: group.name });
        },
      },
    );
  };


  return (
    <BottomSheet
      visible={visible}
      onClose={handleClose}
      title="새 그룹 만들기"
      description="친구와 함께 링크를 모을 공간이에요"
    >
      <Text style={styles.capsLabel}>NAME</Text>
      <Input placeholder="그룹 이름 (예: 제주 여행)" value={name} onChangeText={setName} maxLength={30} />

      <Text style={styles.capsLabel}>무드</Text>
      <MoodSwatchRow value={mood} onChange={handlePickMood} suggested={suggested} />

      <View style={styles.infoBox}>
        <UsersIcon size={15} color={colors.primary} />
        <Text style={styles.infoText}>만들면 바로 친구를 초대할 수 있어요</Text>
      </View>

      <View style={styles.btns}>
        <Button variant="secondary" onPress={handleClose} style={{ flex: 1 }}>
          닫기
        </Button>
        <Button onPress={handleCreate} loading={createGroup.isPending} style={{ flex: 1.4 }}>
          만들기
        </Button>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  capsLabel: { ...typo.sectionLabel, marginTop: 18, marginBottom: 9 },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.primaryTint,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginTop: 16,
  },
  infoText: { fontSize: 12, fontFamily: 'LINESeedKR', color: colors.primary },
  btns: { flexDirection: 'row', gap: 10, marginTop: 20, marginBottom: 8 },
});
