import React from 'react';

import { StyleSheet, Text, View } from 'react-native';

import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { colors, MoodKey, moods } from '../constants/theme';

/**
 * 빈 상태 — "빛 오브 스파클": 비어 있어도 반짝이는 자리.
 *
 * v5 (2026-07-21): 4방향 디자인 경합(유리 미니어처/빛 오브/도톰 스티커/미니 씬) 후
 * 3렌즈(브랜드·조형·RN호환) 심사로 합성한 최종안.
 *  - 무대: 배경 GlassBackground 의 라디얼 "빛 오브"를 일러스트 안으로 끌어온 헤일로
 *    + 다이아 스파클 성좌 — 태그라인 "반짝이게"의 직역.
 *  - link: 이중 스트로크 밴드(딥 11 + 파스텔 코어 4.5) 체인 — 72px 축소에서도
 *    "맞물린 체인"으로 읽히는 유일한 구축법(경합 검증).
 *  - folder: 입을 벌린 폴더에서 빛이 배어나오고 하트가 얹힌 씬 — "친구와 함께".
 *  - 유리 타일은 제거: 일러스트가 자체 글로우를 품고 있어 타일(유리) 위에 올리면
 *    유리-위-유리로 글로우가 죽는다(실측 렌더 확인). 공기 배경 위 직접 배치.
 *
 * mood 를 주면 그 그룹의 무드 공기에 맞춰 전체 팔레트가 치환된다 (없으면 인디고 = 개인 공간).
 */

interface EmptyStateProps {
  type: 'folder' | 'link' | 'search';
  title: string;
  subtitle: string;
  /** 공유 그룹이면 그 그룹의 무드 키 (개인 공간은 생략 → 인디고) */
  mood?: MoodKey;
  /** CTA 버튼 등 하단 액션 (선택) */
  children?: React.ReactNode;
  /**
   * CTA 아래 놓이는 보조 안내 한 줄 (선택).
   * CTA 가 1순위 행동이면 hint 는 "이런 방법도 있어요" 급 2순위 정보 — 그래서 더 작고 흐리다.
   */
  hint?: string;
}

/** 일러스트 팔레트 — 4단 톤 (딥 스트로크 / 프라이머리 / 파스텔 / 틴트) */
interface Palette {
  key: string;
  deep: string;
  primary: string;
  pastel: string;
  tint: string;
}

const INDIGO: Palette = {
  key: 'i',
  deep: colors.primaryDeep, // #6D5EF0
  primary: colors.primary, // #8B7EF2
  pastel: '#C4BCFA',
  tint: colors.primaryTint, // #EFECFF
};

/** 4포인트 다이아 스파클 (볼록) — 성좌의 기본 별 */
function sparkle(cx: number, cy: number, r: number) {
  const q = r / 4;
  return `M${cx} ${cy - r} Q${cx + q} ${cy - q} ${cx + r} ${cy} Q${cx + q} ${cy + q} ${cx} ${cy + r} Q${cx - q} ${cy + q} ${cx - r} ${cy} Q${cx - q} ${cy - q} ${cx} ${cy - r} Z`;
}

/** 4포인트 트윙클 (오목 커스프) — 표면 위 광택 */
function twinkle(cx: number, cy: number, r: number) {
  return `M${cx} ${cy - r} Q${cx} ${cy} ${cx + r} ${cy} Q${cx} ${cy} ${cx} ${cy + r} Q${cx} ${cy} ${cx - r} ${cy} Q${cx} ${cy} ${cx} ${cy - r} Z`;
}

/** 오브 헤일로 — GlassBackground 의 빛 오브 인용 */
function OrbHalo({ id, p, cy = 46 }: { id: string; p: Palette; cy?: number }) {
  return (
    <>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={p.primary} stopOpacity={0.3} />
          <Stop offset="0.55" stopColor={p.primary} stopOpacity={0.13} />
          <Stop offset="1" stopColor={p.primary} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={48} cy={cy} r={36} fill={`url(#${id})`} />
    </>
  );
}

