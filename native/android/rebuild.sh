#!/usr/bin/env bash
#
# Rebuilds the OptiRelay Android app (native, Rust + Slint): Rust library
# (native/optirelay, arm64) → jniLibs → Gradle APK (Kotlin host) → APK
# published on the showcase (apps/site/public/download) → adb install.
#
#   ./rebuild.sh [<adb-serial>]     (no serial: build and publish only)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERIAL="${1:-}"
ADB="${ADB:-/opt/android-sdk/platform-tools/adb}"
export PATH="$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"
export ANDROID_JAR="${ANDROID_JAR:-$ANDROID_HOME/platforms/android-35/android.jar}"

(cd "$HERE/.." && cargo ndk -t arm64-v8a --platform 29 -o "$HERE/app/src/main/jniLibs" build --release -p optirelay --lib)

cd "$HERE"
./gradlew --quiet assembleDebug

# Publication on the showcase site (/download/): the APK, its size and its
# digest. The showcase Dockerfile embeds this directory as is — a showcase
# image built BEFORE this script offers the previous APK.
# The JSON keys (size, sha256, built) are read by apps/site/src/main.ts.
PUB="$HERE/../../apps/site/public/download"
mkdir -p "$PUB"
cp app/build/outputs/apk/debug/app-debug.apk "$PUB/optirelay.apk"
printf '{"size":%s,"sha256":"%s","built":"%s"}\n' \
  "$(stat -c %s "$PUB/optirelay.apk")" \
  "$(sha256sum "$PUB/optirelay.apk" | cut -d' ' -f1)" \
  "$(date +%F)" > "$PUB/optirelay.json"

[ -n "$SERIAL" ] || { echo "APK built and published (no adb serial: not installed)"; exit 0; }
"$ADB" connect "$SERIAL" >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s "$SERIAL" shell am force-stop fr.lelab.optirelay.natif
"$ADB" -s "$SERIAL" shell am start -n fr.lelab.optirelay.natif/.MainActivity
echo "native OptiRelay restarted on $SERIAL"
