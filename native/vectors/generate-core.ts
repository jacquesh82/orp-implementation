/**
 * Reference vectors of `packages/core` for the Rust port `orp-core`.
 *
 * Run from the repository root:
 *   node node_modules/.pnpm/vite-node@2.1.9/node_modules/vite-node/vite-node.mjs native/vectors/generate-core.ts
 *
 * Writes JSON files into native/vectors/core/ (bytes as hexadecimal).
 * Everything is deterministic: the cryptographic randomness is replaced by a
 * mulberry32 stream (byte = ⌊draw × 256⌋), and an ECDH pair is DRAWN from
 * that stream (32 bytes = private scalar) — `orp-core` does exactly the same
 * with its `MulberryRandom`, so both implementations produce the same
 * session_id, public keys, commitments, transcripts… and therefore the same
 * SAS and the same frames.
 */

import { createECDH } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEC,
  CryptoWebCrypto,
  FLAG,
  FountainDecoder,
  SenderSession,
  ReceiverSession,
  FRAME_VERSION,
  compress,
  buildFrame,
  rsCorrect,
  crc32,
  decompress,
  deriveKeys,
  deriveKeysFromPassphrase,
  deriveSecretFromPassphrase,
  commitmentOf,
  transcriptHash,
  expectedLayout,
  writeInitCode,
  writeResponseCode,
  writeRevealCode,
  readResponseCode,
  readRevealCode,
  tokenOf,
  readInitCode,
  readFrame,
  mulberry32,
  frameNonce,
  OrpError,
  rsParity,
  planBlocks,
  fountainSymbol,
  ltNeighbors,
  type Codec,
  type FrameHeader,
  type EcdhKeyPair,
  type FrameStatus,
} from "../../packages/core/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, "core");
mkdirSync(OUTPUT, { recursive: true });

const hex = (o: Uint8Array): string => Buffer.from(o).toString("hex");
const hexToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const b64url = (o: Uint8Array): string => Buffer.from(o).toString("base64url");

function write(name: string, data: unknown): void {
  writeFileSync(join(OUTPUT, name), JSON.stringify(data, null, 1) + "\n");
  console.log(`wrote ${name}`);
}

/** Reproducible pseudo-random bytes (same rule as MulberryRandom in Rust). */
function bytes(seed: number, n: number): Uint8Array {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
}

function errorCode(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof OrpError ? e.code : "error";
  }
}

/** WebCrypto provider whose randomness (and therefore ECDH pairs) is reproducible. */
class DeterministicCrypto extends CryptoWebCrypto {
  private readonly rng: () => number;
  constructor(seed: number) {
    super();
    this.rng = mulberry32(seed);
  }
  override randomBytes(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, () => Math.floor(this.rng() * 256));
  }
  override async generateEcdhKeyPair(): Promise<EcdhKeyPair> {
    const d = this.randomBytes(32);
    return keyPairFromScalar(d);
  }
}

async function keyPairFromScalar(d: Uint8Array): Promise<EcdhKeyPair> {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = new Uint8Array(ecdh.getPublicKey());
  const privateKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { privateKey, publicKey: pub };
}

const webcrypto = new CryptoWebCrypto();

// ── CRC-32 ──────────────────────────────────────────────────────────────

{
  const cases = [new TextEncoder().encode("123456789"), new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0xff])];
  for (const n of [1, 7, 96, 255, 1000, 4099]) cases.push(bytes(n, n));
  write("crc32.json", cases.map((d) => ({ data: hex(d), crc: crc32(d) })));
}

// ── mulberry32 ──────────────────────────────────────────────────────────

{
  const seeds = [0, 1, 42, 1234, 20261031, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff];
  write(
    "mulberry32.json",
    seeds.map((g) => {
      const rng = mulberry32(g);
      // Draw × 2³² is an exact integer: no float in the JSON.
      return { seed: g, integers: Array.from({ length: 64 }, () => rng() * 4294967296) };
    }),
  );
}

// ── Reed-Solomon ────────────────────────────────────────────────────────

