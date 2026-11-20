import { Mood, moods, resolveMoodKey } from '../constants/theme';
import { useGroup } from '../contexts/GroupContext';

/** 현재 공간의 무드. 개인 공간(나의 서랍)이면 null. */
export function useCurrentMood(): Mood | null {
  const { currentGroup, isPersonal } = useGroup();
  if (isPersonal || !currentGroup) return null;
  return moods[resolveMoodKey(currentGroup.color)];
}
