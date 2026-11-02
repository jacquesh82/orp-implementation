#!/usr/bin/env bash
#
# Rebuilds the Android app end to end: web bundles of apps/web (the app)
# and apps/lab (the bench) → Android app assets → APK → adb install.
#
#   ./rebuild.sh [<adb-serial>]     (default: 192.168.1.152:41387)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERIAL="${1:-192.168.1.152:41387}"
ADB="${ADB:-/opt/android-sdk/platform-tools/adb}"

for app in web:app lab:lab; do
  source="${app%%:*}"
  target="${app##*:}"
  (cd "$HERE/../$source" && pnpm exec vite build)
  mkdir -p "$HERE/app/src/main/assets/$target"
  rm -rf "$HERE/app/src/main/assets/$target"/*
  cp -r "$HERE/../$source/dist/"* "$HERE/app/src/main/assets/$target/"
done

cd "$HERE"

./gradlew assembleDebug

# Publication on the showcase site (/download/): the APK, its size and its
# digest. The showcase Dockerfile embeds this directory as is — a showcase
# image built BEFORE this script therefore offers no APK.
# The JSON keys (size, sha256, built) are read by apps/site/src/main.ts.
PUB="$HERE/../site/public/download"
mkdir -p "$PUB"
cp app/build/outputs/apk/debug/app-debug.apk "$PUB/optirelay.apk"
printf '{"size":%s,"sha256":"%s","built":"%s"}\n' \
  "$(stat -c %s "$PUB/optirelay.apk")" \
  "$(sha256sum "$PUB/optirelay.apk" | cut -d' ' -f1)" \
  "$(date +%F)" > "$PUB/optirelay.json"
"$ADB" connect "$SERIAL" >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s "$SERIAL" shell am force-stop fr.lelab.optirelay.lab
"$ADB" -s "$SERIAL" shell am start -n fr.lelab.optirelay.lab/.MainActivity
echo "bench restarted on $SERIAL"