{
  const parities = [0, 1, 5, 14, 100, 246, 247].map((n) => {
    const m = bytes(1000 + n, n);
    return { message: hex(m), parity: hex(rsParity(m)) };
  });
  const corrections: { damaged: string; result: string | null }[] = [];
  const rng = mulberry32(555);
  for (const length of [20, 120, 255]) {
    const m = bytes(2000 + length, length - 8);
    const encoded = new Uint8Array(length);
    encoded.set(m, 0);
    encoded.set(rsParity(m), m.length);
    for (let count = 0; count <= 7; count++) {
      for (let trial = 0; trial < 4; trial++) {
        const damaged = encoded.slice();
        const positions = new Set<number>();
        while (positions.size < count) positions.add(Math.floor(rng() * length));
        for (const p of positions) damaged[p] = damaged[p]! ^ (1 + Math.floor(rng() * 255));
        const copy = damaged.slice();
        let result: string | null;
        try {
          rsCorrect(copy);
          result = hex(copy);
        } catch {
          result = null;
        }
        corrections.push({ damaged: hex(damaged), result });
      }
    }
  }
  write("rs.json", { parities, corrections });
}

// ── Frames ──────────────────────────────────────────────────────────────

{
  const built: unknown[] = [];
  let n = 0;
  for (const codec of [CODEC.MONO_2, CODEC.COLOR_4, CODEC.COLOR_8]) {
    for (let symbolCount = 1; symbolCount <= 4; symbolCount++) {
      for (const flags of [0, FLAG.ENCRYPTED, FLAG.COMPRESSED | FLAG.ENCRYPTED, FLAG.TEST_PATTERN, FLAG.PAIRING | FLAG.COMPRESSED]) {
        n++;
        const encrypted = (flags & FLAG.ENCRYPTED) !== 0;
        const header: FrameHeader = {
          version: FRAME_VERSION,
          codec,
          flags,
          token: (0x9e3779b9 * n) >>> 0,
          block: n * 3,
          k: 1 + ((n * 97) % 1024),
          symbolCount,
          seed: (0xfffffff0 + n * 5) >>> 0,
        };
        const payload = bytes(3000 + n, symbolCount * 96);
        const tag = encrypted ? bytes(4000 + n, 16) : undefined;
        built.push({
          header: { ...header, codec: header.codec as number },
          payload: hex(payload),
          tag: tag ? hex(tag) : null,
          frame: hex(buildFrame(header, payload, tag)),
        });
      }
    }
  }
  // Refusals at build time (expected error code).
  const base: FrameHeader = { version: FRAME_VERSION, codec: CODEC.COLOR_4, flags: 0, token: 1, block: 0, k: 10, symbolCount: 1, seed: 1 };
  const c96 = new Uint8Array(96);
  const refusals = [
    { header: { ...base, flags: FLAG.ENCRYPTED }, payload: c96, tag: undefined },
    { header: base, payload: c96, tag: new Uint8Array(16) },
    { header: base, payload: new Uint8Array(95), tag: undefined },
    { header: { ...base, k: 0 }, payload: c96, tag: undefined },
    { header: { ...base, k: 1025 }, payload: c96, tag: undefined },
    { header: { ...base, flags: 0x80 }, payload: c96, tag: undefined },
  ].map(({ header, payload, tag }) => ({
    header: { ...header, codec: header.codec as number },
    payload: hex(payload),
    tag: tag ? hex(tag) : null,
    error: errorCode(() => buildFrame(header, payload, tag)),
  }));

  // Reads of damaged frames: exact result or error code.
  const reads: unknown[] = [];
  const rng = mulberry32(777);
  const templates = [
    buildFrame({ ...base, codec: CODEC.COLOR_8, symbolCount: 4, flags: FLAG.ENCRYPTED, k: 300, block: 7, seed: 99 }, bytes(5, 384), bytes(6, 16)),
    buildFrame({ ...base, codec: CODEC.MONO_2, symbolCount: 1, k: 1024, token: 0xcafebabe }, bytes(7, 96)),
    buildFrame({ ...base, codec: CODEC.COLOR_4, symbolCount: 2, flags: FLAG.COMPRESSED }, bytes(8, 192)),
  ];
  const read = (raw: Uint8Array) => {
    try {
      const l = readFrame(raw);
      return {
        header: { ...l.header, codec: l.header.codec as number },
        payload: hex(l.payload),
        tag: l.tag ? hex(l.tag) : null,
        error: null,
      };
    } catch (e) {
      return { error: e instanceof OrpError ? e.code : "error" };
    }
  };
  for (const template of templates) {
    reads.push({ raw: hex(template), ...read(template) });
    const withPadding = new Uint8Array(template.length + 37);
    withPadding.set(template);
    reads.push({ raw: hex(withPadding), ...read(withPadding) });
    reads.push({ raw: hex(template.subarray(0, template.length - 1)), ...read(template.subarray(0, template.length - 1)) });
    reads.push({ raw: hex(template.subarray(0, 10)), ...read(template.subarray(0, 10)) });
    for (const errorCount of [1, 3, 4, 5, 6, 10, 20]) {
      for (let trial = 0; trial < 3; trial++) {
        const damaged = template.slice();
        for (let i = 0; i < errorCount; i++) {
          // Errors in the body as well as in the meta.
          const p = Math.floor(rng() * damaged.length);
          damaged[p] = damaged[p]! ^ (1 + Math.floor(rng() * 255));
        }
        reads.push({ raw: hex(damaged), ...read(damaged) });
      }
    }
    // Meta: one damaged copy, three diverging copies, magic, codec, flags, symbol_count.
    const variants: [number, number][][] = [
      [[1, 0xff]],
      [[1, 0x11], [9, 0x22], [17, 0x33]],
      [[0, 0], [8, 0], [16, 0]],
      [[4, 7], [12, 7], [20, 7]],
      [[5, 0x80], [13, 0x80], [21, 0x80]],
      [[6, 0], [14, 0], [22, 0]],
      [[6, 5], [14, 5], [22, 5]],
      [[2, 1], [10, 1], [18, 1]],
    ];
    for (const v of variants) {
      const damaged = template.slice();
      for (const [p, val] of v) damaged[p] = val;
      reads.push({ raw: hex(damaged), ...read(damaged) });
    }
  }
  write("frames.json", { built, refusals, reads });
}

