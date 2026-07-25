#!/bin/zsh

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
electron_root="$(cd "$script_dir/.." && pwd)"
repository_root="$(cd "$electron_root/../.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This script must run on macOS."
  exit 1
fi

case "$(uname -m)" in
  arm64) artifact_arch="arm64" ;;
  x86_64) artifact_arch="x64" ;;
  *)
    print -u2 "Unsupported macOS architecture: $(uname -m)"
    exit 1
    ;;
esac

expected_arch="${MACOS_PACKAGE_ARCH:-$artifact_arch}"
case "$expected_arch" in
  arm64|x64) ;;
  *)
    print -u2 "Unsupported expected macOS architecture: $expected_arch"
    exit 1
    ;;
esac
if [[ "$expected_arch" != "$artifact_arch" ]]; then
  print -u2 "Runner architecture is $artifact_arch, expected $expected_arch"
  exit 1
fi

if [[ "${SKIP_NPM_CI:-0}" != "1" ]]; then
  npm --prefix "$electron_root" ci
fi

electron_app="$electron_root/node_modules/electron/dist/Electron.app"
electron_installer="$electron_root/node_modules/electron/install.js"
if [[ ! -d "$electron_app" ]]; then
  [[ -f "$electron_installer" ]] || {
    print -u2 "Electron installer is missing: $electron_installer"
    exit 1
  }
  node "$electron_installer"
fi

if [[ "${SKIP_NPM_TEST:-0}" == "1" ]]; then
  # Common Rust/Electron checks run once in the workflow; retain the native
  # release build and package verification on every architecture runner.
  npm --prefix "$electron_root" run build:native:mac
  node "$electron_root/scripts/package-macos.cjs"
else
  npm --prefix "$electron_root" run package:mac
fi

version="$(node -p 'require(process.argv[1]).version' "$electron_root/package.json")"
dist_root="$electron_root/dist"
artifact_base="LINE-Cheater-${version}-macOS-${artifact_arch}"
dmg_path="$dist_root/${artifact_base}.dmg"
app_path="$dist_root/mac-${artifact_arch}/LINE Cheater.app"
mount_point="$(mktemp -d "${TMPDIR:-/tmp}/line-cheater-dmg.XXXXXX")"
mounted=0

cleanup() {
  if [[ "$mounted" == "1" ]]; then
    /usr/bin/hdiutil detach "$mount_point" -quiet || true
  fi
  rmdir "$mount_point" 2>/dev/null || true
}
trap cleanup EXIT

[[ -f "$dmg_path" ]] || { print -u2 "DMG was not created: $dmg_path"; exit 1; }
[[ -d "$app_path" ]] || { print -u2 "App bundle was not created: $app_path"; exit 1; }

/usr/bin/hdiutil verify "$dmg_path"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"

/usr/bin/hdiutil attach "$dmg_path" \
  -readonly \
  -nobrowse \
  -mountpoint "$mount_point" \
  >/dev/null
mounted=1

mounted_app="$mount_point/LINE Cheater.app"
mounted_sidecar="$mounted_app/Contents/Resources/bin/line-cheater"
[[ -d "$mounted_app" ]] || { print -u2 "Mounted DMG does not contain LINE Cheater.app"; exit 1; }
[[ -x "$mounted_sidecar" ]] || { print -u2 "Mounted DMG sidecar is missing or not executable"; exit 1; }

"$mounted_sidecar" --version >/dev/null

print "DMG verification passed:"
print "  $dmg_path"
print "  $mounted_app"
print "  $mounted_sidecar"
