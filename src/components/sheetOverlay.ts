import { createContext, useContext, type ReactNode } from 'react';

/**
 * BottomSheet 의 Modal 안쪽 최상단에 그릴 노드.
 * iOS 공유 확장에는 시트 밖에 그릴 화면이 없어(시스템 토스트도 없음) 토스트를 시트 위에 띄우는 용도.
 */
export const SheetOverlayContext = createContext<ReactNode>(null);

export const useSheetOverlay = () => useContext(SheetOverlayContext);
