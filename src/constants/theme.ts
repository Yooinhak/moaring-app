/**
 * Design Tokens — 모아링(Moaring) "인디고 글래스" (DESIGN UPDATE v3, 2026-07-11)
 * 기준: design_handoff/README.md + 'Linkle 2a 파이널.dc.html' (구 명칭 시안 파일)
 *
 * 핵심 규칙:
 *  ◆ 배경 = 공기: 개인(나의 서랍) = 라벤더, 공유 그룹 = 웜 (GlassBackground)
 *  ◆ 유리 카드: 흰 72% + 흰 보더 (RN 은 backdrop blur 불가 → 반투명 + 보더로 근사)
 *  ◆ 액센트 인디고 단일: 채움 #8B7EF2 / 텍스트·강조 #6D5EF0 · 폴더색은 아이콘 타일에만
 *  ◆ 그림자: 회색 금지 → 인디고 틴트, 단 유리(반투명) 표면에는 그림자 자체 금지
 *  ◆ 카운트/섹션 라벨 = 대문자 + letterSpacing
 * 기존 키(primary, gray[...], destructive 등)는 하위 호환을 위해 유지.
 */

export const colors = {
  // Primary — DESIGN UPDATE v3 (2026-07-11): 토스 블루 → 소프트 인디고
  primary: '#8B7EF2', // 채워진 버튼·FAB·활성 탭·토글 on
  primaryDeep: '#6D5EF0', // 텍스트 액센트·링크·라디오 선택·강조 아이콘
  primaryTint: '#EFECFF', // 연한 배경·선택 상태 배경·아이콘 타일 bg
  primaryLight: '#EFECFF', // (legacy alias = primaryTint)
  primaryDark: '#6D5EF0', // (legacy alias = primaryDeep)

  // Text (강 → 약)
  ink: '#191F28', // 제목, 강조
  text: '#333D4B', // 본문 강
  textSub: '#4E5968', // 본문
  textMuted: '#6B7684', // 보조
  textFaint: '#8B95A1', // 캡션, 플레이스홀더 라벨
  textDisabled: '#B0B8C1', // 메타(도메인/날짜), 비활성
  iconFaint: '#C4CCD4', // chevron 등 장식 아이콘

  // Surface — v3: 라벤더/웜 공기
  bg: '#F4F2FB', // 기본 앱 배경 (라벤더 공기)
  bgWarm: '#FBF5EF', // 공유 그룹 화면 배경 (웜 공기)
  background: '#F4F2FB', // (legacy alias = bg)
  surface: '#FFFFFF', // 카드/시트 표면
  divider: '#F2F4F6', // 구분선, 트랙 배경
  fieldBg: '#F9FAFB', // 입력 필드 배경(테두리 있는 경우)
  border: '#E5E8EB', // 입력 필드 테두리

  // Status
  danger: '#F04452',
  destructive: '#F04452', // (legacy alias = danger)
  destructiveLight: '#FFF0F1',
  success: '#00C472',

  // Brand
  kakao: '#FEE500',
  kakaoText: '#191919',

  // Base
  white: '#FFFFFF',
  black: '#191F28',

  // Legacy scales — 기존 코드 호환용. 값은 새 텍스트 토큰과 정렬됨.
  gray: {
    50: '#F9FAFB', // = fieldBg
    100: '#F2F4F6', // = divider
    200: '#E5E8EB', // = border
    300: '#C4CCD4', // = iconFaint
    400: '#B0B8C1', // = textDisabled
    500: '#8B95A1', // = textFaint
    600: '#6B7684', // = textMuted
    700: '#4E5968', // = textSub
    800: '#333D4B', // = text
    900: '#191F28', // = ink
  },
  blue: {
    // v3: 명칭은 legacy, 값은 인디고로 정렬
    50: '#EFECFF',
    100: '#DCD5FF',
    500: '#8B7EF2',
    600: '#6D5EF0',
  },
} as const;

