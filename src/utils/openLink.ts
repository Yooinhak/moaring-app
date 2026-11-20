import { Linking } from 'react-native';

import * as WebBrowser from 'expo-web-browser';

import { getDomainInfo } from './domainInfo';

/**
 * 저장된 링크 열기.
 *
 * - 전용 앱이 있는 서비스(domainInfo 의 opensInApp 플래그 — 인스타그램·유튜브·스레드·틱톡·쿠팡 등):
 *   시스템에 넘긴다(Linking.openURL). 앱이 설치돼 있으면 앱이, 없으면 기본 브라우저가 열린다.
 * - 그 외 일반 웹페이지: 앱을 떠나지 않도록 인앱 브라우저로 연다.
 *
 * 인앱 브라우저만 쓰면 인스타 링크도 앱이 아닌 웹으로 열려서(유니버설/앱 링크 미동작) 이렇게 나눈다.
 */
export async function openLink(url: string): Promise<void> {
  if (getDomainInfo(url)?.opensInApp) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // 처리할 앱이 없으면 아래 인앱 브라우저로
    }
  }
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    // 인앱 브라우저를 띄울 수 없는 환경(브라우저 미설치 등) — 시스템에 마지막으로 맡긴다
    await Linking.openURL(url).catch(() => {});
  }
}
