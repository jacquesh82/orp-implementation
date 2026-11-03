# ORP v0.1 — blind third-party implementation (Python)

Exercise of the **implementation guide** (§10 of the ORP v0.1 draft): play the role of
the third-party developer who has read **neither the TypeScript reference code nor its
Rust port**. The implementation was written from the v0.1 memo (`draft-orp-v0.1.md` in
[`orp-specs`](https://github.com/jacquesh82/orp-specs)) and `native/vectors/core/*.json`
only; the vectors are the sole arbiter.

## Result

**Checklist §10.4, items 1 to 9: green** — 2,414 cases replayed without divergence:

| item | domain | cases |
|---|---|---|
| 1 | CRC-32 | 10 |
| 2 | mulberry32 PRNG | 576 |
| 3 | Frame (meta, body, segments) | 165 |
| 4 | Reed-Solomon | 103 |
| 5 | Splitting into blocks | 7 |
| 6 | Fountain | 1,395 |
| 7 | Cryptographic primitives | 25 |
| 8 | Pairing and compression | 30 |
| 9 | Complete sessions | 5 end-to-end scenarios |

Item 10 (optical layer) requires real hardware — out of the scope of this exercise (B-4).

## Update to ORP v0.2 (2026-11-02)

The package now replays the **v0.2** vectors (`docs/orp-protocol-v0.2.md`): typed and
versioned pairing codes (init 97 B with a commitment to the sender key, response 83 B,
reveal 83 B), keys and SAS derived with salt = transcript hash, passphrase stretched by
PBKDF2-HMAC-SHA-256 (600,000 iterations, `hashlib.pbkdf2_hmac`), encryption announced by
the init code and enforced on every frame, frames checked against the announced block
layout. The passphrase minimum is now counted in UTF-16 code units, as the specification
says (finding I-2 below is closed by §7.2 of v0.2). The findings log below is the one of
the original v0.1 exercise.

## Replaying

```bash
python3 -I verify.py ../../native/vectors/core
```

Dependency: `cryptography` (ECDH P-256, HKDF, AES-256-GCM). Everything else is in the
standard library. The code is organized by layer (`orp/primitives.py`, `rs.py`,
`frames.py`, `fountain.py`, `blocks.py`, `encryption.py`, `compression.py`, `pairing.py`,
`session.py`) in the reading order of guide §10.2. The frozen protocol values (error
codes such as `trame-invalide`, rejection reasons such as `rejeu`, the `ORP v0.1 …` KDF
labels) stay byte-identical, hence in French.

## Findings log

Every divergence between the memo and the vectors is a defect **of the document**, never
of the reader. Findings to carry into the editorial pass (see also `docs/rfc/BLOCKERS.md`,
section 6):

- **I-1 (major) — `correction-impossible` does not exist at the frame reader level.**
  §5.3 of the memo says "the frame MUST be rejected with the code `correction-impossible`",
  but the 99 `reads` of `frames.json` never expect that code: an uncorrectable segment
  actually goes through the CRC-32 net on the raw data and produces `trame-corrompue`.
  The code belongs to the session (erasure for the fountain), not to the reader. Clarify
  §5.3 and §7.6.
- **I-2 (medium) — the minimum passphrase length is counted in UTF-8 bytes.**
  §7.4.5 says "at least 8 characters"; the vectors accept `😀😀😀😀` (4 characters,
  16 UTF-8 bytes) and reject `short` (5 bytes). Write "at least 8 UTF-8 bytes".
- **I-3 (medium) — Gauss-Jordan completion is de facto required by the vectors.**
  §6.8 leaves Gauss-Jordan completion as a MAY ("nothing changes on the wire"), but the
  `progress`/`complete` triples of `fountain.json` are only reached at the same rank by a
  decoder that applies it (elimination alone completes the K = 63 block at step 74
  instead of the expected 69). A third party faithful to peeling alone fails against the
  vectors: guide §10.4 item 6 must say so.
- **I-4 (info) — deflate of the reference: level 6 (Node default).** The size of the
  compressed stream is part of the announcement (`stream_size`, u64 of the init code):
  for the compressed sessions of `sessions.json`, the byte-exact deflate output is not
  free — the "MAY produce a different representation" of guide §10.3.4 does not hold for
  these scenarios. Note it (level 6, zlib/Node deflate).
- **I-5 (info) — the fountain seed counter starts at 1** (finding D-20 of the log:
  "not constrained" by the protocol; the session vectors fix it at 1, advanced by
  `symbol_count` per frame, globally across passes and blocks).
- **I-6 (info) — `sas` is a 6-digit string** (leading zeros kept, e.g. `"099615"`) in
  the vectors — consistent with the display of §7.4.6, to be stated explicitly for the
  conformance suites.
- **I-7 (info) — `*PublicKey` fields of the standalone codes** (`initCodes`,
  `responseCodes`): raw pseudo-random bytes, not an EC point — these vectors test the
  encoding of the code, not the cryptography (the sessions, for their part, carry the
  real `0x04‖X‖Y` point).
- **I-8 (info) — silent u16 overflow**: case 2 of `initCodes` (stream of 2⁴⁰+5 bytes,
  impossible to announce) carries `blockCount`/`kTotal` = 70000 in the JSON, but the bytes
  on the wire are 70000 mod 65,536 — the generator truncates. The u16 encoding of §7.4.2
  is respected; the impossibility of the case is consistent with the format bound of §6.3.

## Sending model confirmed by the vectors

The memo leaves open choices that the vectors freeze (useful to a third party):
round-robin **per frame** over the active blocks with a budget of K symbols per block and
per pass; `symbol_count` = min(codec maximum, remainder of the block); global seed counter
starting at 1, advanced by `symbol_count` per frame; codec fallback stuck from frame
`fallback.after` onwards; COMPRESSE flag carried by every data frame of a compressed
session; encryption is a session policy (`encryption: required`), not the presence of keys.