// ── Fountain ────────────────────────────────────────────────────────────

{
  const neighbors: { k: number; seed: number; neighbors: number[] }[] = [];
  for (let k = 1; k <= 1024; k++) {
    const seeds = k <= 64 || k % 37 === 0 || k === 1024 ? [1, 2, 3, 1000 + k, 0xffffffff] : [k];
    for (const g of seeds) neighbors.push({ k, seed: g, neighbors: Array.from(ltNeighbors(k, g)) });
  }
  const symbols = [1, 5, 63, 200].map((k) => {
    const sources = Array.from({ length: k }, (_, i) => bytes(k * 10_000 + i, 96));
    return {
      k,
      sources: sources.map(hex),
      fountain: [1, 2, 3, 17, 4242].map((g) => ({ seed: g, symbol: hex(fountainSymbol(sources, k, g)) })),
    };
  });
  // Decoding: a sequence of receptions (seeds out of order, replays) and the
  // exact answer of `receive` at each step.
  const decodings = [8, 63, 200].map((k) => {
    const sources = Array.from({ length: k }, (_, i) => bytes(k * 77 + i, 96));
    const rng = mulberry32(k);
    const seeds: number[] = [];
    for (let g = 1; g <= Math.ceil(k * 2.2) + 10; g++) if (rng() > 0.2) seeds.push(g);
    for (let i = seeds.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [seeds[i], seeds[j]] = [seeds[j]!, seeds[i]!];
    }
    seeds.splice(5, 0, seeds[2]!); // a replay
    const decoder = new FountainDecoder(k);
    const steps = seeds.map((g) => {
      const progress = decoder.receive(g, fountainSymbol(sources, k, g));
      return { seed: g, progress, complete: decoder.complete, receivedSymbols: decoder.receivedSymbols };
    });
    return { k, sources: sources.map(hex), steps, complete: decoder.complete };
  });
  write("fountain.json", { neighbors, symbols, decodings });
}

// ── Blocks ──────────────────────────────────────────────────────────────

{
  const plans = [
    { size: 0, ts: 96, kMax: 1024 },
    { size: 1, ts: 96, kMax: 1024 },
    { size: 95, ts: 96, kMax: 1024 },
    { size: 96, ts: 96, kMax: 1024 },
    { size: 1000, ts: 96, kMax: 3 },
    { size: 1000, ts: 7, kMax: 10 },
    { size: 98_305, ts: 96, kMax: 1024 },
  ].map(({ size, ts, kMax }) => {
    const stream = bytes(size + 1, size);
    const plan = planBlocks(stream, ts, kMax);
    return { stream: hex(stream), symbolSize: ts, kMax, kPerBlock: plan.kPerBlock, symbols: plan.symbols.map(hex) };
  });
  write("blocks.json", { plans });
}

// ── Compression ─────────────────────────────────────────────────────────

