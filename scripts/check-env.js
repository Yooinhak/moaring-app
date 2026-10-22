#!/usr/bin/env node
/**
 * 빌드 전 필수 환경 변수 점검 — 없으면 빌드를 멈춘다.
 *
 * EXPO_PUBLIC_* 값은 Metro 가 번들 시점에 코드에 그대로 박아 넣는다. .env 가 없어도 빌드는
 * "성공"하지만, 그 APK 는 src/utils/supabase/client.ts 의 createClient(undefined) 에서
 * 실행하자마자 죽는다. 2026-10-22 실제로 이 맥의 .env 가 사라진 채 0.0.6 이 그렇게 배포됐다.
 * (.env 는 gitignore 라 다른 PC 에서 pull 해도 따라오지 않는다.)
 *
 * Metro 와 똑같이 @expo/env 로 .env* 를 production 모드 우선순위로 읽고,
 * 셸 환경 변수로 넘긴 값도 인정한다(셸 값이 .env 보다 우선 — expo 동작과 동일).
 *
 * 사용: node scripts/check-env.js [projectRoot]   (빌드 스크립트들이 자동 호출)
 */
const path = require('path');
const { parseProjectEnv } = require('@expo/env');

const REQUIRED = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'];

const projectRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const { env: fileEnv, files } = parseProjectEnv(projectRoot, { mode: 'production', silent: true });

const missing = REQUIRED.filter((key) => !(process.env[key] || fileEnv[key]));

if (missing.length > 0) {
  console.error('❌ 필수 환경 변수가 비어 있어 빌드를 멈춥니다: ' + missing.join(', '));
  console.error(
    files.length > 0
      ? '   읽은 파일: ' + files.map((f) => path.relative(projectRoot, f)).join(', ')
      : '   .env 파일이 없습니다 (gitignore 라 다른 PC 에서 pull 해도 오지 않아요).',
  );
  console.error('   해결) cp .env.example .env 후 Supabase 대시보드(Project Settings → API) 값으로 채우기');
  console.error('   이대로 빌드하면 앱이 실행하자마자 종료됩니다.');
  process.exit(1);
}

console.log('🔑 필수 환경 변수 확인: ' + REQUIRED.join(', '));
