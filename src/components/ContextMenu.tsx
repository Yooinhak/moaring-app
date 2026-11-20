import React, { useCallback, useRef, useState } from 'react';

import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { colors, radius } from '../constants/theme';

export interface ContextMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  icon?: React.ReactNode;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  trigger: React.ReactNode;
}

const MENU_WIDTH = 160;

export default function ContextMenu({ items, trigger }: ContextMenuProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const triggerRef = useRef<View>(null);

  const handleOpen = useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      const { width: screenWidth } = Dimensions.get('window');
      const triggerRight = screenWidth - (x + width);

      setPosition({
        top: y + height + 8,
        right: Math.max(triggerRight - 4, 12),
      });
      setVisible(true);
    });
  }, []);

  return (
    <>
      <TouchableOpacity
        ref={triggerRef}
        onPress={(e) => {
          e.stopPropagation();
          handleOpen();
        }}
        activeOpacity={0.5}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="더 보기"
      >
        {trigger}
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setVisible(false)}>
          <View
            style={[styles.menu, { top: position.top, right: position.right }]}
            onStartShouldSetResponder={() => true}
          >
            {items.map((item, index) => (
              <React.Fragment key={index}>
                {index > 0 && <View style={styles.divider} />}
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    setVisible(false);
                    setTimeout(item.onPress, 200);
                  }}
                  activeOpacity={0.6}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                >
                  {item.icon && <View style={styles.menuIcon}>{item.icon}</View>}
                  <Text style={[styles.menuText, item.destructive && styles.destructiveText]}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  // v4: 검정 그림자(#000) → 인디고 틴트 (theme.ts v3 규칙). 흰 배경 위 흰 메뉴가
  // 떠 보이도록 연한 인디고 보더를 더하고, 항목 패딩을 줄여 카드를 덜 가리게 했다.
  menu: {
    position: 'absolute',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: 'rgba(139,126,242,0.16)',
    borderRadius: radius.button,
    minWidth: MENU_WIDTH,
    shadowColor: colors.primaryDeep,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 26,
    elevation: 10,
    padding: 5,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 11, // 바깥(16)보다 타이트하게 — 중첩 라운드 규칙
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.divider,
    marginVertical: 4,
    marginHorizontal: 9,
  },
  menuIcon: {
    marginRight: 9,
  },
  menuText: {
    fontSize: 14,
    color: colors.text,
    fontFamily: 'LINESeedKR',
  },
  destructiveText: {
    color: colors.destructive,
  },
});
