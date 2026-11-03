import { describe, expect, it } from "vitest";

import {
  CryptoWebCrypto,
  OrpIncompatibleVersion,
  OrpInvalidPairingCode,
  OrpInvalidState,
  SenderSession,
  ReceiverSession,
  deriveKeys,
  deriveSecretFromPassphrase,
  writeInitCode,
  writeResponseCode,
  writeRevealCode,
  tokenOf,
  readInitCode,
  readResponseCode,
  readRevealCode,
  pairingCodeKind,
  frameNonce,
  expectedK,
  INIT_CODE_SIZE,
  RESPONSE_CODE_SIZE,
  REVEAL_CODE_SIZE,
  type InitCodeInfo,
} from "../src/index.ts";

const crypto = new CryptoWebCrypto();

function initInfo(over: Partial<InitCodeInfo> = {}): InitCodeInfo {
  return {
    sessionId: new Uint8Array(16).fill(1),
    commitment: new Uint8Array(32).fill(2),
    streamSize: 123456,
    streamDigest: new Uint8Array(32).fill(3),
    blockCount: 2,
    kTotal: 1286,
    compressed: true,
    byPassphrase: false,
    encrypted: true,
    ...over,
  };
}

describe("pairing codes (v0.2)", () => {
  it("round-trip of the three codes, each with its kind", () => {
    const parsed = readInitCode(writeInitCode(initInfo()));
    expect(parsed).toEqual(initInfo());

    const sessionId = crypto.randomBytes(16);
    const pub = crypto.randomBytes(65);
    const response = writeResponseCode(sessionId, pub);
    const reveal = writeRevealCode(sessionId, pub);
    expect(response).toHaveLength(RESPONSE_CODE_SIZE);
    expect(reveal).toHaveLength(REVEAL_CODE_SIZE);
    expect(Array.from(readResponseCode(response).receiverPublicKey)).toEqual(Array.from(pub));
    expect(Array.from(readRevealCode(reveal).senderPublicKey)).toEqual(Array.from(pub));
    expect([pairingCodeKind(writeInitCode(initInfo())), pairingCodeKind(response), pairingCodeKind(reveal)]).toEqual(["init", "response", "reveal"]);
    // A response is never taken for a reveal (same size, other kind).
    expect(() => readRevealCode(response)).toThrow(OrpInvalidPairingCode);
  });

  it("reads the flags independently", () => {
    for (const compressed of [false, true]) {
      for (const byPassphrase of [false, true]) {
        for (const encrypted of [false, true]) {
          const parsed = readInitCode(writeInitCode(initInfo({ compressed, byPassphrase, encrypted })));
          expect([parsed.compressed, parsed.byPassphrase, parsed.encrypted]).toEqual([compressed, byPassphrase, encrypted]);
        }
      }
    }
  });

  it("rejects wrong sizes, unknown flags, another version", () => {
    expect(() => readInitCode(new Uint8Array(10))).toThrow(OrpInvalidPairingCode);
    expect(() => readResponseCode(new Uint8Array(10))).toThrow(OrpInvalidPairingCode);
    const code = writeInitCode(initInfo());
    const flags = code.slice();
    flags[INIT_CODE_SIZE - 1] = flags[INIT_CODE_SIZE - 1]! | 0x80;
    expect(() => readInitCode(flags)).toThrow(OrpInvalidPairingCode);
    const v01 = code.slice();
    v01[1] = 0x01;
    expect(() => readInitCode(v01)).toThrow(OrpIncompatibleVersion);
  });

  it("refuses a block layout that does not match the stream size (no silent truncation)", () => {
    expect(() => writeInitCode(initInfo({ kTotal: 7 }))).toThrow(OrpInvalidPairingCode);
    const code = writeInitCode(initInfo());
    const forged = code.slice();
    new DataView(forged.buffer).setUint16(90, 0); // blockCount = 0: "complete" from the start
    expect(() => readInitCode(forged)).toThrow(OrpInvalidPairingCode);
    // > 65 535 symbols: kTotal travels on 32 bits now.
    const big = 72_917 * 96;
    expect(readInitCode(writeInitCode(initInfo({ streamSize: big, blockCount: 72, kTotal: 72_917 }))).kTotal).toBe(72_917);
  });

  it("expected K per block", () => {
    expect(expectedK(123456, 0)).toBe(1024);
    expect(expectedK(123456, 1)).toBe(262);
    expect(expectedK(123456, 2)).toBe(0);
    expect(expectedK(0, 0)).toBe(0);
  });

  it("derives the short token from the first 4 bytes of the session_id", () => {
    expect(tokenOf(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xff]))).toBe(0x01020304);
  });
});

