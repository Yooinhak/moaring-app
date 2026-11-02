import React from 'react';

import { Text, View } from 'react-native';

import { close, type InitialProps } from 'expo-share-extension';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import BottomSheet from '../components/BottomSheet';
import Button from '../components/Button';

/** 스파이크 전용 — 확장 안에서 gorhom 시트·Modal·텍스트·폰트가 뜨는지만 본다 (Task 5 에서 교체). */
export default function ShareExtensionRoot({ url, text }: InitialProps) {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: 'transparent' }}>
      <SafeAreaProvider>
        <BottomSheet visible onClose={close} title="스파이크">
          <View style={{ gap: 12 }}>
            <Text style={{ fontFamily: 'LINESeedKR', fontSize: 16 }}>LINESeedKR: {url ?? text ?? '(없음)'}</Text>
            <Text style={{ fontSize: 16 }}>시스템 폰트 텍스트</Text>
            <Button onPress={close}>닫기</Button>
          </View>
        </BottomSheet>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