/**
 * 유리 표면 토큰 — 시안의 "프로스트 유리" 계층.
 * RN 은 backdrop-filter 를 지원하지 않으므로 반투명 흰색 + 흰 보더 + 부드러운
 * 컬러 섀도로 근사한다 (GlassBackground 그라디언트 위에서 유리처럼 보임).
 */
export const glass = {
  bg: 'rgba(255,255,255,0.72)', // 기본 유리 카드
  bgStrong: 'rgba(255,255,255,0.9)', // 강조 표면 (활성 칩, 오버레이 버튼)
  bgSoft: 'rgba(255,255,255,0.42)', // 비활성 칩, 은은한 표면
  border: 'rgba(255,255,255,0.95)', // 유리 카드 보더
  borderSoft: 'rgba(255,255,255,0.6)', // 비활성 칩 보더
} as const;

/**
 * 공기(배경) 그라디언트 — GlassBackground 에서 사용.
 * personal = 라벤더 공기 · login = 딥 블루 공기.
 * 공유 그룹의 공기는 moods 가 담당한다 ('group' variant 는 sunset 으로 하위 호환 처리).
 */
export const air = {
  personal: {
    stops: ['#E2DDFF', '#F0EDFC', '#F6F9FE'],
    locations: [0, 0.34, 1],
  },
  login: {
    stops: ['#D6CEFF', '#EBE6FC', '#F6F9FE'],
    locations: [0, 0.4, 1],
  },
} as const;

/** 'group' 은 air 에 항목이 없는 레거시 별칭 — GlassBackground 가 moods.sunset 으로 해석한다. */
export type AirVariant = 'personal' | 'group' | 'login';

/**
 * 무드(공기) 토큰 — 그룹 아이덴티티 = 무드 1개 (설계: group-mood-air.design.md).
 * 제약: 모든 무드의 마지막 스톱은 #F6F9FE 수렴 (glass/ink 대비 보장).
 * 색값은 실기기 튜닝 전제의 시작값. 커스텀 무드는 의도적으로 없음 — 확장은 여기에 행 추가.
 */
export const MOOD_ORDER = ['sunset', 'mint', 'rose', 'citrus', 'dusk'] as const;
export type MoodKey = (typeof MOOD_ORDER)[number];

export interface Mood {
  key: MoodKey;
  label: string;
  stops: readonly [string, string, string];
  locations: readonly [number, number, number];
  orbs: ReadonlyArray<{ cx: number; cy: number; r: number; color: string; opacity: number }>;
  /** 대시 보더·포인트·활성 칩 보더 (구 warm.accent 역할) */
  accent: string;
  /** 공기 위 보조 텍스트 (구 warm.text 역할) */
  metaText: string;
  /** 아이콘 타일 bg (구 warm.tile 역할) */
  tile: string;
  /** 레일 칩 색유리 워시 [위, 아래] — 비활성은 opacity 로 옅게 */
  chipWash: readonly [string, string];
  /** EmptyState 일러스트 팔레트 */
  illust: { deep: string; primary: string; pastel: string; tint: string };
}

