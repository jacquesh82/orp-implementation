# ORP — Reference implementations

Reference implementations of the **Optical Relay Protocol (ORP) v0.1**: a
framework-free TypeScript SDK, a bit-exact Rust port, reference applications, and a
third-party blind-test implementation in Python.

Specifications and frozen interoperability vectors live in the companion repository
[`orp-specs`](https://github.com/jacquesh82/orp-specs) — they are the single judge of
conformance (`third-party/orp-python` replays checklist §10.4, items 1–9: 2 414 cases).

## Layout

| Path | What it is |
|---|---|
| `packages/core` | `@optirelay/core` — sessions, ECDH P-256 / HKDF-SHA-256 / AES-256-GCM, segmentation + fountain codes, replay protection |
| `packages/optical` | `@optirelay/optical` — MONO_2 / COLOR_4 / COLOR_8 codecs, calibration, decoding, temporal modulation TM4/TM8 |
| `packages/browser` | `@optirelay/browser` — camera, screen rendering, Workers |
| `packages/elements` | `@optirelay/elements` — Web Components (`<optirelay-send>`, `<optirelay-receive>`, …) |
| `apps/web` | Reference PWA, built only on the public packages |
| `apps/lab` | In-browser test bench |
| `apps/site` | Product website, bundling the PWA, the bench and the Android APK |
| `apps/android-lab` | Android bench host (screen + camera, real device) |
| `native/` | Rust port (`orp-core`, `orp-optics`, `orp-transfer`) — bit-exact against the TS vectors — plus the Android native app |
| `third-party/orp-python/` | Independent Python implementation written against the specification and vectors only |

## Development

```bash
pnpm install
pnpm test        # all TypeScript packages (118 tests)
pnpm typecheck   # strict TypeScript, no DOM in core/optical
cd native && cargo test
python3 -I third-party/orp-python/verify.py ../orp-specs vectors path
```

The Python verifier expects the vector files from `orp-specs` (`vectors/reference/*.json`).

## Versioning

This release tracks wire version **(0, 1)** of the protocol. The wire version is
independent of the SDK distribution versioning.

## License

All code in this repository is licensed under **Apache 2.0** (see
[LICENSE](LICENSE)). The specification documents in `orp-specs` are licensed under
CC BY 4.0.