{
  const inputs = [
    new TextEncoder().encode("Bonjour OptiRelay ! ".repeat(50)),
    new Uint8Array(10_000).map((_, i) => (i * 7 + 3) & 0xff),
    bytes(9, 3000), // incompressible: null expected
    new Uint8Array(0),
    new TextEncoder().encode('{"cle":"valeur","liste":[1,2,3,4,5,6,7,8,9]}'.repeat(400)),
  ];
  const cases = [];
  for (const e of inputs) {
    const c = await compress(e);
    cases.push({ input: hex(e), compressed: c ? hex(c) : null });
    if (c) {
      const roundTrip = await decompress(c);
      if (hex(roundTrip) !== hex(e)) throw new Error("compression round trip broken");
    }
  }
  write("compression.json", { cases });
}

// ── Encryption ──────────────────────────────────────────────────────────

{
  const ecdh = [];
  for (let i = 0; i < 4; i++) {
    const a = bytes(100 + i, 32);
    const b = bytes(200 + i, 32);
    const pa = await keyPairFromScalar(a);
    const pb = await keyPairFromScalar(b);
    const s1 = await webcrypto.deriveEcdhSecret(pa.privateKey, pb.publicKey);
    const s2 = await webcrypto.deriveEcdhSecret(pb.privateKey, pa.publicKey);
    if (hex(s1) !== hex(s2)) throw new Error("asymmetric ECDH");
    ecdh.push({ privateA: hex(a), publicA: hex(pa.publicKey), privateB: hex(b), publicB: hex(pb.publicKey), secret: hex(s1) });
  }
  const hkdf = [];
  for (const [i, info, length] of [[1, "ORP v0.1 donnees", 32], [2, "ORP v0.1 nonce", 32], [3, "ORP v0.1 SAS", 4], [4, "", 64], [5, "é ü — info", 17]] as const) {
    const secret = bytes(300 + i, 32);
    const salt = i === 4 ? new Uint8Array(0) : bytes(400 + i, 16 + i);
    hkdf.push({ secret: hex(secret), salt: hex(salt), info, length, output: hex(await webcrypto.deriveHkdf(secret, salt, info, length)) });
  }
  const aead = [];
  for (const [i, size] of [[1, 0], [2, 1], [3, 96], [4, 384], [5, 1000]] as const) {
    const key = bytes(500 + i, 32);
    const nonce = bytes(600 + i, 12);
    const plaintext = bytes(700 + i, size);
    const aad = bytes(800 + i, i === 1 ? 0 : 22);
    const { ciphertext, tag } = await webcrypto.encryptAead(key, nonce, plaintext, aad);
    aead.push({ key: hex(key), nonce: hex(nonce), plaintext: hex(plaintext), aad: hex(aad), ciphertext: hex(ciphertext), tag: hex(tag) });
  }
  const hmac = [];
  for (const [i, tc, td] of [[1, 32, 8], [2, 1, 0], [3, 64, 100], [4, 100, 3]] as const) {
    const key = bytes(900 + i, tc);
    const data = bytes(950 + i, td);
    hmac.push({ key: hex(key), data: hex(data), mac: hex(await webcrypto.hmacSha256(key, data)) });
  }
  const sha256 = [];
  for (const n of [0, 3, 64, 1000]) {
    const d = bytes(1100 + n, n);
    sha256.push({ data: hex(d), digest: hex(await webcrypto.sha256(d)) });
  }
  const prng = [1, 7, 123456].map((g) => ({ seed: g, bytes: hex(new DeterministicCrypto(g).randomBytes(64)) }));
  write("encryption.json", { ecdh, hkdf, aead, hmac, sha256, prng });
}

// ── Pairing ─────────────────────────────────────────────────────────────