function LinkIllust({ p }: { p: Palette }) {
  const id = `es-link-${p.key}`;
  return (
    <Svg viewBox="0 0 96 96" width="100%" height="100%">
      <OrbHalo id={`${id}-orb`} p={p} />
      <Defs>
        <LinearGradient id={`${id}-core`} x1="48" y1="32" x2="48" y2="64" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={p.tint} />
          <Stop offset="1" stopColor={p.pastel} />
        </LinearGradient>
      </Defs>
      {/* 이중 스트로크 체인 — 딥 아웃라인(11) + 파스텔 코어(4.5), 오버-언더 위빙 패치 */}
      <G rotation={-30} origin="48, 48">
        <Rect x={20.5} y={38} width={34} height={20} rx={10} fill="none" stroke={p.deep} strokeWidth={11} />
        <Rect x={20.5} y={38} width={34} height={20} rx={10} fill="none" stroke={`url(#${id}-core)`} strokeWidth={4.5} />
        <Rect x={41.5} y={38} width={34} height={20} rx={10} fill="none" stroke={p.deep} strokeWidth={11} />
        <Rect x={41.5} y={38} width={34} height={20} rx={10} fill="none" stroke={`url(#${id}-core)`} strokeWidth={4.5} />
        <Path d="M 33.5 38 L 44.5 38 A 10 10 0 0 1 54.16 45.41" fill="none" stroke={p.deep} strokeWidth={11} />
        <Path d="M 32.5 38 L 44.5 38 A 10 10 0 0 1 54.38 46.44" fill="none" stroke={`url(#${id}-core)`} strokeWidth={4.5} />
        <Circle cx={23.4} cy={40.9} r={2} fill={colors.white} opacity={0.95} />
        <Circle cx={28.8} cy={38.2} r={1.3} fill={colors.white} opacity={0.9} />
        <Circle cx={60} cy={38} r={1.5} fill={colors.white} opacity={0.9} />
      </G>
      {/* 스파클 성좌 */}
      <Path d={sparkle(80, 18, 6)} fill={p.primary} />
      <Path d={sparkle(17, 24, 4)} fill={p.pastel} />
      <Path d={sparkle(74, 71, 2.5)} fill={p.primary} opacity={0.75} />
      <Circle cx={14} cy={52} r={1.4} fill={p.primary} opacity={0.45} />
      <Circle cx={55} cy={9} r={1.2} fill={p.primary} opacity={0.35} />
    </Svg>
  );
}

function FolderIllust({ p }: { p: Palette }) {
  const id = `es-folder-${p.key}`;
  return (
    <Svg viewBox="0 0 96 96" width="100%" height="100%">
      <OrbHalo id={`${id}-orb`} p={p} />
      <Defs>
        <RadialGradient id={`${id}-mouth`} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={colors.white} stopOpacity={0.9} />
          <Stop offset="1" stopColor={colors.white} stopOpacity={0} />
        </RadialGradient>
        <LinearGradient id={`${id}-front`} x1="48" y1="41" x2="48" y2="65" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={p.pastel} />
          <Stop offset="1" stopColor={p.primary} />
        </LinearGradient>
      </Defs>
      {/* 뒤판 + 입에서 배어나오는 빛 */}
      <Path
        d="M26 27 L37 27 Q40 27 42.2 29.2 L45 32 Q46.8 33.5 49.4 33.5 L70 33.5 Q74 33.5 74 37.5 L74 58 Q74 62 70 62 L26 62 Q22 62 22 58 L22 31 Q22 27 26 27 Z"
        fill={p.deep}
      />
      <Ellipse cx={53} cy={38.5} rx={16} ry={8} fill={`url(#${id}-mouth)`} />
      {/* 앞판 — 살짝 기울여 입을 벌린 인상 */}
      <G rotation={-3} origin="48, 53">
        <Rect x={19.5} y={41.5} width={57} height={23} rx={7} fill={`url(#${id}-front)`} stroke={colors.white} strokeWidth={2.5} />
      </G>
      {/* 하트 — "친구와 함께" */}
      <Path
        d="M48 58.6 C45.8 56 41 53.4 41 49.9 C41 47.5 42.9 45.9 44.9 45.9 C46.3 45.9 47.4 46.7 48 48 C48.6 46.7 49.7 45.9 51.1 45.9 C53.1 45.9 55 47.5 55 49.9 C55 53.4 50.2 56 48 58.6 Z"
        fill={colors.white}
        opacity={0.95}
      />
      <Path d={twinkle(67, 45.5, 2.6)} fill={colors.white} opacity={0.9} />
      {/* 스파클 성좌 */}
      <Path d={sparkle(80, 20, 6)} fill={p.primary} />
      <Path d={sparkle(14, 24, 4)} fill={p.pastel} />
      <Path d={sparkle(80, 69, 2.5)} fill={p.primary} opacity={0.75} />
      <Circle cx={12} cy={50} r={1.4} fill={p.primary} opacity={0.45} />
      <Circle cx={56} cy={12} r={1.2} fill={p.primary} opacity={0.35} />
    </Svg>
  );
}

