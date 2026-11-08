/**
 * withXcode27Fixes — Xcode 27 / iOS 27 SDK 로 빌드할 때 깨지는 것들을 고치는 config plugin.
 *
 * 1) fmt 11.0.2 (RN 0.83 의존) 가 Xcode 27 clang 에서 consteval 에러로 컴파일 실패
 *    → fmt 타깃만 C++17 로 컴파일한다. (Podfile post_install)
 * 2) 일부 Pod 의 deployment target 이 15.0 미만이라 Xcode 27 에서 에러
 *    → 앱과 같은 최소 버전(15.1)으로 올린다. (Podfile post_install)
 * 3) iOS 27 SDK 로 빌드한 앱은 UIScene 생명주기가 필수 — 없으면 실행 즉시 SIGTRAP
 *    (_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption)
 *    → Info.plist 에 Scene manifest 를 넣고, RN 시작을 AppDelegate 에서 SceneDelegate 로 옮긴다.
 *
 * ios/ 는 prebuild 로 재생성되므로 직접 고치면 --clean 때 날아간다. 그래서 플러그인으로 둔다.
 * RN/Expo 가 위 문제들을 자체 해결하는 버전으로 올리면 해당 부분은 지워도 된다.
 */
const { withPodfile, withInfoPlist, withAppDelegate } = require('@expo/config-plugins');

const MARKER = '# withXcode27Fixes';
const SWIFT_MARKER = '// withXcode27Fixes';
const MIN_IOS = '15.1';

const POST_INSTALL_BLOCK = `
    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |c|
        c.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17' if target.name == 'fmt'
        dt = c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_IOS}' if dt && Gem::Version.new(dt) < Gem::Version.new('${MIN_IOS}')
      end
    end`;

// prebuild 가 생성하는 post_install 안의 react_native_post_install(...) 호출 (여기 뒤에 붙인다).
const RN_POST_INSTALL = /react_native_post_install\([\s\S]*?\n\s*\)/;

// 템플릿 AppDelegate 의 창 생성 + RN 시작 부분 → launchOptions 만 보관 (시작은 SceneDelegate 가 한다)
const APP_DELEGATE_START = /    window = UIWindow\(frame: UIScreen\.main\.bounds\)\n    factory\.startReactNative\([\s\S]*?launchOptions: launchOptions\)\n/;
const APP_DELEGATE_START_REPLACEMENT = `    ${SWIFT_MARKER}: RN 시작은 SceneDelegate 에서 (iOS 27 SDK 는 UIScene 필수)
    self.launchOptions = launchOptions
`;
const APP_DELEGATE_VARS = '  var reactNativeFactory: RCTReactNativeFactory?\n';

const SCENE_DELEGATE = `
${SWIFT_MARKER}: iOS 27 SDK 부터 UIScene 생명주기 필수 — 창 생성·RN 시작·딥링크 수신을 여기서 한다.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    // 콜드 스타트 딥링크를 launchOptions 에 실어 Linking.getInitialURL() 이 받게 한다
    var launchOptions = appDelegate.launchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
  }

  // Linking API (앱 실행 중 딥링크)
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      _ = RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  // Universal Links
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = RCTLinkingManager.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`;

const withPodfileFixes = (config) =>
  withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents;
    if (podfile.includes(MARKER)) return cfg;
    if (!RN_POST_INSTALL.test(podfile)) {
      throw new Error('withXcode27Fixes: Podfile 에서 react_native_post_install(...) 을 찾지 못했습니다.');
    }
    cfg.modResults.contents = podfile.replace(RN_POST_INSTALL, (m) => m + POST_INSTALL_BLOCK);
    return cfg;
  });

const withSceneManifest = (config) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });

const withSceneDelegate = (config) =>
  withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(SWIFT_MARKER)) return cfg;
    if (cfg.modResults.language !== 'swift' || !APP_DELEGATE_START.test(src) || !src.includes(APP_DELEGATE_VARS)) {
      throw new Error('withXcode27Fixes: AppDelegate.swift 템플릿이 예상과 달라 SceneDelegate 를 적용하지 못했습니다.');
    }
    src = src.replace(APP_DELEGATE_START, APP_DELEGATE_START_REPLACEMENT);
    src = src.replace(
      APP_DELEGATE_VARS,
      `${APP_DELEGATE_VARS}  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n`
    );
    cfg.modResults.contents = src + SCENE_DELEGATE;
    return cfg;
  });

module.exports = function withXcode27Fixes(config) {
  return withSceneDelegate(withSceneManifest(withPodfileFixes(config)));
};
