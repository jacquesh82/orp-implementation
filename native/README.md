# OptiRelay native (Rust + Slint)

The OptiRelay Android app, rewritten in native Rust with a
[Slint](https://slint.dev) interface, after the Material 3 mock-up
(<https://claude.ai/artifact/Kds363gGaS7dz38xqfapv6>). It will replace the
WebView APK (`apps/android-lab`). The ORP protocol stays the same, byte for
byte: the web test bench (`apps/lab`) and this app talk to each other.

## Running

```sh
# Desktop (phone-shaped window)
cargo run -p optirelay

# Screenshots of every screen, off-screen (visual check)
cargo run -p optirelay --example captures -- /path/to/dir

# Replay a real video through the native receiving pipeline (PC);
# --all-images analyzes every image
cargo run --release -p orp-transfer --example replay -- video.mp4 [--all-images]

# Synthetic calibration series (calibration check)
cargo run --release -p orp-transfer --example calibration_series \
  | ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i - series.mp4

# Other examples: block_simulation, overhead_fountain, overhead_pattern, diag

# Android (S25: arm64) — rustup + aarch64-linux-android target + cargo-ndk:
# Rust library → jniLibs → Gradle APK (Kotlin host) → adb
android/rebuild.sh <adb-serial>

# Tests without filming or picking (files already in the app cache)
adb shell am start -n fr.lelab.optirelay.natif/.MainActivity \
    --es video /data/user/0/fr.lelab.optirelay.natif/cache/slowmotion/sample.mp4
#   --es calibration <series video>   --es send <file to send>
adb logcat -s OptiRelay
```

The APK is a Gradle project (`android/`): a `NativeActivity` (Kotlin,
`MainActivity`) loads `liboptirelay.so` and only does what the Java API alone
offers — slow-motion filming in a high-speed session (`SlowMotionActivity`,
taken from the bench), camera permission, system bar colors. The bridge is
JNI (`optirelay/src/android.rs`).

Android package `fr.lelab.optirelay.natif`: it installs next to the WebView
app without replacing it.

## Port, step by step

| Step | Content | Status |
|---|---|---|
| P0 | Slint interface: 8 screens, bottom bar, menu, back key, safe areas | done |
| P1 | `orp-core`: frames (meta, Reed-Solomon, CRC), LT fountain, pairing, encryption (ECDH P-256, HKDF, AES-GCM, HMAC), compression, session — checked against vectors produced by `packages/core` (`vectors/generate-core.ts`) | done: 37 tests, byte-identical, full sessions included |
| P2 | `orp-optics`: render, location, homography, TM4/TM8 subframes, receiver with averaging, mosaic, `TmPipeline` — vectors from `packages/optical` (`vectors/generate-optics.ts`) | done: 44 tests, bit-identical; replay of the real 1-grid video = TS (156 frames, file at 16.33 s) |
| P3 | Android: Gradle host + JNI, 240 fps slow motion, video decoding (MediaCodec, 620 fps), live camera (Camera2 NDK) with grid outlines, smoothed advice and white balance + exposure lock, permission, system bars, saving and sharing | done; live camera not yet checked against a sender; filmed image of the code in slow motion to do |
| P4 | `orp-transfer` (reception, passphrase pairing AND strong mode on the receiving side, adaptive reading, stop if the code is not read, sending); full-screen sending; preview; log | done; strong mode on the native sending side (reading the response with the camera) to do |
| P5 | Calibration: reading the bench series, per-trial measurement, recommendation, short code, send settings | done; checked on a synthetic series, not yet filmed on a real screen |

Porting rule: each Rust module has its tests on the SAME vectors as its
TypeScript module (JSON files generated from `packages/*`); a one-byte
divergence is a failure.
