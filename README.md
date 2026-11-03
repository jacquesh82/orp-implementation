# ORP — Reference implementations

Reference implementations of the **Optical Relay Protocol (ORP) v0.2**: a
framework-free TypeScript SDK, a bit-exact Rust port, reference applications, and a
third-party blind-test implementation in Python.

v0.2 hardens the pairing: commit/reveal with a 6-digit SAS displayed on both screens,
session keys bound to the pairing transcript, and a PBKDF2-stretched passphrase.
Pairing codes carry the wire version (`0x02`); a v0.1 code is refused, never decoded
approximately.

The protocol specification and the frozen interoperability vectors of the original
v0.1 exercise live in the companion repository
[`orp-specs`](https://github.com/jacquesh82/orp-specs) (CC BY 4.0).
`third-party/orp-python` was written against that set only — checklist §10.4,
items 1–9: 2 414 cases replayed without divergence. The vectors that freeze the
current v0.2 behavior are generated under `native/vectors`; the Rust port is
bit-exact against them.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | `@optirelay/core` — sessions, commit/reveal pairing, ECDH P-256 / HKDF-SHA-256 / AES-256-GCM, segmentation + fountain codes, replay protection |
| `packages/optical` | `@optirelay/optical` — MONO_2 / COLOR_4 / COLOR_8 codecs, calibration, decoding, temporal modulation TM4/TM8 |
| `packages/browser` | `@optirelay/browser` — camera, screen rendering, Workers |
| `packages/elements` | `@optirelay/elements` — Web Components (`<optirelay-send>`, `<optirelay-receive>`, …) |
| `apps/web` | Reference PWA, built only on the public packages |
| `apps/lab` | In-browser test bench |
| `apps/site` | Product website, bundling the PWA, the Studio and the Android APK |
| `examples/` | *OptiRelay Studio*, *Hello world* and *Secure hello world* — example applications on the published npm packages |
| `native/` | Rust port (`orp-core`, `orp-optics`, `orp-transfer`) — bit-exact against the TS vectors — plus the Android native app (Rust/Slint) |
| `third-party/orp-python/` | Independent Python implementation written against the v0.1 specification and vectors only (blind test) |

## Development

```bash
pnpm install
pnpm test        # all TypeScript packages (140 tests)
pnpm typecheck   # strict TypeScript, no DOM in core/optical
cd native && cargo test
python3 -I third-party/orp-python/verify.py ../orp-specs vectors path
```

The Python verifier expects the vector files from `orp-specs` (`vectors/reference/*.json`).

## Versioning

This release tracks wire version **(0, 2)** of the protocol. The wire version is
independent of the SDK distribution versioning (`@optirelay/core` 0.2.1,
`@optirelay/optical` 0.2.2 and `@optirelay/browser` 0.2.3 are published on npm).

## License

All code in this repository is licensed under **Apache 2.0** (see
[LICENSE](LICENSE)). The specification documents in `orp-specs` are licensed under
CC BY 4.0.
