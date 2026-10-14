import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { Animated, Platform, StyleSheet, Text, ToastAndroid, TouchableOpacity, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius } from '../constants/theme';
import { successTap, warningTap } from '../utils/haptics';
import { registerErrorToast } from '../utils/toastBridge';

import { CheckIcon, XIcon } from './icons';

type ToastType = 'success' | 'error';

interface ToastAction {
  label: string;
  onPress: () => void;
}

interface ToastMessage {
  id: number;
  type: ToastType;
  message: string;
  action?: ToastAction;
  duration?: number;
}

interface ToastContextType {
  showToast: (type: ToastType, message: string, options?: { action?: ToastAction; duration?: number }) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}


function ToastItem({ toast, onDone }: { toast: ToastMessage; onDone: (id: number) => void }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-20)).current;
  const duration = toast.duration ?? 2200;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start();

    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: -20, duration: 200, useNativeDriver: true }),
      ]).start(() => onDone(toast.id));
    }, duration);

    return () => clearTimeout(timer);
  }, []);

  const isSuccess = toast.type === 'success';

  const handleActionPress = () => {
    toast.action?.onPress();
    // 액션 버튼을 누르면 즉시 토스트를 닫는다
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: -20, duration: 150, useNativeDriver: true }),
    ]).start(() => onDone(toast.id));
  };

  return (
    <Animated.View
      style={[styles.toast, { opacity, transform: [{ translateY }] }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      accessibilityLabel={toast.message}
    >
      <View style={[styles.iconWrap, { backgroundColor: isSuccess ? colors.success : colors.destructive }]} importantForAccessibility="no-hide-descendants">
        {isSuccess ? (
          <CheckIcon size={13} color={colors.white} strokeWidth={3} />
        ) : (
          <XIcon size={13} color={colors.white} strokeWidth={3} />
        )}
      </View>
      <Text style={styles.toastText}>{toast.message}</Text>
      {toast.action && (
        <TouchableOpacity
          onPress={handleActionPress}
          style={styles.actionBtn}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={toast.action.label}
        >
          <Text style={styles.actionText}>{toast.action.label}</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

let toastId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((type: ToastType, message: string, options?: { action?: ToastAction; duration?: number }) => {
    if (type === 'success') successTap();
    else warningTap();
    setToasts((prev) => [...prev, { id: ++toastId, type, message, action: options?.action, duration: options?.duration }]);
  }, []);

  // React 바깥(queryClient onError 등)에서도 에러를 띄울 수 있게 브리지에 등록
  useEffect(() => {
    registerErrorToast((message) => showToast('error', message));
    return () => registerErrorToast(null);
  }, [showToast]);

  const handleDone = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <View style={[styles.container, { top: insets.top + (Platform.OS === 'ios' ? 8 : 16) }]} pointerEvents="box-none">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={handleDone} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

/**
 * 공유 시트(Android 투명 Activity) 전용 — 시스템 토스트(ToastAndroid)로 띄운다.
 *
 * RN 토스트는 시트(Modal) 아래에 깔리고, 저장 직후 Activity 가 닫히면 함께 사라진다.
 * 시스템 토스트는 Activity 가 닫힌 뒤에도 공유한 앱 위에 남는다.
 * 저장 성공 시 useCreatePost·SaveLinkSheet 가 연달아 토스트를 부르므로 같은 종류는 1.5초 내 1회만.
 * toastBridge 에는 등록하지 않는다 — 같은 JS 런타임의 메인 앱 ToastProvider 등록을 덮어쓰면 안 됨.
 */
export function NativeToastProvider({ children }: { children: React.ReactNode }) {
  const last = useRef<{ type: ToastType; at: number } | null>(null);

  const showToast = useCallback((type: ToastType, message: string) => {
    const now = Date.now();
    if (last.current && last.current.type === type && now - last.current.at < 1500) return;
    last.current = { type, at: now };
    if (type === 'success') successTap();
    else warningTap();
    ToastAndroid.show(message, ToastAndroid.SHORT);
  }, []);

  return <ToastContext.Provider value={{ showToast }}>{children}</ToastContext.Provider>;
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 20,
    right: 20,
    alignItems: 'center',
    zIndex: 100,
    gap: 8,
  },
  // v4: 검정 풀폭 → 인디고 글래스 언어에 맞는 밝은 표면 + 내용 폭.
  // 풀폭(width:'100%')은 화면 헤더를 통째로 덮어 맥락을 잃게 했다.
  // 배경은 불투명 흰색 — 반투명이면 자기 그림자가 비쳐 얼룩이 생긴다(theme.ts 유리 표면 규칙).
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: '100%',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: 'rgba(139,126,242,0.14)',
    borderRadius: radius.button,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 9,
    // 그림자는 회색 금지 → 인디고 틴트 (theme.ts v3 규칙)
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 18,
    elevation: 6,
  },
  iconWrap: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    flexShrink: 1,
    fontSize: 13.5,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.2,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: colors.primaryTint,
  },
  actionText: {
    fontSize: 12.5,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.primaryDeep,
  },
});
