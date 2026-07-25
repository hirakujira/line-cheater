#!/bin/zsh

set -euo pipefail

if [[ $# -ne 1 ]]; then
  print -u2 "Usage: $0 path/to/application.dmg"
  exit 2
fi

dmg_path="$1"
[[ -f "$dmg_path" ]] || {
  print -u2 "DMG does not exist: $dmg_path"
  exit 1
}

required_variables=(
  MACOS_NOTARY_APPLE_ID
  MACOS_NOTARY_TEAM_ID
  MACOS_NOTARY_APP_SPECIFIC_PASSWORD
)
for variable in "${required_variables[@]}"; do
  [[ -n "${(P)variable:-}" ]] || {
    print -u2 "Missing required notarization variable: $variable"
    exit 1
  }
done

profile="${MACOS_NOTARY_PROFILE:-line-cheater-notary}"
keychain_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
keychain_path="$keychain_root/line-cheater-notary.keychain-db"
keychain_password="$(/usr/bin/openssl rand -hex 32)"
submission_output="$keychain_root/line-cheater-notary-result.json"
keychain_created=0

cleanup() {
  if [[ "$keychain_created" == "1" ]]; then
    /usr/bin/security delete-keychain "$keychain_path" || true
  fi
  /bin/rm -f "$submission_output"
}
trap cleanup EXIT

/usr/bin/security create-keychain -p "$keychain_password" "$keychain_path"
keychain_created=1
/usr/bin/security set-keychain-settings -lut 21600 "$keychain_path"
/usr/bin/security unlock-keychain -p "$keychain_password" "$keychain_path"

/usr/bin/xcrun notarytool store-credentials "$profile" \
  --keychain "$keychain_path" \
  --apple-id "$MACOS_NOTARY_APPLE_ID" \
  --team-id "$MACOS_NOTARY_TEAM_ID" \
  --password "$MACOS_NOTARY_APP_SPECIFIC_PASSWORD"

if ! /usr/bin/xcrun notarytool submit "$dmg_path" \
  --keychain-profile "$profile" \
  --keychain "$keychain_path" \
  --wait \
  --timeout "${MACOS_NOTARY_TIMEOUT:-2h}" \
  --output-format json > "$submission_output"; then
  /bin/cat "$submission_output"
  exit 1
fi
/bin/cat "$submission_output"

/usr/bin/xcrun stapler staple "$dmg_path"
/usr/bin/xcrun stapler validate "$dmg_path"

print "Notarization and ticket stapling passed:"
print "  $dmg_path"