{
  // Init codes: every flag combination, a 32-bit kTotal (> 65 535) at the
  // largest block count a u16 can carry.
  const initCodes = [];
  for (const [i, size, compressed, byPassphrase, encrypted] of [
    [1, 0, false, false, true],
    [2, 123456, true, false, true],
    [3, 65535 * 1024 * 96 - 5, false, true, false],
    [4, 77, true, true, true],
    [5, 96 * 1024, false, false, false],
  ] as const) {
    const sessionId = bytes(1200 + i, 16);
    const senderPublicKey = bytes(1300 + i, 65);
    const commitment = await commitmentOf(webcrypto, sessionId, senderPublicKey);
    const { blockCount, kTotal } = expectedLayout(size);
    const info = {
      sessionId,
      commitment,
      streamSize: size,
      streamDigest: bytes(1400 + i, 32),
      blockCount,
      kTotal,
      compressed,
      byPassphrase,
      encrypted,
    };
    const code = writeInitCode(info);
    const readBack = readInitCode(code);
    initCodes.push({
      sessionId: hex(sessionId),
      senderPublicKey: hex(senderPublicKey),
      commitment: hex(commitment),
      streamSize: size,
      streamDigest: hex(info.streamDigest),
      blockCount,
      kTotal,
      compressed,
      byPassphrase,
      encrypted,
      code: hex(code),
      readBack: { blockCount: readBack.blockCount, kTotal: readBack.kTotal, streamSize: readBack.streamSize },
    });
  }
  // Codes a reader must refuse, with the expected error code.
  const valid = writeInitCode({
    sessionId: bytes(1250, 16),
    commitment: bytes(1251, 32),
    streamSize: 5000,
    streamDigest: bytes(1252, 32),
    ...expectedLayout(5000),
    compressed: false,
    byPassphrase: false,
    encrypted: true,
  });
  const altered = (f: (o: Uint8Array) => void, from = valid): Uint8Array => {
    const o = from.slice();
    f(o);
    return o;
  };
  const response = writeResponseCode(bytes(1253, 16), bytes(1254, 65));
  const invalidCodes = [
    { kind: "init", code: valid.slice(0, 96) }, // truncated
    { kind: "init", code: altered((o) => (o[0] = 0x52)) }, // another kind
    { kind: "init", code: altered((o) => (o[1] = 0x01)) }, // v0.1
    { kind: "init", code: altered((o) => (o[96] = 0x0c)) }, // unknown flag
    { kind: "init", code: altered((o) => (o[95] = o[95]! + 1)) }, // kTotal ≠ size
    { kind: "init", code: altered((o) => (o[91] = 0x02)) }, // blockCount ≠ size
    { kind: "init", code: altered((o) => (o[50] = 0x01)) }, // size > 2⁵³ − 1
    { kind: "response", code: altered((o) => (o[0] = 0x56), response) }, // a reveal kind
    { kind: "response", code: altered((o) => (o[1] = 0x03), response) }, // v0.3
    { kind: "reveal", code: response }, // a response code
    { kind: "reveal", code: response.slice(0, 82) },
  ].map(({ kind, code }) => {
    const read = { init: readInitCode, response: readResponseCode, reveal: readRevealCode }[kind as "init" | "response" | "reveal"];
    return { kind, code: hex(code), error: errorCode(() => read(code)) };
  });
  for (const c of invalidCodes) if (c.error === null) throw new Error(`invalid code accepted: ${c.code}`);
  const responseCodes = [1, 2].map((i) => {
    const sessionId = bytes(1500 + i, 16);
    const pub = bytes(1600 + i, 65);
    return { sessionId: hex(sessionId), receiverPublicKey: hex(pub), code: hex(writeResponseCode(sessionId, pub)) };
  });
  const revealCodes = [1, 2].map((i) => {
    const sessionId = bytes(1550 + i, 16);
    const pub = bytes(1650 + i, 65);
    return { sessionId: hex(sessionId), senderPublicKey: hex(pub), code: hex(writeRevealCode(sessionId, pub)) };
  });
  // Transcript hashes: codes path (three codes), passphrase path (init alone).
  const transcripts = [];
  for (const i of [1, 2]) {
    const init = hexToBytes(initCodes[i - 1]!.code);
    const res = hexToBytes(responseCodes[i - 1]!.code);
    const rev = hexToBytes(revealCodes[i - 1]!.code);
    transcripts.push({ init: hex(init), response: hex(res), reveal: hex(rev), hash: hex(await transcriptHash(webcrypto, init, res, rev)) });
  }
  transcripts.push({ init: initCodes[2]!.code, response: null, reveal: null, hash: hex(await transcriptHash(webcrypto, hexToBytes(initCodes[2]!.code))) });
  const keys = [];
  for (const i of [1, 2, 3, 4]) {
    const secret = bytes(1700 + i, 32);
    const transcript = bytes(1800 + i, 32);
    const c = await deriveKeys(webcrypto, secret, transcript);
    keys.push({ secret: hex(secret), transcript: hex(transcript), dataKey: hex(c.dataKey), nonceKey: hex(c.nonceKey), sas: c.sas });
  }
  // Passphrases: PBKDF2 secret, then the keys bound to an init code of the
  // same session (passphrase flag set).
  const passphrases = [];
  for (const [i, passphrase] of [[1, "mont-blanc-2026"], [2, "optirelay-banc"], [3, "phrase à accents — éèçà"], [4, "😀😀😀😀"], [5, "short"]] as const) {
    const sessionId = bytes(1900 + i, 16);
    const initCode = writeInitCode({
      sessionId,
      commitment: bytes(1950 + i, 32),
      streamSize: 1000 * i,
      streamDigest: bytes(1960 + i, 32),
      ...expectedLayout(1000 * i),
      compressed: false,
      byPassphrase: true,
      encrypted: true,
    });
    try {
      const secret = await deriveSecretFromPassphrase(webcrypto, passphrase, sessionId);
      const c = await deriveKeysFromPassphrase(webcrypto, passphrase, initCode);
      passphrases.push({ passphrase, sessionId: hex(sessionId), initCode: hex(initCode), secret: hex(secret), dataKey: hex(c.dataKey), nonceKey: hex(c.nonceKey), sas: c.sas, error: null });
    } catch (e) {
      passphrases.push({ passphrase, sessionId: hex(sessionId), initCode: hex(initCode), error: (e as OrpError).code });
    }
  }
  const nonces = [];
  for (const [block, seed] of [[0, 1], [3, 42], [3, 43], [4, 42], [0xffffffff, 0xffffffff]] as const) {
    const key = bytes(2100, 32);
    nonces.push({ key: hex(key), block, seed, nonce: hex(await frameNonce(webcrypto, key, block, seed)) });
  }
  const tokens = [bytes(2200, 16), new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xff]), new Uint8Array(16).fill(0xff)].map((s) => ({ sessionId: hex(s), token: tokenOf(s) }));
  write("pairing.json", { initCodes, invalidCodes, responseCodes, revealCodes, transcripts, keys, passphrases, nonces, tokens });
}

