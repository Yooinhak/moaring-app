import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Dimensions,
  Keyboard,
  LayoutChangeEvent,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import BottomSheetInline, {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, shadows } from '../constants/theme';

import { ChevronLeftIcon } from './icons';

/**
 * 공용 바텀시트 — @gorhom/bottom-sheet 의 "인라인" 컴포넌트(기본 export) 구현.
 *
 * BottomSheetModal(+Provider+Portal) 경로는 이 스택(RN 0.83 · New Architecture · reanimated 4)
 * 에서 present() 는 호출되지만 Portal 이 시트 콘텐츠를 마운트하지 않아 열리지 않았다.
 * 그래서 Portal 을 쓰지 않는 인라인 컴포넌트로 구현한다.
 *
 * 레이어링: 인라인 시트를 RN Modal 로 감싼다 — 탭바/시스템 바 위층 확보.
 * Modal 내부 제스처는 GestureHandlerRootView 래핑 필수.
 *
 * 키보드 (2026-07-15 v3 — "리프트" 방식, 풀스크린 부작용 해결):
 * - 키보드가 뜨면 시트 전체를 키보드 높이만큼 위로 띄운다(bottomInset=keyboardHeight).
 *   폴더 목록·저장 버튼(footer)이 키보드에 가리지 않고 그 위로 올라온다.
 * - v2 의 앵커드 방식은 키보드가 하단(저장 버튼 등)을 덮는 문제가 있었고, 그 이전
 *   interactive 리프트는 시트가 화면 꼭대기까지 차오르는 풀스크린 부작용이 있었다.
 *   원인은 리프트 시 시트 높이를 키보드만큼 줄이지 않은 것 — 이제 snapPoints 에서
 *   (화면 - 상단인셋 - 키보드) 안으로 높이를 클램프하므로 부작용이 없다.
 * - 시트가 통째로 키보드 위에 있으므로 스크롤 하단 패딩/자동 인셋은 불필요(제거).
 *
 * 고정 헤더/푸터 (2026-07-13, UX 개선):
 * - 타이틀·`fixedTop`(핵심 입력)·`footer`(CTA 버튼)는 스크롤 밖에 고정되고,
 *   children 만 가운데에서 스크롤된다 — 긴 콘텐츠에서도 입력창/버튼이 항상 보인다.
 * - 시트 최대 높이 75% (기존 85% — 꽉 차게 올라와 부담스럽다는 피드백 반영).
 *
 * 프롭 API(visible/onClose/title/description/children)는 기존과 호환 — fixedTop/footer 는 선택.
 *
 * 시트 안 화면 전환 (2026-10-23, 공유 시트 새 폴더):
 * - `onBack` 을 주면 타이틀 왼쪽에 ‹ 가 생기고, Android 뒤로 버튼도 시트를 닫는 대신 onBack 을 부른다.
 * - `headerRight` 는 타이틀 줄 오른쪽 끝 액션(예: ＋ 새 폴더).
 */

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  /** 타이틀 아래, 스크롤 밖에 고정되는 영역 (예: 이름/URL 입력) */
  fixedTop?: React.ReactNode;
  /** 시트 하단에 고정되는 영역 (예: 저장/취소 버튼) */
  footer?: React.ReactNode;
  /** 시트 안 이전 화면으로 — 헤더 ‹ 버튼 + Android 뒤로 버튼이 시트를 닫지 않고 이걸 부른다 */
  onBack?: () => void;
  /** 타이틀 줄 오른쪽 끝 액션 */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
// 최대 60% 고정 (토스/당근류 폼 시트 관행: 55~65%).
// 키보드가 떠도 시트는 움직이지 않는다 — 리프트/축소 조합은 풀스크린화 부작용 (v2 주석 참고).
const MAX_HEIGHT = SCREEN_HEIGHT * 0.6;

