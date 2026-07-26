#!/bin/zsh

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
electron_root="$(cd "$script_dir/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This script must run on macOS."
  exit 1
fi

case "$(uname -m)" in
  arm64) runner_arch="arm64" ;;
  x86_64) runner_arch="x64" ;;
  *)
    print -u2 "Unsupported macOS architecture: $(uname -m)"
    exit 1
    ;;
esac

arch="${MACOS_PACKAGE_ARCH:-$runner_arch}"
if [[ "$arch" != "$runner_arch" ]]; then
  print -u2 "Runner architecture is $runner_arch, expected $arch"
  exit 1
fi

version="${MACOS_PACKAGE_VERSION:-}"
if [[ -z "$version" ]]; then
  version="$(node -p 'require(process.argv[1]).version' "$electron_root/package.json")"
fi

checksum_file="${MACOS_CHECKSUM_FILE:-SHA256SUMS.txt}"
dist_root="$electron_root/dist"
artifact_base="LINE-Cheater-${version}-macOS-${arch}"
app_path="$dist_root/mac-${arch}/LINE Cheater.app"
sidecar_path="$app_path/Contents/Resources/bin/line-cheater"
dmg_name="${artifact_base}.dmg"
zip_name="${artifact_base}.zip"

[[ -d "$app_path" ]] || { print -u2 "App bundle is missing: $app_path"; exit 1; }
[[ -f "$dist_root/$dmg_name" ]] || { print -u2 "DMG is missing: $dist_root/$dmg_name"; exit 1; }
[[ -f "$dist_root/$zip_name" ]] || { print -u2 "ZIP is missing: $dist_root/$zip_name"; exit 1; }
[[ -f "$dist_root/$checksum_file" ]] || {
  print -u2 "Checksum file is missing: $dist_root/$checksum_file"
  exit 1
}

/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"

if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  signature_details="$(/usr/bin/codesign -dvvv "$app_path" 2>&1)"
  print -r -- "$signature_details"
  print -r -- "$signature_details" | grep -F "Authority=$MACOS_SIGN_IDENTITY" >/dev/null
  print -r -- "$signature_details" | grep -F "Runtime Version=" >/dev/null
  print -r -- "$signature_details" | grep -E "Signed Time=|Timestamp=" >/dev/null
fi

"$sidecar_path" --version

grep -F "  $dmg_name" "$dist_root/$checksum_file" >/dev/null
grep -F "  $zip_name" "$dist_root/$checksum_file" >/dev/null
(
  cd "$dist_root"
  /usr/bin/shasum -a 256 -c "$checksum_file"
)

/usr/bin/hdiutil verify "$dist_root/$dmg_name"

if [[ "${MACOS_VERIFY_GATEKEEPER:-0}" == "1" ]]; then
  /usr/sbin/spctl --assess --type execute --verbose=4 "$app_path" ||
    print "spctl did not accept the app; this is expected before notarization."
fi

print "Package verification passed:"
print "  $app_path"
print "  $dist_root/$dmg_name"
print "  $dist_root/$zip_name"
print "  $dist_root/$checksum_file"