// ── Complete sessions ───────────────────────────────────────────────────

interface Scenario {
  name: string;
  size: number;
  fileSeed: number;
  senderSeed: number;
  receiverSeed: number;
  encryption: "required" | "optional" | "none";
  compression: boolean;
  pairing: "codes" | "passphrase";
  passphrase?: string;
  codecs?: Codec[];
  passes: number;
  /** Codec fallback after the n-th sent frame (like `setCodec` in the callback). */
  fallback?: { after: number; codec: Codec };
  /** Channel: losses, duplicates, forged frames — applied to the frame stream. */
  channel?: { seed: number; loss: number };
}

const scenarios: Scenario[] = [
  { name: "codes-encrypted", size: 5000, fileSeed: 1, senderSeed: 11, receiverSeed: 12, encryption: "required", compression: false, pairing: "codes", passes: 2, channel: { seed: 5, loss: 0.3 } },
  { name: "passphrase-plain", size: 49, fileSeed: 2, senderSeed: 21, receiverSeed: 22, encryption: "none", compression: false, pairing: "passphrase", passphrase: "phrase-d-appairage-commune", passes: 1 },
  { name: "passphrase-encrypted-mono", size: 700, fileSeed: 3, senderSeed: 31, receiverSeed: 32, encryption: "required", compression: false, pairing: "passphrase", passphrase: "optirelay-banc", codecs: [CODEC.MONO_2], passes: 2 },
  { name: "multi-block-fallback", size: 100_000, fileSeed: 4, senderSeed: 41, receiverSeed: 42, encryption: "required", compression: false, pairing: "codes", passes: 2, fallback: { after: 120, codec: CODEC.COLOR_4 } },
  { name: "compressed", size: 0, fileSeed: 5, senderSeed: 51, receiverSeed: 52, encryption: "required", compression: true, pairing: "codes", passes: 2, channel: { seed: 6, loss: 0.2 } },
];

function fileOf(s: Scenario): Uint8Array {
  if (s.name === "compressed") {
    // Compressible but not trivial text: randomly drawn words (French test
    // data: changing them would change the vector bytes).
    const words = ["trame", "bloc", "graine", "symbole", "fontaine", "optique", "relais", "état", "nominal", "écart"];
    const rng = mulberry32(s.fileSeed);
    const lines = Array.from({ length: 900 }, (_, i) => `${i} ${Array.from({ length: 6 }, () => words[Math.floor(rng() * words.length)]).join(" ")}`);
    return new TextEncoder().encode(lines.join("\n"));
  }
  return bytes(s.fileSeed, s.size);
}