export default function BottomSheet({
  visible,
  onClose,
  title,
  description,
  fixedTop,
  footer,
  onBack,
  headerRight,
  children,
}: BottomSheetProps) {
  const ref = useRef<BottomSheetInline>(null);
  const insets = useSafeAreaInsets();

  // visible=true 일 때만 실제로 마운트(그래야 index=0 으로 열림). 닫힘은 애니메이션 후 언마운트.
  const [rendered, setRendered] = useState(visible);
  const [topHeight, setTopHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRendered(true);
    } else {
      ref.current?.close();
    }
  }, [visible]);

  // 키보드 높이 추적 — 스크롤 영역 하단 패딩용 (시트 자체는 움직이지 않음)
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const bottomPadding = Math.max(insets.bottom, 16) + 16;

  // 시트 크롬(그랩 핸들 ~24 + 여유 12) — snapPoint 계산에 필수.
  // 이걸 빼먹으면 시트가 짧아져 하단이 잘린다 (2026-07-10 버그).
  const CHROME_HEIGHT = 36;

  // 고정 영역(top/footer) + 스크롤 콘텐츠를 모두 합산해 시트 높이를 결정.
  // MAX 초과 시 가운데(children)만 스크롤 — scrollMaxHeight(아래)로 스크롤 높이를 고정.
  // 주의: top/footer 는 onLayout 측정값에 자체 패딩이 포함되지만, 스크롤 콘텐츠는
  // 컨테이너 패딩(paddingTop 8 + 푸터 없을 때의 bottomPadding)이 측정 밖이라 더해준다.
  const hasFooter = !!footer;
  const snapPoints = useMemo(() => {
    const scrollPad = 8 + (hasFooter ? 0 : bottomPadding);
    const measured =
      contentHeight > 0
        ? topHeight + contentHeight + scrollPad + (hasFooter ? footerHeight : 0) + CHROME_HEIGHT
        : SCREEN_HEIGHT * 0.45;
    // 키보드가 떠 있으면 시트를 그만큼 위로 올리므로(bottomInset), 시트 높이도
    // (화면 - 상단 인셋 - 키보드) 안으로 제한해야 한다. 이 클램프가 없으면 시트
    // 상단이 화면 밖으로 밀려나 풀스크린처럼 보이던 예전 버그가 재발한다.
    const availWithKeyboard = SCREEN_HEIGHT - insets.top - keyboardHeight - 12;
    const cap = keyboardHeight > 0 ? Math.min(MAX_HEIGHT, availWithKeyboard) : MAX_HEIGHT;
    return [Math.min(Math.max(measured, 160), cap)];
  }, [topHeight, contentHeight, footerHeight, bottomPadding, hasFooter, keyboardHeight, insets.top]);

  const onTopLayout = useCallback((e: LayoutChangeEvent) => {
    setTopHeight(e.nativeEvent.layout.height);
  }, []);
  const onContentLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setContentHeight(h);
  }, []);
  const onFooterLayout = useCallback((e: LayoutChangeEvent) => {
    setFooterHeight(e.nativeEvent.layout.height);
  }, []);

  // 시트가 닫히면(팬다운/백드롭 탭/close()) 언마운트 + 부모 상태 동기화
  const handleClose = useCallback(() => {
    setRendered(false);
    if (visible) onClose();
  }, [visible, onClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.32}
        pressBehavior="close"
      />
    ),
    [],
  );

  // 스크롤 영역 높이를 '직접' 계산해 고정한다.
  // gorhom 시트 안에서 flex(shrink/grow)나 footerComponent 로 스크롤+고정 푸터를 잡는 건
  // 우리 커스텀 Modal+inline+수동 bottomInset 조합에서 불안정했다(푸터가 사라지거나 위로
  // 튀어나옴). 대신 시트 높이 - 크롬 - 상단 - 푸터 를 스크롤 maxHeight 로 박으면, 콘텐츠가
  // 아무리 길어도 가운데만 스크롤되고 하단 고정 푸터가 항상 제자리에 남는다 (2026-07-16).
  const scrollMaxHeight = Math.max(
    snapPoints[0] - CHROME_HEIGHT - topHeight - (hasFooter ? footerHeight : 0) - 8,
    96,
  );

  if (!rendered) return null;

  const hasFixedHeader = !!title || !!fixedTop;

  return (
    <Modal
      visible
      transparent
      animationType="none" // 등장/퇴장 애니메이션은 gorhom 이 담당
      onRequestClose={() => (onBack ? onBack() : ref.current?.close())} // Android 뒤로가기 → 이전 화면 또는 시트 닫기
      statusBarTranslucent
      // NOTE: navigationBarTranslucent 금지(2026-07-10) — 시트 하단이 시스템 바에 가려짐.
    >
      <GestureHandlerRootView style={styles.rootView}>
        <BottomSheetInline
          ref={ref}
          index={0}
          snapPoints={snapPoints}
          enableDynamicSizing={false}
          enablePanDownToClose
          onClose={handleClose}
          // 시트 전체를 키보드 높이만큼 위로 띄운다 — 폴더 목록·저장 버튼(footer)이
          // 키보드에 가리지 않고 그 위로 올라온다. 높이는 snapPoints 에서 이미
          // (화면-키보드) 안으로 클램프하므로 예전 interactive 방식의 풀스크린
          // 부작용이 없다 (2026-07-15).
          bottomInset={keyboardHeight}
          // 단일 snapPoint 라 "extend" 는 실질적 no-op — 리프트는 bottomInset 담당.
          keyboardBehavior="extend"
          keyboardBlurBehavior="restore"
          backdropComponent={renderBackdrop}
          backgroundStyle={styles.sheetBg}
          handleIndicatorStyle={styles.handle}
          style={styles.sheetShadow}
        >
          <View style={styles.body}>
            {/* ── 고정 헤더: 타이틀 + 핵심 입력 ── */}
            {hasFixedHeader && (
              <View style={styles.topArea} onLayout={onTopLayout}>
                {title && (
                  <View style={styles.header}>
                    <View style={styles.titleRow}>
                      {onBack && (
                        <TouchableOpacity
                          onPress={onBack}
                          hitSlop={12}
                          style={styles.backBtn}
                          accessibilityRole="button"
                          accessibilityLabel="뒤로"
                        >
                          <ChevronLeftIcon size={22} color={colors.ink} strokeWidth={2.4} />
                        </TouchableOpacity>
                      )}
                      <Text style={styles.title} accessibilityRole="header">
                        {title}
                      </Text>
                      {headerRight}
                    </View>
                    {description && <Text style={styles.description}>{description}</Text>}
                  </View>
                )}
                {fixedTop}
              </View>
            )}

            {/* ── 스크롤 영역 (children) — 높이를 직접 고정해 가운데만 스크롤 ── */}
            <BottomSheetScrollView
              style={[styles.scrollArea, { maxHeight: scrollMaxHeight }]}
              contentContainerStyle={[
                styles.content,
                // 푸터가 없으면 스크롤 끝에 하단 패딩을 직접 준다
                !footer && { paddingBottom: bottomPadding },
              ]}
              // 시트 전체가 bottomInset 으로 키보드 위에 떠 있으므로, 스크롤 자체를
              // 키보드에 맞춰 추가로 밀어올릴 필요가 없다 (이중 여백 방지).
              automaticallyAdjustKeyboardInsets={false}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View onLayout={onContentLayout}>{children}</View>
            </BottomSheetScrollView>

            {/* ── 고정 푸터: CTA 버튼 (스크롤 아래, 시트 하단 고정) ── */}
            {footer && (
              <View
                style={[
                  styles.footerArea,
                  // 키보드가 뜨면 시트가 키보드 위로 떠서 하단 세이프에어리어가
                  // 불필요 — 여백을 줄여 버튼을 키보드 바로 위에 붙인다.
                  { paddingBottom: keyboardHeight > 0 ? 12 : bottomPadding },
                ]}
                onLayout={onFooterLayout}
              >
                {footer}
              </View>
            )}
          </View>
        </BottomSheetInline>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rootView: {
    flex: 1,
  },
  sheetBg: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  sheetShadow: {
    ...shadows.sheet,
  },
  handle: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  body: {
    flex: 1,
  },
  topArea: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  scrollArea: {
    // 높이는 인라인 maxHeight(scrollMaxHeight)로 고정한다. flexGrow:0 이라 콘텐츠보다
    // 커지지 않고, maxHeight 를 넘으면 내부에서만 스크롤된다.
    flexGrow: 0,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  footerArea: {
    paddingHorizontal: 24,
    paddingTop: 12,
    // 스크롤 콘텐츠와의 시각적 구분 (스크롤이 버튼 뒤로 지나갈 때)
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
    backgroundColor: colors.surface,
  },
  header: {
    paddingTop: 6,
    paddingBottom: 8,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backBtn: {
    marginLeft: -6, // 아이콘 여백만큼 당겨 타이틀 시작선과 시각적으로 맞춘다
  },
  title: {
    flex: 1,
    fontSize: 20,
    fontFamily: 'LINESeedKR-Bold',
    color: colors.ink,
    letterSpacing: -0.6,
  },
  description: {
    fontSize: 13,
    fontFamily: 'LINESeedKR',
    color: colors.textFaint,
    lineHeight: 19,
  },
});
