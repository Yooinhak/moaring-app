import ExpoModulesCore

/// App Group UserDefaults 키-값 저장소 — 메인 앱과 공유 확장(별도 프로세스)이 같은 값을 본다.
/// App Group entitlement 가 없으면(무료 Personal Team 실기기) suite 가 앱 전용으로 동작해
/// 공유만 안 될 뿐 읽기/쓰기는 정상이다.
public class SharedStorageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SharedStorage")

    Function("getItem") { (suite: String, key: String) -> String? in
      UserDefaults(suiteName: suite)?.string(forKey: key)
    }

    Function("setItem") { (suite: String, key: String, value: String) in
      UserDefaults(suiteName: suite)?.set(value, forKey: key)
    }

    Function("removeItem") { (suite: String, key: String) in
      UserDefaults(suiteName: suite)?.removeObject(forKey: key)
    }
  }
}
