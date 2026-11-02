import { close, openHostApp } from 'expo-share-extension';

/** 공유 확장을 닫고 공유한 앱으로 돌아간다. */
export function closeShareHost() {
  close();
}

/** 메인 앱(moaring://)을 연다 — 확장은 네이티브가 함께 닫는다. */
export function openMainApp() {
  openHostApp('');
}
