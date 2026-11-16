Pod::Spec.new do |s|
  s.name           = 'SharedStorage'
  s.version        = '0.1.0'
  s.summary        = 'App Group UserDefaults key-value storage (main app <-> share extension)'
  s.description    = s.summary
  s.author         = ''
  s.homepage       = 'https://github.com/inak/moaring-app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
