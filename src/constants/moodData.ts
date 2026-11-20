import { MOOD_ORDER, MoodKey } from './theme';

/** 무드별 이름 매칭 키워드 — emojiData 의 matchEmojis 와 같은 부분포함 매칭 + 두 글자 이상 가드. */
const MOOD_KEYWORDS: Record<MoodKey, string> = {
  sunset: '여행 제주 부산 강릉 바다 캠핑 소풍 나들이 휴가 여름 노을 trip travel',
  mint: '스터디 공부 운동 헬스 러닝 등산 산책 챌린지 아침 습관 살림 청소 study',
  rose: '데이트 웨딩 결혼 신혼 덕질 아이돌 전시 뷰티 패션 선물 기념일',
  citrus: '맛집 음식 카페 커피 브런치 빵집 베이커리 디저트 레시피 요리 술집 와인 맥주 회식 먹방 food',
  dusk: '영화 넷플릭스 드라마 음악 게임 심야 새벽 야식 공연 콘서트 책방 독서 북클럽 movie',
};

/**
 * 그룹 이름 → 추천 무드. 매칭 없으면 null (시트는 기본 sunset 유지, '추천' 배지 미표시).
 * 이미 사용 중인 무드는 후순위 — 복수 매칭 시 미사용 무드를 먼저 고른다 (레일 식별성 방어).
 */
export function suggestMood(name: string, usedMoods: MoodKey[] = []): MoodKey | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const matched: MoodKey[] = [];
  for (const key of MOOD_ORDER) {
    if (MOOD_KEYWORDS[key].split(' ').some((kw) => kw.length >= 2 && q.includes(kw))) matched.push(key);
  }
  if (matched.length === 0) return null;
  const used = new Set(usedMoods);
  return matched.find((m) => !used.has(m)) ?? matched[0];
}
