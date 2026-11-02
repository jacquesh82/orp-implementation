#!/usr/bin/env bash
#
# Rebuilds the native application: Rust library (native/optirelay, arm64)
# → jniLibs → Gradle APK (Kotlin host) → adb install.
#
#   ./rebuild.sh <adb-serial>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERIAL="${1:?adb serial expected}"
ADB="${ADB:-/opt/android-sdk/platform-tools/adb}"
export PATH="$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"
export ANDROID_JAR="${ANDROID_JAR:-$ANDROID_HOME/platforms/android-35/android.jar}"

(cd "$HERE/.." && cargo ndk -t arm64-v8a --platform 29 -o "$HERE/app/src/main/jniLibs" build --release -p optirelay --lib)

cd "$HERE"
./gradlew --quiet assembleDebug

"$ADB" -s "$SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s "$SERIAL" shell am force-stop fr.lelab.optirelay.natif
"$ADB" -s "$SERIAL" shell am start -n fr.lelab.optirelay.natif/.MainActivity
echo "native OptiRelay restarted on $SERIAL"
