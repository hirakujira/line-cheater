#!/bin/zsh

set -euo pipefail

if [[ $# -ne 1 ]]; then
  print -u2 "Usage: $0 <keychain-label>"
  exit 2
fi

label="$1"

required_variables=(
  MACOS_CERTIFICATE_BASE64
  MACOS_SIGN_IDENTITY
)
for variable in "${required_variables[@]}"; do
  [[ -n "${(P)variable:-}" ]] || {
    print -u2 "Missing required signing variable: $variable"
    exit 1
  }
done

case "$MACOS_SIGN_IDENTITY" in
  "Developer ID Application:"*) ;;
  *)
    print -u2 "MACOS_SIGN_IDENTITY must be a Developer ID Application identity."
    exit 1
    ;;
esac

keychain_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
keychain_path="$keychain_root/line-cheater-signing-${label}.keychain-db"
certificate_path="$keychain_root/line-cheater-signing-${label}.p12"
keychain_password="$(/usr/bin/openssl rand -hex 32)"

cleanup() {
  /bin/rm -f "$certificate_path"
}
trap cleanup EXIT

printf '%s' "$MACOS_CERTIFICATE_BASE64" | /usr/bin/base64 -D > "$certificate_path"
/usr/bin/security create-keychain -p "$keychain_password" "$keychain_path"

# Publish the path as soon as the keychain exists so the workflow cleanup step
# still runs when a later import command fails.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    print "available=true"
    print "keychain_path=$keychain_path"
  } >> "$GITHUB_OUTPUT"
fi

/usr/bin/security set-keychain-settings -lut 21600 "$keychain_path"
/usr/bin/security unlock-keychain -p "$keychain_password" "$keychain_path"
/usr/bin/security import "$certificate_path" -k "$keychain_path" -P "" \
  -T /usr/bin/codesign -T /usr/bin/security
/usr/bin/security list-keychain -d user -s "$keychain_path"
/usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$keychain_password" "$keychain_path"

/usr/bin/security find-identity -v -p codesigning
/usr/bin/security find-identity -v -p codesigning | grep -F "$MACOS_SIGN_IDENTITY" >/dev/null

print "Imported the passwordless P12 into $keychain_path"
