import React, { useId } from 'react';

import { StyleSheet } from 'react-native';

import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/**
 * 색유리 워시 — 칩/타일/밴드의 배경을 무드 그라디언트로 물들인다.
 * 부모 View 가 overflow:'hidden' + borderRadius 로 형태를 만든다.
 */

interface MoodWashProps {
  colors: readonly [string, string];
  /** 비활성 칩은 0.55 로 옅게 (설계 §4) */
  opacity?: number;
}

export default function MoodWash({ colors: [from, to], opacity = 1 }: MoodWashProps) {
  const id = `mood-wash-${useId()}`;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0.35" y2="1">
          <Stop offset="0" stopColor={from} stopOpacity={opacity} />
          <Stop offset="1" stopColor={to} stopOpacity={opacity} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}