export const moods: Record<MoodKey, Mood> = {
  // 현 웜 공기 승계 — 레거시 그룹('blue'/null)이 이 무드로 폴백되어 배포 당일 화면 변화 제로
  sunset: {
    key: 'sunset',
    label: '노을',
    stops: ['#FFE9D6', '#F4F0FA', '#F6F9FE'],
    locations: [0, 0.3, 1],
    orbs: [
      { cx: 350, cy: 50, r: 135, color: '#FF9A3D', opacity: 0.35 },
      { cx: 20, cy: 120, r: 110, color: '#FFC49A', opacity: 0.25 },
    ],
    accent: '#F97316',
    metaText: '#A16207',
    tile: '#FFF3E4',
    chipWash: ['#FFE3C2', '#FFF3E6'],
    illust: { deep: '#C2410C', primary: '#F97316', pastel: '#FDBA74', tint: '#FFF3E4' },
  },
  mint: {
    key: 'mint',
    label: '민트',
    stops: ['#D9F5EA', '#EDF7F3', '#F6F9FE'],
    locations: [0, 0.32, 1],
    orbs: [
      { cx: 340, cy: 55, r: 135, color: '#34D399', opacity: 0.3 },
      { cx: 30, cy: 110, r: 110, color: '#A7F3D0', opacity: 0.25 },
    ],
    accent: '#10B981',
    metaText: '#047857',
    tile: '#E3F7EF',
    chipWash: ['#D9F5EA', '#F0FBF6'],
    illust: { deep: '#047857', primary: '#10B981', pastel: '#6EE7B7', tint: '#E3F7EF' },
  },
  rose: {
    key: 'rose',
    label: '로즈',
    stops: ['#FFE0EC', '#F8EEF5', '#F6F9FE'],
    locations: [0, 0.3, 1],
    orbs: [
      { cx: 340, cy: 55, r: 135, color: '#F472B6', opacity: 0.3 },
      { cx: 30, cy: 110, r: 110, color: '#FBCFE3', opacity: 0.28 },
    ],
    accent: '#EC4899',
    metaText: '#9D2463',
    tile: '#FDE7F1',
    chipWash: ['#FFDFEB', '#FFF0F6'],
    illust: { deep: '#BE185D', primary: '#EC4899', pastel: '#F9A8D4', tint: '#FDE7F1' },
  },
  citrus: {
    key: 'citrus',
    label: '시트러스',
    stops: ['#FFF3C9', '#F8F3E7', '#F6F9FE'],
    locations: [0, 0.3, 1],
    orbs: [
      { cx: 340, cy: 55, r: 135, color: '#FBBF24', opacity: 0.32 },
      { cx: 30, cy: 110, r: 110, color: '#FDE68A', opacity: 0.26 },
    ],
    accent: '#F59E0B',
    metaText: '#854F0B',
    tile: '#FEF3D7',
    chipWash: ['#FFF0C2', '#FFF9E5'],
    illust: { deep: '#B45309', primary: '#F59E0B', pastel: '#FCD34D', tint: '#FEF3D7' },
  },
  dusk: {
    key: 'dusk',
    label: '저녁',
    stops: ['#D8E2FF', '#EAEDFB', '#F6F9FE'],
    locations: [0, 0.3, 1],
    orbs: [
      { cx: 340, cy: 55, r: 135, color: '#818CF8', opacity: 0.34 },
      { cx: 30, cy: 110, r: 110, color: '#C7D2FE', opacity: 0.26 },
    ],
    accent: '#6366F1',
    metaText: '#4338CA',
    tile: '#E4E9FF',
    chipWash: ['#D8E2FF', '#EEF1FF'],
    illust: { deep: '#4338CA', primary: '#6366F1', pastel: '#A5B4FC', tint: '#E4E9FF' },
  },
} as const;

/** groups.color → 무드 키. 미지값·레거시 'blue'·null 은 전부 sunset 폴백 (이관 전략). */
export function resolveMoodKey(color: string | null | undefined): MoodKey {
  return color && (MOOD_ORDER as readonly string[]).includes(color) ? (color as MoodKey) : 'sunset';
}

export const folderColors = [
  { key: 'blue', icon: '#3182F6', bg: '#E8F3FF' },
  { key: 'purple', icon: '#8B5CF6', bg: '#F3EEFF' },
  { key: 'pink', icon: '#EC4899', bg: '#FDF2F8' },
  { key: 'orange', icon: '#F97316', bg: '#FFF7ED' },
  { key: 'green', icon: '#22C55E', bg: '#F0FDF4' },
  { key: 'gray', icon: '#6B7684', bg: '#F2F4F6' },
] as const;

export type FolderColorKey = (typeof folderColors)[number]['key'];

export function getFolderColor(key?: string | null) {
  return folderColors.find((c) => c.key === key) ?? folderColors[0];
}

/**
 * 그룹 id → 안정적인 팔레트 색. 그룹은 색 속성이 없어 레일/타일에서 이모지에만
 * 의존해 구분됐는데(모델 비대칭), id 해시로 일관된 색을 부여해 식별성을 높인다.
 * (스키마 변경 없이 클라이언트에서 결정적으로 계산)
 *
 * @deprecated 무드 체계로 대체됨(group-mood-air). 롤백 안전판으로 보존.
 */
