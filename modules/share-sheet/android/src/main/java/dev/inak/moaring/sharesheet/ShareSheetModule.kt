package dev.inak.moaring.sharesheet

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS → 공유 시트 Activity 제어.
 * close(): 현재 Activity 가 ShareSheetActivity 일 때만 닫는다 (메인 앱을 실수로 닫지 않도록).
 */
class ShareSheetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShareSheet")

    Function("close") {
      val activity = appContext.currentActivity as? ShareSheetActivity
      activity?.runOnUiThread { activity.finish() }
      Unit
    }
  }
}
