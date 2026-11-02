import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';

import { QueryClientProvider } from '@tanstack/react-query';
import { type FontSource, useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import BottomSheet from '../components/BottomSheet';
import Button from '../components/Button';
import ErrorBoundary from '../components/ErrorBoundary';
import SaveLinkSheet from '../components/sheets/SaveLinkSheet';
import { ExtensionToastProvider, NativeToastProvider } from '../components/Toast';
import { colors } from '../constants/theme';
import { GroupProvider } from '../contexts/GroupContext';
import { useAuth } from '../hooks/useAuth';
import { extractUrl } from '../utils/extractUrl';
import { queryClient } from '../utils/react-query/queryClient';

import { closeShareHost, openMainApp } from './shareHost';

/**
 * 공유 시트 루트 — Android `ShareSheetActivity`(AppRegistry 'share') / iOS 공유 확장(ShareExtensionRoot).
 *
 * 다른 앱에서 공유 → 모아링 선택 시, 앱으로 전환하지 않고 공유한 앱 위에 투명 Activity 가
 * 뜨고 여기서 저장 위치 시트만 보여준다. 저장/닫기 → Activity 종료 → 원래 앱으로 복귀.
 *
 * 메인 앱과 같은 JS 런타임이라 supabase 세션·React Query 캐시·최근 폴더(AsyncStorage)를
 * 공유한다. 단 Provider 는 시트에 필요한 것만 가볍게 감싼다 (네비게이션·스플래시 없음).
 * iOS 확장은 별도 프로세스 — 세션·현재 그룹·최근 폴더는 appStorage(App Group)로 공유한다.
 */

// 시트 내림 애니메이션(gorhom 기본 ~250ms)이 끝난 뒤 Activity 를 닫는다.
const CLOSE_DELAY_MS = 280;
// Android: 시스템 토스트(시트 닫힌 뒤에도 남음) / iOS 확장: 시트 위 오버레이
const ShareToastProvider = Platform.OS === 'ios' ? ExtensionToastProvider : NativeToastProvider;
// iOS 확장은 런타임 폰트 로드 불가 → 네이티브 임베드(Task 6). Android 는 기존대로 로드.
const FONT_MAP: Record<string, FontSource> =
  Platform.OS === 'ios'
    ? {}
    : {
        LINESeedKR: require('../../assets/fonts/LINESeedKR-Rg.ttf'),
        'LINESeedKR-Bold': require('../../assets/fonts/LINESeedKR-Bd.ttf'),
      };

interface ShareAppProps {
  /** ShareSheetActivity 가 Intent.EXTRA_TEXT 를 initialProps 로 넘긴다 */
  sharedText?: string;
}

export default function ShareApp({ sharedText }: ShareAppProps) {
  // 메인 앱이 이미 로드했으면 즉시 true (expo-font 는 프로세스 단위 캐시)
  const [fontsLoaded, fontsError] = useFonts(FONT_MAP);
  if (!fontsLoaded && !fontsError) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <ErrorBoundary>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <ShareToastProvider>
              <GroupProvider>
                <ShareContent sharedText={sharedText} />
              </GroupProvider>
            </ShareToastProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

function ShareContent({ sharedText }: ShareAppProps) {
  const { session, loading } = useAuth();
  const url = useMemo(() => extractUrl(sharedText), [sharedText]);
  const [visible, setVisible] = useState(true);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(closeShareHost, CLOSE_DELAY_MS);
  }, []);

  // Android: 링크가 아닌 텍스트 → 시트 없이 시스템 토스트 후 종료
  useEffect(() => {
    if (url || Platform.OS !== 'android') return;
    ToastAndroid.show('링크만 모아링에 저장할 수 있어요', ToastAndroid.SHORT);
    closeShareHost();
  }, [url]);

  if (!url) {
    // iOS: 시스템 토스트가 없어 안내 시트로 대신한다
    if (Platform.OS !== 'ios') return null;
    return (
      <BottomSheet visible={visible} onClose={close} title="링크만 저장할 수 있어요">
        <View style={styles.loginBody}>
          <Text style={styles.loginText}>{'공유한 내용에서 링크를 찾지 못했어요.\nhttp(s) 링크를 공유해주세요.'}</Text>
          <Button onPress={close}>닫기</Button>
        </View>
      </BottomSheet>
    );
  }

  // 세션 복원 중 — 투명 화면 유지 (보통 수십 ms)
  if (loading) return null;

  if (!session) {
    return (
      <BottomSheet visible={visible} onClose={close} title="로그인이 필요해요">
        <View style={styles.loginBody}>
          <Text style={styles.loginText}>{'모아링에 로그인하면\n공유한 링크를 바로 저장할 수 있어요.'}</Text>
          <Button onPress={openMainApp}>모아링 열기</Button>
        </View>
      </BottomSheet>
    );
  }

  return <SaveLinkSheet visible={visible} onClose={close} initialUrl={url} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  loginBody: { gap: 18, paddingTop: 4 },
  loginText: {
    fontSize: 14,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
    lineHeight: 21,
  },
});
