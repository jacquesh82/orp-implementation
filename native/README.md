# OptiRelay native (Rust + Slint)

THE OptiRelay Android app, in native Rust with a [Slint](https://slint.dev)
interface (and its desktop variant). Two functions only — **Receive** and
**Send** — with the security of OptiRelay Studio (`examples/studio`) built
in; the two talk to each other in both directions. Look aligned with the
showcase (`apps/site`): near-black ground, showcase blue, square corners,
dashed hairlines, Aspekta for text and IBM Plex Mono for uppercase labels and
codes (TTF converted unmodified from the showcase woff2, OFL licenses in
`optirelay/ui/fonts/`).

## Screens

| Screen | Role |
|---|---|
| Home | the two choices: Receive, Send |
| Receive / camera | live camera (NDK Camera2): grid outlines, framing advice, white balance + exposure lock, progress by blocks |
| Receive / code | type the sender's code, then compare the 6-digit verification code |
| Receive / file | received and verified file: preview, save to Downloads, share, delete |
| Send | file choice, TM4 (default) or TM8 |
| Send / transmitting | the animated grid, the code and the verification code as text below it |

## Security flow (same as OptiRelay Studio, `live.ts`)

**Send.** A 12-character code is drawn per sending from the system CSPRNG,
uniformly over `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (rejection sampling,
`orp_transfer::random_code`). It is the pairing passphrase
(`PairingMode::Passphrase`, encryption required) and is shown as TEXT,
grouped `XXXX-XXXX-XXXX`, next to the grid — never inside it — with the SAS
`123 456`. Loop: the init code (one R/P pair) then a data frame (two R/P
pairs), single grid, 250 ms per subframe.

**Receive.** The init code is read; a passphrase pairing makes the app ASK
FOR THE CODE (`typed_passphrase` normalisation: dashes, spaces, lower case),
stretched by PBKDF2 off the UI thread; the SAS is shown to compare with the
sender's. "They match" starts the reception; "they differ" asks the code
again. Three data frames refused as forged (none accepted) mean a wrong code:
the code is asked again (`Event::WrongCode`), and the frames read meanwhile
are kept and replayed. A sender in codes pairing (response/reveal, ORP v0.2)
is still supported: the response grid is shown, the sender's reveal code
gives the SAS.

## Running

```sh
# Desktop (phone-shaped window); OPTIRELAY_FILE=<path> picks the file to send
cargo run -p optirelay

# Screenshots of every screen, off-screen (software renderer)
cargo run -p optirelay --example captures -- /path/to/dir

# Replay a real video through the receiving pipeline (PC)
cargo run --release -p orp-transfer --example replay -- video.mp4 --code XXXX-XXXX-XXXX

# Tests (vectors, sessions, Studio ↔ native round trips)
cargo test --workspace

# Android (arm64) — rustup + aarch64-linux-android target + cargo-ndk:
# Rust library → jniLibs → Gradle APK (Kotlin host) → showcase download → adb
android/rebuild.sh [<adb-serial>]
adb logcat -s OptiRelay
```

## Android host

The APK is a Gradle project (`android/`): a `NativeActivity` (`MainActivity`)
loads `liboptirelay.so`. Everything is Rust (UI, protocol, camera through the
NDK); the Kotlin shim only keeps what needs an activity callback or the UI
thread: the camera permission (its answer), the file picker (its result),
saving to Downloads (MediaStore) and sharing (FileProvider + share sheet),
full brightness while sending (window attributes). The bridge is JNI
(`optirelay/src/android.rs`). Package `fr.lelab.optirelay.natif`.

## Crates

| Crate | Content |
|---|---|
| `orp-core` | frames (meta, Reed-Solomon, CRC), LT fountain, pairing, encryption (ECDH P-256, HKDF, AES-GCM, HMAC, PBKDF2), compression, session — byte-identical to `packages/core` (vectors `vectors/generate-core.ts`) |
| `orp-optics` | render, location, homography, TM4/TM8 subframes, receiver with averaging, mosaic, `TmPipeline` — bit-identical to `packages/optical` |
| `orp-transfer` | sender (Studio loop), receiver state machine (code to type, SAS, wrong code, new sending), random code, adaptive video reading (replay) |

Porting rule: each Rust module has its tests on the SAME vectors as its
TypeScript module (JSON files generated from `packages/*`); a one-byte
divergence is a failure.
