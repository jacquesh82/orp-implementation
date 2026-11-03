/**
 * ORP v0.2 security properties — each test replays an attack that worked
 * against v0.1 (review of 2026-11-02).
 */
import { describe, expect, it } from "vitest";

import {
  CODEC,
  CryptoWebCrypto,
  FLAG,
  FRAME_VERSION,
  OrpError,
  OrpInvalidPairingCode,
  ReceiverSession,
  SenderSession,
  buildFrame,
  compress,
  decompress,
  readFrame,
  writeRevealCode,
  type FrameHeader,
} from "../src/index.ts";

const crypto = new CryptoWebCrypto();

async function paired(file: Uint8Array): Promise<{ sender: SenderSession; receiver: ReceiverSession; frames: Uint8Array[] }> {
  const sender = new SenderSession(crypto, { compression: false });
  const receiver = new ReceiverSession(crypto);
  await sender.prepare(file);
  receiver.scanInitCode(sender.initCode());
  await sender.receiveResponseCode(await receiver.responseCode());
  await receiver.receiveRevealCode(sender.revealCode());
  sender.confirmSas();
  receiver.confirmSas();
  const frames: Uint8Array[] = [];
  await sender.start(async (t) => {
    frames.push(t);
  }, 2);
  return { sender, receiver, frames };
}

/** A clear frame of the session: the token is readable on the wire, nothing else is needed. */
function clearFrame(token: number, over: Partial<FrameHeader>, payload = new Uint8Array(96).fill(0x41)): Uint8Array {
  return buildFrame(
    { version: FRAME_VERSION, codec: CODEC.COLOR_8, flags: 0, token, block: 0, k: 1, symbolCount: 1, seed: 1, ...over },
    payload,
  );
}

describe("frame injection after pairing", () => {
  it("a clear frame in an encrypted session is rejected as forged, the real file still arrives", async () => {
    const file = new Uint8Array(500).map((_, i) => i & 0xff);
    const { sender, receiver, frames } = await paired(file);
    const k = Math.ceil(500 / 96);
    expect(await receiver.receiveFrame(clearFrame(sender.token, { k, seed: 1 }))).toEqual({ accepted: false, rejection: "falsifiee" });
    for (const t of frames) await receiver.receiveFrame(t);
    expect(Array.from((await receiver.result()).data)).toEqual(Array.from(file));
  });

  it("a block that does not exist or a wrong K is rejected without allocating a decoder (no throw)", async () => {
    const { sender, receiver } = await paired(new Uint8Array(500));
    expect(await receiver.receiveFrame(clearFrame(sender.token, { block: 123456, k: 6 }))).toEqual({ accepted: false, rejection: "invalide" });
    expect(await receiver.receiveFrame(clearFrame(sender.token, { block: 0, k: 999 }))).toEqual({ accepted: false, rejection: "invalide" });
    expect(receiver.progress().receivedSymbols).toBe(0);
  });

  it("an encrypted frame with a header rewritten to another K is rejected before decoding", async () => {
    const { receiver, frames } = await paired(new Uint8Array(500));
    const original = readFrame(frames[0]!);
    const forged = buildFrame({ ...original.header, k: original.header.k + 1 }, original.payload, original.tag);
    expect(await receiver.receiveFrame(forged)).toEqual({ accepted: false, rejection: "invalide" });
  });
});

describe("init code", () => {
  it("a receiver refuses a sender announcing clear frames, unless it accepts them explicitly", async () => {
    const sender = new SenderSession(crypto, { encryption: "none", pairing: "passphrase" });
    await sender.prepare(new Uint8Array(10));
    expect(() => new ReceiverSession(crypto).scanInitCode(sender.initCode())).toThrow(OrpInvalidPairingCode);
    expect(new ReceiverSession(crypto, { encryption: "optional" }).scanInitCode(sender.initCode()).encrypted).toBe(false);
  });

  it("an init code altered in flight (other digest) gives diverging SAS", async () => {
    const sender = new SenderSession(crypto);
    await sender.prepare(new Uint8Array(1000).fill(7));
    const altered = sender.initCode().slice();
    altered[60] = altered[60]! ^ 0xff; // stream digest
    const receiver = new ReceiverSession(crypto);
    receiver.scanInitCode(altered);
    await sender.receiveResponseCode(await receiver.responseCode());
    await receiver.receiveRevealCode(sender.revealCode());
    expect(receiver.sas()).not.toBe(sender.sas());
  });
});

describe("SAS commitment", () => {
  it("a man-in-the-middle cannot reveal another key than the committed one", async () => {
    const sender = new SenderSession(crypto);
    await sender.prepare(new Uint8Array(100));
    const receiver = new ReceiverSession(crypto);
    const info = receiver.scanInitCode(sender.initCode());
    await receiver.responseCode();
    // The attacker relays the real init code, then reveals ITS key.
    const attacker = await crypto.generateEcdhKeyPair();
    await expect(receiver.receiveRevealCode(writeRevealCode(info.sessionId, attacker.publicKey))).rejects.toThrow(OrpInvalidPairingCode);
    expect(receiver.state).toBe("appairage");
  });

  it("the reveal code only exists once the response code has been read", async () => {
    const sender = new SenderSession(crypto);
    await sender.prepare(new Uint8Array(100));
    expect(() => sender.revealCode()).toThrow();
  });
});

describe("decompression", () => {
  it("stops a deflate bomb at the configured bound", async () => {
    const bomb = await compress(new Uint8Array(4 * 1024 * 1024));
    expect(bomb).not.toBeNull();
    await expect(decompress(bomb!, 1024 * 1024)).rejects.toBeInstanceOf(OrpError);
    expect((await decompress(bomb!)).length).toBe(4 * 1024 * 1024);
  });

  it("a malformed deflate stream is ONE rejection, never an unhandled one", async () => {
    await expect(decompress(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).rejects.toBeDefined();
  });
});

void FLAG;