function SearchIllust({ p }: { p: Palette }) {
  const id = `es-search-${p.key}`;
  return (
    <Svg viewBox="0 0 96 96" width="100%" height="100%">
      <OrbHalo id={`${id}-orb`} p={p} cy={45} />
      <Defs>
        <LinearGradient id={`${id}-rim`} x1="32" y1="26" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={p.pastel} />
          <Stop offset="1" stopColor={p.primary} />
        </LinearGradient>
      </Defs>
      {/* 렌즈 유리 → 손잡이 → 림 (z순서로 접합부를 림이 덮는다) */}
      <Circle cx={44} cy={42} r={10} fill={p.tint} opacity={0.9} />
      <Path d="M54 52 L66 64" stroke={p.deep} strokeWidth={9} strokeLinecap="round" />
      <Circle cx={44} cy={42} r={14} fill="none" stroke={`url(#${id}-rim)`} strokeWidth={9} />
      <Path d="M30.5 38.4 A14 14 0 0 1 37 29.9" fill="none" stroke={colors.white} strokeWidth={2.5} strokeLinecap="round" opacity={0.65} />
      {/* 렌즈 속 스파클 — 찾는 자리에서도 반짝임 */}
      <Path d={sparkle(44, 42, 5.5)} fill={p.primary} />
      <Circle cx={49} cy={37} r={1.2} fill={p.primary} opacity={0.55} />
      <Path d={sparkle(57, 37, 2.8)} fill={colors.white} opacity={0.9} />
      {/* 스파클 성좌 */}
      <Path d={sparkle(77, 26, 6)} fill={p.primary} />
      <Path d={sparkle(18, 22, 4)} fill={p.pastel} />
      <Path d={sparkle(26, 64, 2.5)} fill={p.primary} opacity={0.75} />
      <Circle cx={68} cy={14} r={1.4} fill={p.primary} opacity={0.45} />
      <Circle cx={80} cy={50} r={1.2} fill={p.primary} opacity={0.35} />
    </Svg>
  );
}

const ILLUST: Record<EmptyStateProps['type'], (props: { p: Palette }) => React.JSX.Element> = {
  folder: FolderIllust,
  link: LinkIllust,
  search: SearchIllust,
};

export default function EmptyState({ type, title, subtitle, mood, children, hint }: EmptyStateProps) {
  // key 는 SVG def id 접두사 — 무드마다 달라야 같은 화면에 두 팔레트가 섞여도 안 겹친다
  const palette: Palette = mood ? { key: mood, ...moods[mood].illust } : INDIGO;
  const Illust = ILLUST[type];
  const subColor = mood ? moods[mood].metaText : colors.textFaint;

  return (
    <View style={styles.container}>
      <View style={styles.illust}>
        <Illust p={palette} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={[styles.subtitle, { color: subColor }]}>{subtitle}</Text>
      {children && <View style={styles.actions}>{children}</View>}
      {hint && <Text style={[styles.hint, { color: subColor }]}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingTop: 56,
    paddingHorizontal: 40,
  },
  // 타일 없음 — 일러스트가 자체 오브 글로우로 무대를 만든다 (반투명 표면 그림자 규칙과도 무관해짐)
  illust: {
    width: 120,
    height: 120,
  },
  title: {
    fontSize: 19,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.57,
    marginTop: 18,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'LINESeedKR',
    textAlign: 'center',
    lineHeight: 22,
    marginTop: 9,
  },
  actions: {
    alignItems: 'center',
    marginTop: 24,
    gap: 4,
  },
  // subtitle 보다 한 단계 작고 흐리게 — CTA 아래 2순위 정보라 시선을 먼저 끌면 안 된다
  hint: {
    fontSize: 12,
    fontFamily: 'LINESeedKR',
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 16,
    opacity: 0.75,
  },
});
