package dev.inak.moaring.sharesheet

import android.content.Intent
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * 공유 전용 투명 Activity — JS 의 `share` 루트 컴포넌트를 띄운다.
 *
 * MainActivity 와 같은 ReactHost(JS 런타임)를 공유하므로 supabase 세션·React Query 캐시를
 * 그대로 쓴다. 앱이 이미 백그라운드에 살아 있으면 즉시, 완전히 꺼져 있으면 번들 로딩 후 뜬다.
 *
 * 의도적으로 expo 의 ReactActivityDelegateWrapper 를 쓰지 않는다: 래퍼는 모든 expo 패키지의
 * ReactActivityLifecycleListener 를 호출하는데, expo-share-intent 리스너가 이 SEND 인텐트를
 * 싱글톤에 저장해 두면 나중에 메인 앱을 열 때 HomeScreen 의 저장 시트가 한 번 더 뜬다.
 */
class ShareSheetActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    // 프로세스 재생성 시 RN 화면 복원은 지원하지 않으므로 null (MainActivity 와 동일)
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "share"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
      override fun getLaunchOptions(): Bundle = Bundle().apply {
        putString("sharedText", extractSharedText(intent))
      }
    }

  /** 공유 시트는 스택을 남기지 않는다 — 뒤로가기 = 닫기 (MainActivity 의 moveTaskToBack 와 다름) */
  override fun invokeDefaultOnBackPressed() {
    finish()
  }

  override fun finish() {
    super.finish()
    // 투명 창이 슬라이드 애니메이션 없이 바로 사라지게 (시트 내림 애니메이션은 RN 이 이미 끝냄)
    @Suppress("DEPRECATION")
    overridePendingTransition(0, 0)
  }

  private fun extractSharedText(intent: Intent?): String? {
    if (intent?.action != Intent.ACTION_SEND) return null
    return intent.getStringExtra(Intent.EXTRA_TEXT)
      ?: intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
  }
}
