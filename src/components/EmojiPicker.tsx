import React, { useEffect, useMemo, useState } from 'react';

import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { BottomSheetTextInput, useBottomSheetInternal } from '@gorhom/bottom-sheet';

import { EMOJI_DATA } from '../constants/emojiData';
import { colors } from '../constants/theme';
import { lightTap } from '../utils/haptics';
import { appStorage } from '../utils/storage/appStorage';

import { CheckIcon, SearchIcon, XIcon } from './icons';

/**
 * 폴더/그룹 공용 이모지 피커 — 의존성 없는 인앱 큐레이션 그리드.
 * - 최근 사용(appStorage) + 추천 그리드 + 한글 검색 + "이모지 없음" + 직접 입력 fallback.
 * - 이모지는 선택 사항이므로 value=null 을 허용한다.
 * - EMOJI_DATA 는 constants/emojiData.ts 로 추출(자동추천 로직과 공유, 2026-07-15).
 */

const RECENT_EMOJI_KEY = 'moaring.recentEmojis';
const MAX_RECENT = 8;

interface EmojiPickerProps {
  /** 현재 선택된 이모지 (없으면 null). */
  value: string | null;
  /** 선택/해제 콜백. 해제 시 null. */
  onSelect: (emoji: string | null) => void;
  label?: string;
  /** 제공 시 라벨 우측에 "완료" 버튼을 그려 피커를 닫는다(접이식 사용 시). */
  onClose?: () => void;
}

/** 최근 사용 이모지 앞에 추가 (중복 제거, 최대 MAX_RECENT). */
export async function pushRecentEmoji(emoji: string) {
  try {
    const raw = await appStorage.getItem(RECENT_EMOJI_KEY);
    const prev: string[] = raw ? JSON.parse(raw) : [];
    const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, MAX_RECENT);
    await appStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next));
  } catch {
    // 무시 — 최근 목록은 부가 기능
  }
}

export default function EmojiPicker({ value, onSelect, label = '이모지 (선택)', onClose }: EmojiPickerProps) {
  const isInSheet = useBottomSheetInternal(true) != null;
  const InputComponent = isInSheet ? BottomSheetTextInput : TextInput;

  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    appStorage
      .getItem(RECENT_EMOJI_KEY)
      .then((raw) => {
        if (raw) setRecent(JSON.parse(raw));
      })
      .catch(() => {});
  }, []);

  // 추천은 2줄(14개)만 노출 — 나머지는 검색으로 (시트가 길어지는 것 방지, 2026-07-13 피드백)
  const RECOMMEND_COUNT = 14;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EMOJI_DATA.slice(0, RECOMMEND_COUNT);
    return EMOJI_DATA.filter(([emoji, kw]) => emoji === q || kw.toLowerCase().includes(q));
  }, [query]);

  const handlePick = (emoji: string) => {
    lightTap();
    // 이미 선택된 이모지를 다시 누르면 해제
    onSelect(value === emoji ? null : emoji);
  };

  // 직접 입력: 마지막 이모지 문자만 반영 (시스템 이모지 키보드 지원)
  const handleDirectInput = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onSelect(null);
      return;
    }
    onSelect([...trimmed].slice(-1).join(''));
  };

  const showRecentRow = recent.length > 0 && !query.trim();

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.labelActions}>
          {value ? (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => {
                lightTap();
                onSelect(null);
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="이모지 없음"
            >
              <XIcon size={12} color={colors.textMuted} strokeWidth={2.5} />
              <Text style={styles.clearText}>이모지 없음</Text>
            </TouchableOpacity>
          ) : null}
          {onClose ? (
            <TouchableOpacity
              style={styles.doneBtn}
              onPress={() => {
                lightTap();
                onClose();
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="이모지 선택 완료"
            >
              <Text style={styles.doneText}>완료</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* 검색 + 직접 입력 */}
      <View style={styles.searchWrap}>
        <SearchIcon size={16} color={colors.textFaint} />
        <InputComponent
          style={styles.searchInput}
          placeholder="검색하거나 직접 입력해보세요"
          placeholderTextColor={colors.textDisabled}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={(e) => {
            const t = e.nativeEvent.text.trim();
            // 이모지를 직접 붙여넣거나 입력한 경우 그대로 반영
            if (t && !EMOJI_DATA.some(([, kw]) => kw.toLowerCase().includes(t.toLowerCase()))) {
              handleDirectInput(t);
              setQuery('');
            }
          }}
          autoCorrect={false}
          returnKeyType="done"
        />
      </View>

      {/* 선택된 이모지 미리보기 */}
      {value ? (
        <View style={styles.previewRow}>
          <View style={styles.previewTile}>
            <Text style={styles.previewEmoji}>{value}</Text>
          </View>
          <Text style={styles.previewText}>선택됨</Text>
        </View>
      ) : null}

      {/* 최근 사용 */}
      {showRecentRow ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>최근 사용</Text>
          <View style={styles.grid}>
            {recent.map((emoji) => (
              <EmojiCell key={`recent-${emoji}`} emoji={emoji} selected={value === emoji} onPress={() => handlePick(emoji)} />
            ))}
          </View>
        </View>
      ) : null}

      {/* 추천/검색 결과 */}
      <View style={styles.section}>
        {!query.trim() ? <Text style={styles.sectionLabel}>추천</Text> : null}
        {filtered.length > 0 ? (
          <View style={styles.grid}>
            {filtered.map(([emoji]) => (
              <EmojiCell key={emoji} emoji={emoji} selected={value === emoji} onPress={() => handlePick(emoji)} />
            ))}
          </View>
        ) : (
          <View style={styles.noResult}>
            <Text style={styles.noResultText}>검색 결과가 없어요. 위 칸에 이모지를 직접 입력해보세요.</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function EmojiCell({ emoji, selected, onPress }: { emoji: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.cell, selected && styles.cellSelected]}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${emoji} 이모지`}
    >
      <Text style={styles.cellEmoji}>{emoji}</Text>
      {selected ? (
        <View style={styles.cellCheck}>
          <CheckIcon size={10} color={colors.white} strokeWidth={3} />
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 20, gap: 10 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  labelActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontSize: 13, fontFamily: 'LINESeedKR-Bold', color: colors.textMuted },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 2, paddingHorizontal: 6 },
  clearText: { fontSize: 12, fontFamily: 'LINESeedKR-Bold', color: colors.textMuted },
  doneBtn: { paddingVertical: 2, paddingHorizontal: 8 },
  doneText: { fontSize: 13, fontFamily: 'LINESeedKR-Bold', color: colors.primaryDeep },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.divider,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: 'LINESeedKR', color: colors.ink, padding: 0 },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  previewTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewEmoji: { fontSize: 22 },
  previewText: { fontSize: 13, fontFamily: 'LINESeedKR-Bold', color: colors.primaryDeep },
  section: { gap: 8 },
  sectionLabel: { fontSize: 12, fontFamily: 'LINESeedKR-Bold', color: colors.textFaint },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellSelected: { backgroundColor: colors.primaryTint, borderWidth: 2, borderColor: colors.primary },
  cellEmoji: { fontSize: 22 },
  cellCheck: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noResult: { paddingVertical: 12 },
  noResultText: { fontSize: 13, fontFamily: 'LINESeedKR', color: colors.textFaint },
});
