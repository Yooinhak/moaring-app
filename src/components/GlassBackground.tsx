import React, { useEffect, useRef, useState } from 'react';

import { Animated, StyleSheet, View } from 'react-native';

import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { air, AirVariant, MoodKey, moods } from '../constants/theme';

/**
 * 공기(배경) 레이어. variant(개인/로그인) 또는 mood(공유 그룹 무드)를 받아
 * 그라디언트+빛 오브를 그린다. mood/variant 가 바뀌면 280ms 크로스페이드.
 */

interface AirConfig {
  key: string;
  stops: readonly string[];
  locations: readonly number[];
  orbs: ReadonlyArray<{ cx: number; cy: number; r: number; color: string; opacity: number }>;
}

const W = 375;
const H = 812;

// variant 별 오브 (기존 ORBS 에서 group 항목은 moods.sunset 으로 이동)
const VARIANT_ORBS: Record<'personal' | 'login', AirConfig['orbs']> = {
  personal: [
    { cx: 80, cy: 50, r: 150, color: '#9B8CFF', opacity: 0.5 },
    { cx: 340, cy: 60, r: 125, color: '#8B6EFF', opacity: 0.28 },
  ],
  login: [
    { cx: 90, cy: 60, r: 175, color: '#9B8CFF', opacity: 0.55 },
    { cx: 335, cy: 150, r: 135, color: '#8B6EFF', opacity: 0.3 },
  ],
};

function resolveConfig(variant: AirVariant, mood?: MoodKey): AirConfig {
  if (mood) {
    const m = moods[mood];
    return { key: `m-${mood}`, stops: m.stops, locations: m.locations, orbs: m.orbs };
  }
  // 'group' variant 는 하위 호환 — sunset 무드와 동일 취급
  if (variant === 'group') {
    const m = moods.sunset;
    return { key: 'm-sunset', stops: m.stops, locations: m.locations, orbs: m.orbs };
  }
  const g = air[variant];
  return { key: `v-${variant}`, stops: g.stops, locations: g.locations, orbs: VARIANT_ORBS[variant] };
}

function AirLayer({ cfg }: { cfg: AirConfig }) {
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      pointerEvents="none"
    >
      <Defs>
        {/* 175deg ≈ 거의 수직 그라디언트 */}
        <LinearGradient id={`air-${cfg.key}`} x1="0" y1="0" x2="0.06" y2="1">
          {cfg.stops.map((color, i) => (
            <Stop key={color + i} offset={cfg.locations[i]} stopColor={color} />
          ))}
        </LinearGradient>
        {cfg.orbs.map((orb, i) => (
          <RadialGradient key={`orb-def-${i}`} id={`orb-${cfg.key}-${i}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={orb.color} stopOpacity={orb.opacity} />
            <Stop offset="0.65" stopColor={orb.color} stopOpacity={orb.opacity * 0.45} />
            <Stop offset="1" stopColor={orb.color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      <Rect x={0} y={0} width={W} height={H} fill={`url(#air-${cfg.key})`} />
      {cfg.orbs.map((orb, i) => (
        <Circle key={`orb-${i}`} cx={orb.cx} cy={orb.cy} r={orb.r} fill={`url(#orb-${cfg.key}-${i})`} />
      ))}
    </Svg>
  );
}

interface GlassBackgroundProps {
  variant?: AirVariant;
  /** 공유 그룹 무드 — 지정 시 variant 보다 우선 */
  mood?: MoodKey;
}

function GlassBackground({ variant = 'personal', mood }: GlassBackgroundProps) {
  const cfg = resolveConfig(variant, mood);

  // 크로스페이드 — 렌더 중 비교로 상태 전환 (effect 동기 setState 금지 lint 대응)
  const [curr, setCurr] = useState(cfg);
  const [prev, setPrev] = useState<AirConfig | null>(null);
  const fade = useRef(new Animated.Value(1)).current;
  if (cfg.key !== curr.key) {
    setPrev(curr);
    setCurr(cfg);
    // ⚠️ 렌더 중 외부 뮤테이션 — 커밋되지 않는 렌더에서도 실행된다.
    // mood 를 startTransition/useDeferredValue 로 전달하지 말 것 (버려진 렌더가 fade=0 을 남겨 배경이 투명해질 수 있음).
    fade.setValue(0);
  }

  useEffect(() => {
    if (!prev) return;
    const anim = Animated.timing(fade, { toValue: 1, duration: 280, useNativeDriver: true });
    anim.start(({ finished }) => {
      if (finished) setPrev(null);
    });
    return () => anim.stop();
    // deps 는 의도적으로 curr.key 만 — prev 는 항상 같은 렌더에서 함께 세팅되어 stale 하지 않고,
    // prev 를 넣으면 애니메이션 종료(setPrev(null))마다 무의미한 cleanup/재실행이 돈다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curr.key]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {prev && <AirLayer cfg={prev} />}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <AirLayer cfg={curr} />
      </Animated.View>
    </View>
  );
}

export default React.memo(GlassBackground);
