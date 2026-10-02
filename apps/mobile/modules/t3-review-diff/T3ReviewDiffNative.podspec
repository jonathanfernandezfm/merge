require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3ReviewDiffNative'
  s.version = package['version']
  s.summary = 'Native review diff debug surface for Merge mobile.'
  s.description = 'Native iOS review diff renderer used to prototype fast mobile review scrolling.'
  s.homepage = 'https://github.com/jonathanfernandezfm/merge'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'Jonathan Fernandez Mertanen' => 'jonathanfernandezfm@gmail.com' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks = 'CoreGraphics', 'UIKit'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
