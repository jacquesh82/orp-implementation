import { describe, expect, it } from "vitest";

import { CryptoWebCrypto, OrpInvalidPairingCode } from "../src/index.ts";
import {
  deriveKeys,
  deriveSecretFromPassphrase,
  writeInitCode,
  writeResponseCode,
  tokenOf,
  readInitCode,
  readResponseCode,
  frameNonce,
} from "../src/index.ts";

const crypto = new CryptoWebCrypto();

describe("pairing codes", () => {
  it("round-trip", () => {
    const sessionId = crypto.randomBytes(16);
    const pub = crypto.randomBytes(65);
    pub[0] = 0x04;
    const digest = crypto.randomBytes(32);
    const info = { sessionId, senderPublicKey: pub, streamSize: 123456, streamDigest: digest, blockCount: 2, kTotal: 1500, compressed: true };
    const parsed = readInitCode(writeInitCode(info));
    expect(Array.from(parsed.sessionId)).toEqual(Array.from(sessionId));
    expect(parsed.streamSize).toBe(123456);
    expect(parsed.blockCount).toBe(2);
    expect(parsed.kTotal).toBe(1500);
    expect(parsed.compressed).toBe(true);

    const response = writeResponseCode(sessionId, pub, 424242);
    const parsedResponse = readResponseCode(response);
    expect(Array.from(parsedResponse.receiverPublicKey)).toEqual(Array.from(pub));
    expect(parsedResponse.sasSeed).toBe(424242);
  });

  it("reject wrong sizes", () => {
    expect(() => readInitCode(new Uint8Array(10))).toThrow(OrpInvalidPairingCode);
    expect(() => readResponseCode(new Uint8Array(10))).toThrow(OrpInvalidPairingCode);
  });

  it("derives the short token from the first 4 bytes of the session_id", () => {
    const sessionId = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xff]);
    expect(tokenOf(sessionId)).toBe(0x01020304);
  });
});

describe("key derivation", () => {
  it("gives the same SAS to both sides of the same secret", async () => {
    const secret = crypto.randomBytes(32);
    const sessionId = crypto.randomBytes(16);
    const keysA = await deriveKeys(crypto, secret, sessionId, 777);
    const keysB = await deriveKeys(crypto, secret, sessionId, 777);
    expect(keysA.sas).toMatch(/^\d{6}$/);
    expect(keysA.sas).toBe(keysB.sas);
    expect(Array.from(keysA.dataKey)).toEqual(Array.from(keysB.dataKey));
    // Another SAS seed changes the SAS — not the data keys.
    const keysC = await deriveKeys(crypto, secret, sessionId, 778);
    expect(keysC.sas).not.toBe(keysA.sas);
    expect(Array.from(keysC.dataKey)).toEqual(Array.from(keysA.dataKey));
  });

  it("derives identical passphrase keys on both sides", async () => {
    const sessionId = crypto.randomBytes(16);
    const secret = await deriveSecretFromPassphrase(crypto, "mont-blanc-2026", sessionId);
    const keysA = await deriveKeys(crypto, secret, sessionId, 9);
    const keysB = await deriveKeys(crypto, secret, sessionId, 9);
    expect(keysA.sas).toBe(keysB.sas);
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

describe("pairing mode announced by the init code", () => {
  it("flags bit 1: passphrase; bit 0 (compressed) read independently", async () => {
    const { writeInitCode, readInitCode } = await import("../src/pairing.ts");
    const base = {
      sessionId: new Uint8Array(16).fill(1),
      senderPublicKey: new Uint8Array(65).fill(2),
      streamSize: 1234,
      streamDigest: new Uint8Array(32).fill(3),
      blockCount: 1,
      kTotal: 13,
    };
    for (const compressed of [false, true]) {
      for (const byPassphrase of [false, true]) {
        const parsed = readInitCode(writeInitCode({ ...base, compressed, byPassphrase }));
        expect(parsed.compressed).toBe(compressed);
        expect(parsed.byPassphrase).toBe(byPassphrase);
      }
    }
  });

  it("sending and receiving with the same passphrase give the same SAS code", async () => {
    const { CryptoWebCrypto, SenderSession, ReceiverSession } = await import("../src/index.ts");
    const crypto = new CryptoWebCrypto();
    const sender = new SenderSession(crypto, { pairing: "passphrase" });
    await sender.prepare(new TextEncoder().encode("hello"));
    const receiver = new ReceiverSession(crypto);
    const info = receiver.scanInitCode(sender.initCode());
    expect(info.byPassphrase).toBe(true);
    await sender.receivePassphrase("shared test passphrase");
    await receiver.pairWithPassphrase("shared test passphrase");
    expect(receiver.sas()).toBe(sender.sas());
  });
});
