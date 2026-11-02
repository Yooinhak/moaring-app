import { Linking } from 'react-native';

import { closeShareSheet } from '../../modules/share-sheet';

/** 공유 시트 Activity 를 닫고 공유한 앱으로 돌아간다. */
export function closeShareHost() {
  closeShareSheet();
}

/** 메인 앱을 열고 시트를 닫는다. */
export function openMainApp() {
  Linking.openURL('moaring://').catch(() => {});
  closeShareSheet();
}