const sessions = [];
for (const s of scenarios) {
  const file = fileOf(s);
  const sender = new SenderSession(new DeterministicCrypto(s.senderSeed), {
    encryption: s.encryption,
    compression: s.compression,
    pairing: s.pairing,
    ...(s.codecs ? { codecs: s.codecs } : {}),
  });
  // A sender in encryption "none" must be accepted explicitly (v0.2).
  const receiver = new ReceiverSession(new DeterministicCrypto(s.receiverSeed), s.encryption === "none" ? { encryption: "optional" } : {});
  await sender.prepare(file);
  const initCode = sender.initCode();
  receiver.scanInitCode(initCode);
  let responseCode: Uint8Array | null = null;
  let revealCode: Uint8Array | null = null;
  if (s.pairing === "codes") {
    responseCode = await receiver.responseCode();
    await sender.receiveResponseCode(responseCode);
    revealCode = sender.revealCode();
    await receiver.receiveRevealCode(revealCode);
  } else {
    await sender.receivePassphrase(s.passphrase!);
    await receiver.pairWithPassphrase(s.passphrase!);
  }
  const sas = sender.sas();
  if (sas !== receiver.sas()) throw new Error("SAS divergents");
  sender.confirmSas();
  receiver.confirmSas();

  const frames: Uint8Array[] = [];
  let n = 0;
  await sender.start((t) => {
    frames.push(t);
    n++;
    if (s.fallback && n === s.fallback.after) sender.setCodec(s.fallback.codec);
  }, s.passes);

  // What the receiver sees: losses, a duplicate, a forged frame, a frame
  // damaged beyond RS — and the exact status of every reception.
  // `received` designates a sent frame by its index, or carries raw bytes.
  const received: Uint8Array[] = [];
  const receivedJson: ({ frame: number } | { raw: string })[] = [];
  const rng = mulberry32(s.channel?.seed ?? 1);
  for (const [i, t] of frames.entries()) {
    const lost = s.channel !== undefined && rng() < s.channel.loss;
    if (!lost) {
      received.push(t);
      receivedJson.push({ frame: i });
    }
    if (s.channel && i === 3) {
      received.push(t);
      receivedJson.push({ frame: i });
    }
    if (s.channel && i === 4) {
      const template = readFrame(t);
      const forged = buildFrame({ ...template.header, seed: 0xdeadbeef }, new Uint8Array(template.payload.length).fill(0x5a), template.tag ? new Uint8Array(16).fill(0x5a) : undefined);
      const broken = t.slice();
      for (let j = 0; j < 12; j++) broken[30 + j] = broken[30 + j]! ^ 0xa5;
      const otherSession = t.slice(0, 24).fill(0);
      // v0.2: a clear frame of the session (encryption not the announced
      // one) and a frame outside the announced layout (block that does not
      // exist) — both rejected before any decoding.
      const flipped = buildFrame(
        { ...template.header, flags: template.header.flags ^ FLAG.ENCRYPTED, seed: 0xdeadbee0 },
        new Uint8Array(template.payload.length).fill(0x41),
        template.tag ? undefined : new Uint8Array(16).fill(0x41),
      );
      const outside = buildFrame({ ...template.header, block: 0x10000, seed: 0xdeadbee1 }, template.payload, template.tag);
      for (const b of [forged, broken, otherSession, flipped, outside]) {
        received.push(b);
        receivedJson.push({ raw: hex(b) });
      }
    }
  }
  const statuses: FrameStatus[] = [];
  for (const t of received) statuses.push(await receiver.receiveFrame(t));
  let result: string | null = null;
  if (receiver.done) {
    const r = await receiver.result();
    if (hex(r.data) !== hex(file)) throw new Error(`session ${s.name} : fichier reconstruit faux`);
    result = hex(r.data);
  }
  sessions.push({
    ...s,
    file: hex(file),
    initCode: hex(initCode),
    responseCode: responseCode ? hex(responseCode) : null,
    revealCode: revealCode ? hex(revealCode) : null,
    sas,
    frames: frames.map(hex),
    received: receivedJson,
    statuses: statuses.map((st) => (st.accepted ? "accepted" : st.rejection)),
    progress: receiver.progress(),
    result,
  });
}
write("sessions.json", { sessions });
