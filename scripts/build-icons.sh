#!/bin/sh
# Regenerates the checked-in icons from their sources. Run on a Mac with Xcode 26 or newer
# after editing a source; the build itself never runs it.
#   src-tauri/icons/icon.svg      -> the bundle.icon files (flat icon; Windows, macOS 15 and older)
#   src-tauri/icons/AppIcon.icon  -> src-tauri/icons/Assets.car (Liquid Glass icon, macOS 26+)
#   app/images/IconTemplate.svg   -> app/images/IconTemplate.png (menu bar template image)
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pnpm -s tauri icon src-tauri/icons/icon.svg -o "$tmp/app" >/dev/null
for file in 32x32.png 128x128.png 128x128@2x.png icon.icns icon.ico; do
  cp "$tmp/app/$file" src-tauri/icons/
done

pnpm -s tauri icon app/images/IconTemplate.svg -o "$tmp/tray" -p 36 >/dev/null
cp "$tmp/tray/36x36.png" app/images/IconTemplate.png

mkdir "$tmp/car"
xcrun actool src-tauri/icons/AppIcon.icon --compile "$tmp/car" --platform macosx \
  --minimum-deployment-target 13.5 --app-icon AppIcon --target-device mac \
  --output-partial-info-plist "$tmp/car/partial.plist" >/dev/null
cp "$tmp/car/Assets.car" src-tauri/icons/