export function getGroupColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return folderColors[h % folderColors.length];
}

/** Border radius 스케일 — 블루 글래스: 카드 20, 버튼 16, 칩(레일) 21 */
export const radius = {
  card: 20,
  sheet: 28, // 시트 상단 (top-left/right만)
  button: 16,
  chip: 21, // 채널 레일 칩 (height 42 의 절반)
  tile: 12, // 폴더 아이콘 타일
} as const;

/**
 * Shadow 프리셋 — README 값 기준.
 * RN 은 CSS multi-shadow 를 지원하지 않으므로 iOS 는 대표 레이어 1개로 근사,
 * Android 는 elevation 으로 근사한다.
 */
export const shadows = {
  // ⚠️ 유리 표면 규칙 (2026-07-11 양 플랫폼 실기기 확인): 반투명(glass.*) 배경에는
  // 그림자를 아예 쓰지 않는다. Android elevation 도, iOS shadow* 도 모두 "뷰 뒤"에
  // 그려지기 때문에 배경이 반투명이면 자기 그림자가 카드를 통과해 회색 얼룩과
  // 꼭지점 그림자 아티팩트로 보인다 (Android 1차 → iOS 2차로 동일 증상 재현).
  // → 유리 표면의 정의는 흰 보더 + 반투명 + 배경 그라디언트 대비가 담당.
  //   그림자는 불투명 표면 프리셋(sheet/fab/primaryGlow)에만 허용.
  card: { elevation: 0 },
  glassCard: { elevation: 0 },
  warmCard: { elevation: 0 },
  chip: { elevation: 0 },
  floatBar: { elevation: 0 },
  // v3: 활성 탭 필/CTA — rgba(139,126,242,0.3)
  primaryGlow: {
    shadowColor: '#8B7EF2',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 6,
  },
  // (legacy — 미사용) 불투명 큰 카드
  bigCard: {
    shadowColor: '#8B7EF2',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
    elevation: 3,
  },
  // v3 그림자 규칙: 회색 금지 → 인디고 틴트. (불투명 표면 전용 — 유리 표면 규칙 참고)
  // 위로 뜨는 시트
  sheet: {
    shadowColor: '#8B7EF2',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.18,
    shadowRadius: 30,
    elevation: 12,
  },
  // primary FAB: rgba(139,126,242,0.3)
  fab: {
    shadowColor: '#8B7EF2',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 6,
  },
} as const;

/**
 * 폰트 — LINE Seed KR (v3). Rg/Bd 2단계만 존재하므로 fontWeight 대신 fontFamily로
 * 굵기를 전환한다 (400~500 → regular, 600+ → bold).
 * 이름은 App.tsx useFonts 키와 일치해야 함.
 * ⚠️ iOS에서 커스텀 fontFamily + fontWeight 병기는 시스템 폰트로 폴백될 수 있으므로
 *    스타일에는 fontFamily만 쓴다.
 */
export const fonts = {
  regular: 'LINESeedKR',
  bold: 'LINESeedKR-Bold',
} as const;

/**
 * 타이포 프리셋 — 시안의 Space Grotesk 역할(카운트/섹션 라벨)을
 * 시스템 폰트 + letterSpacing 으로 근사. 나중에 폰트를 실제 로딩하면
 * 여기에 fontFamily 한 줄만 추가하면 된다.
 */
export const typo = {
  /** "24 LINKS" 류 카운트 — v3: 텍스트 액센트는 primaryDeep */
  count: {
    fontSize: 12,
    fontFamily: 'LINESeedKR-Bold',
    letterSpacing: 0.6,
    color: colors.primaryDeep,
  },
  /** "EMOJI" / "MEMBERS · 3" 류 섹션 라벨 (대문자로 쓸 것) */
  sectionLabel: {
    fontSize: 11,
    fontFamily: 'LINESeedKR-Bold',
    letterSpacing: 1.7,
    color: colors.textFaint,
  },
} as const;
