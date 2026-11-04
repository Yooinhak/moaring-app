import { close, openHostApp } from 'expo-share-extension';

/** 공유 확장을 닫고 공유한 앱으로 돌아간다. */
export function closeShareHost() {
  close();
}

/**
 * 메인 앱(moaring:///)을 연다 — 확장은 네이티브가 함께 닫는다.
 * 빈 문자열은 금지: 네이티브가 "".split("?")[0] 을 읽다 Index out of range 로 크래시 (5.0.6).
 */
export function openMainApp() {
  openHostApp('/');
}
