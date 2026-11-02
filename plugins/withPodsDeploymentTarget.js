/**
 * withPodsDeploymentTarget — Xcode 27 에서 Pods 빌드가 깨지는 두 가지를 post_install 에서 보정한다.
 *
 * 1) 지원 범위(15.0~) 아래 배포 타깃이 경고가 아니라 에러가 됐다.
 *    Sentry·SDWebImage·RNSVG·AsyncStorage 리소스 번들 타깃이 podspec 기본값(9.0~13.4)을 그대로 가짐 → 15.1.
 * 2) 새 Apple clang 에서 fmt 11.0.2 의 consteval 포맷 문자열 검사가 컴파일 에러
 *    ("call to consteval function ... is not a constant expression") — RN 소스 빌드 시 fmt 타깃.
 *    fmt 타깃만 C++17 로 내려 consteval 경로를 끈다 (FMT_CPLUSPLUS < 201709 → FMT_USE_CONSTEVAL 0).
 *
 * react_native_post_install 이 모든 타깃을 c++20 으로 덮으므로 그 "뒤"(호출 6줄 아래)에 넣는다.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs');
const path = require('path');

const MIN_TARGET = '15.1';

module.exports = function withPodsDeploymentTarget(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      const contents = fs.readFileSync(podfilePath, 'utf8');
      const merged = mergeContents({
        tag: 'xcode27-pods-fixes',
        src: contents,
        newSrc: `    installer.pods_project.targets.each do |t|
      t.build_configurations.each do |c|
        if c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < ${MIN_TARGET}
          c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_TARGET}'
        end
        c.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17' if t.name == 'fmt'
      end
    end`,
        anchor: /react_native_post_install\(/,
        offset: 6,
        comment: '#',
      });
      fs.writeFileSync(podfilePath, merged.contents);
      return cfg;
    },
  ]);
};