describe("key derivation", () => {
  it("same secret and transcript: same keys and SAS; another transcript: everything changes", async () => {
    const secret = crypto.randomBytes(32);
    const t1 = crypto.randomBytes(32);
    const keysA = await deriveKeys(crypto, secret, t1);
    const keysB = await deriveKeys(crypto, secret, t1);
    expect(keysA.sas).toMatch(/^\d{6}$/);
    expect(keysA.sas).toBe(keysB.sas);
    expect(Array.from(keysA.dataKey)).toEqual(Array.from(keysB.dataKey));
    const keysC = await deriveKeys(crypto, secret, crypto.randomBytes(32));
    expect(Array.from(keysC.dataKey)).not.toEqual(Array.from(keysA.dataKey));
  });

  it("stretches the passphrase (PBKDF2) and refuses short ones", async () => {
    const sessionId = crypto.randomBytes(16);
    const a = await deriveSecretFromPassphrase(crypto, "mont-blanc-2026", sessionId);
    const b = await deriveSecretFromPassphrase(crypto, "mont-blanc-2026", sessionId);
    expect(Array.from(a)).toEqual(Array.from(b));
    await expect(deriveSecretFromPassphrase(crypto, "short", sessionId)).rejects.toThrow(OrpInvalidPairingCode);
  });

  it("produces a deterministic nonce, unique per (block, seed)", async () => {
    const key = crypto.randomBytes(32);
    const a = await frameNonce(crypto, key, 3, 42);
    const b = await frameNonce(crypto, key, 3, 42);
    const c = await frameNonce(crypto, key, 3, 43);
    const d = await frameNonce(crypto, key, 4, 42);
    expect(a).toHaveLength(12);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(Array.from(a)).not.toEqual(Array.from(d));
  });
});

describe("pairing flows", () => {
  it("codes: init → response → reveal, same SAS on both sides", async () => {
    const sender = new SenderSession(crypto);
    await sender.prepare(new TextEncoder().encode("hello"));
    const receiver = new ReceiverSession(crypto);
    receiver.scanInitCode(sender.initCode());
    await sender.receiveResponseCode(await receiver.responseCode());
    expect(() => receiver.sas()).toThrow(OrpInvalidState); // no SAS before the reveal
    await receiver.receiveRevealCode(sender.revealCode());
    expect(receiver.sas()).toBe(sender.sas());
  });

  it("passphrase: same passphrase, same SAS; the mode must match the init code", async () => {
    const sender = new SenderSession(crypto, { pairing: "passphrase" });
    await sender.prepare(new TextEncoder().encode("hello"));
    const receiver = new ReceiverSession(crypto);
    const info = receiver.scanInitCode(sender.initCode());
    expect(info.byPassphrase).toBe(true);
    await expect(receiver.responseCode()).rejects.toThrow(OrpInvalidState);
    await sender.receivePassphrase("shared test passphrase");
    await receiver.pairWithPassphrase("shared test passphrase");
    expect(receiver.sas()).toBe(sender.sas());

    const other = new ReceiverSession(crypto);
    other.scanInitCode(sender.initCode());
    await other.pairWithPassphrase("another passphrase");
    expect(other.sas()).not.toBe(sender.sas());
  }, 20000);
});
