// Supabase Edge Function: delete-account
//
// 목적: 로그인한 사용자의 계정을 완전 삭제한다.
//   - Apple App Store Guideline 5.1.1(v) 준수: 앱에서 계정 생성이 가능하다면
//     반드시 앱 내에서 계정 삭제도 가능해야 한다.
//   - auth.users 삭제는 service_role 권한이 필요하므로 클라이언트에서 직접
//     호출할 수 없다. 따라서 Edge Function으로 분리한다.
//
// 처리 순서:
//   1) Authorization 헤더의 JWT로 사용자 신원 검증 (user-scoped client)
//   2) service_role client로 다음을 수행
//      0. link-previews 버킷에서 이 사용자 posts 의 썸네일(preview_image_path) 제거
//         — 실패해도 계속 진행한다. 행이 지워질 때 tombstone 트리거(005)가 경로를
//           적재하고 link-preview 함수가 다음 호출 때 GC 하므로 이중 안전.
//      a. folders 삭제 → posts는 ON DELETE CASCADE 가정으로 함께 제거
//      b. 방어적으로 user_id로 posts 재삭제 (cascade 미설정 대비)
//      c. auth.admin.deleteUser(user.id)
//   3) 실패 시 어느 단계에서 실패했는지 명확히 반환
//
// 배포:
//   supabase functions deploy delete-account --no-verify-jwt
//   (JWT 검증은 함수 내부에서 직접 수행하므로 --no-verify-jwt 사용)
//
// 필요한 환경변수 (Supabase가 자동 주입):
//   - SUPABASE_URL
//   - SUPABASE_ANON_KEY
//   - SUPABASE_SERVICE_ROLE_KEY

// @ts-nocheck — 이 파일은 Deno 런타임에서 실행된다. Node/Expo용 TypeScript
// 서버는 URL import와 Deno 전역을 이해하지 못하므로 편집기 진단만 꺼둔다.
// 실제 타입 체크와 린팅은 `supabase/functions/deno.json` + Deno 확장이 담당.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders } from '../_shared/cors.ts';

interface DeleteResult {
  success: boolean;
  step?: string;
  error?: string;
}

function jsonResponse(body: DeleteResult, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

// link-previews 버킷에서 이 사용자 posts 의 썸네일을 지운다.
//   posts 행을 지워도 Storage 객체(S3)는 cascade 되지 않으므로 행이 사라지기 전에
//   preview_image_path 를 읽어 Storage API 로 직접 제거해야 한다.
//   어떤 실패도 계정 삭제를 막지 않는다 — 여기서 못 지운 경로는 행 삭제 시
//   tombstone 트리거(005)가 적재하고 link-preview 함수가 다음 호출 때 GC 한다.
//   005 미적용(컬럼 없음)이면 select 가 실패하고 그대로 넘어간다.
//   같은 이미지를 여러 글이 공유할 수 있으니(canonical 재활용) 경로는 중복 제거한다.
async function cleanupPreviewImages(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  const PAGE_SIZE = 1000; // PostgREST 기본 max-rows 와 같게 — 그 이상은 페이지로 읽는다
  const MAX_PAGES = 20; // range 가 무시되는 비정상 응답에서도 무한 루프가 되지 않게
  const REMOVE_CHUNK = 100; // storage.remove 1회 요청에 담는 경로 수

  try {
    const paths = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      const { data, error } = await adminClient
        .from('posts')
        .select('preview_image_path')
        .eq('user_id', userId)
        .not('preview_image_path', 'is', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        console.warn(
          '[delete-account] storage cleanup failed',
          'select',
          error.message,
        );
        break;
      }

      for (const row of data ?? []) {
        const path = row.preview_image_path;
        if (typeof path === 'string' && path) {
          paths.add(path);
        }
      }

      if (!data || data.length < PAGE_SIZE) {
        break;
      }
    }

    const list = [...paths];
    for (let i = 0; i < list.length; i += REMOVE_CHUNK) {
      const chunk = list.slice(i, i + REMOVE_CHUNK);
      const { error } = await adminClient.storage
        .from('link-previews')
        .remove(chunk);

      if (error) {
        // 한 묶음이 실패해도 나머지는 계속 시도한다 (경로 자체는 로그에 남기지 않는다)
        console.warn(
          '[delete-account] storage cleanup failed',
          'remove',
          chunk.length,
          error.message,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      '[delete-account] storage cleanup failed',
      'unexpected',
      message,
    );
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(
      { success: false, error: 'Method not allowed' },
      405,
    );
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse(
        {
          success: false,
          step: 'env',
          error: 'Missing required environment variables',
        },
        500,
      );
    }

    // 1) Authorization 헤더에서 JWT 추출
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse(
        { success: false, step: 'auth', error: 'Missing Bearer token' },
        401,
      );
    }

    // 2) user-scoped 클라이언트로 현재 사용자 조회
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return jsonResponse(
        {
          success: false,
          step: 'auth',
          error: userError?.message ?? 'Invalid or expired token',
        },
        401,
      );
    }

    const userId = user.id;

    // 3) admin 클라이언트 (service_role)
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 3-0) link-previews 버킷 썸네일 정리 — 행이 지워지기 전에 경로를 읽어야 하므로
    //      folders 삭제보다 먼저. 실패해도 응답에 영향 없이 계속 (위 cleanupPreviewImages 주석)
    await cleanupPreviewImages(adminClient, userId);

    // 3-a) folders 삭제 (posts 는 FK ON DELETE CASCADE 가정)
    const { error: foldersError } = await adminClient
      .from('folders')
      .delete()
      .eq('user_id', userId);

    if (foldersError) {
      return jsonResponse(
        {
          success: false,
          step: 'delete_folders',
          error: foldersError.message,
        },
        500,
      );
    }

    // 3-b) 방어적 posts 재삭제 (cascade 미설정/일부 누락 대비)
    const { error: postsError } = await adminClient
      .from('posts')
      .delete()
      .eq('user_id', userId);

    if (postsError) {
      return jsonResponse(
        {
          success: false,
          step: 'delete_posts',
          error: postsError.message,
        },
        500,
      );
    }

    // 3-c) auth.users 삭제 (최종 단계)
    const { error: deleteUserError } =
      await adminClient.auth.admin.deleteUser(userId);

    if (deleteUserError) {
      return jsonResponse(
        {
          success: false,
          step: 'delete_auth_user',
          error: deleteUserError.message,
        },
        500,
      );
    }

    return jsonResponse({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { success: false, step: 'unexpected', error: message },
      500,
    );
  }
});
