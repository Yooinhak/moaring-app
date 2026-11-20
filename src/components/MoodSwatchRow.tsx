import React from 'react';

import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, MOOD_ORDER, MoodKey, moods } from '../constants/theme';
import { lightTap } from '../utils/haptics';

import MoodWash from './MoodWash';

/**
 * 무드 스와치 행 — 그룹 생성/수정 공용. 가로 스크롤(무드 추가 확장 대비).
 * 46×46 r16 타일 = 무드 미니 그라디언트 + 우상단 오브 힌트 점 + 캡션.
 */
interface MoodSwatchRowProps {
  value: MoodKey;
  onChange: (key: MoodKey) => void;
  /** 이름 기반 추천 무드 — '추천' 배지 표시용 (수동 개입 후엔 null 전달) */
  suggested?: MoodKey | null;
}

export default function MoodSwatchRow({ value, onChange, suggested = null }: MoodSwatchRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {MOOD_ORDER.map((key) => {
        const m = moods[key];
        const active = value === key;
        return (
          <TouchableOpacity
            key={key}
            style={styles.item}
            onPress={() => {
              lightTap();
              onChange(key);
            }}
            activeOpacity={0.7}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            accessibilityLabel={`${m.label} 무드`}
          >
            <View style={[styles.tile, active && { borderColor: m.accent, borderWidth: 2.5 }]}>
              <MoodWash colors={[m.stops[0], m.stops[2]]} />
              <View style={[styles.orbHint, { backgroundColor: m.orbs[0].color }]} />
            </View>
            <Text style={[styles.caption, { color: active ? m.metaText : colors.textFaint }]}>{m.label}</Text>
            {suggested === key ? (
              <View style={[styles.badge, { backgroundColor: m.tile }]}>
                <Text style={[styles.badgeText, { color: m.metaText }]}>추천</Text>
              </View>
            ) : (
              <View style={styles.badgeSpacer} />
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const GLASS_BORDER = 'rgba(255,255,255,0.9)';

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 9, paddingRight: 8 },
  item: { alignItems: 'center', gap: 4 },
  tile: { width: 46, height: 46, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: GLASS_BORDER },
  orbHint: { position: 'absolute', top: 5, right: 6, width: 7, height: 7, borderRadius: 4, opacity: 0.55 },
  caption: { fontSize: 10, fontFamily: 'LINESeedKR-Bold' },
  badge: { borderRadius: 7, paddingHorizontal: 6, paddingVertical: 1.5 },
  badgeText: { fontSize: 9, fontFamily: 'LINESeedKR-Bold' },
  badgeSpacer: { height: 15 },
});
