import React, { useEffect, useRef } from 'react';

import { Animated, StyleSheet, Text, View } from 'react-native';

import { useNetInfo } from '@react-native-community/netinfo';

import { colors } from '../constants/theme';

import { WifiOffIcon } from './icons';

export default function OfflineBanner() {
  const { isConnected } = useNetInfo();
  const height = useRef(new Animated.Value(0)).current;

  const isOffline = isConnected === false;

  useEffect(() => {
    Animated.timing(height, {
      toValue: isOffline ? 36 : 0,
      duration: 250,
      useNativeDriver: false,
    }).start();
  }, [isOffline, height]);

  return (
    <Animated.View style={[styles.container, { height }]}>
      <View style={styles.content}>
        <WifiOffIcon size={16} color={colors.white} />
        <Text style={styles.text}>오프라인 상태입니다</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.gray[700],
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  text: {
    fontSize: 13,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.white,
  },
});
