import { describe, expect, it } from "vitest";

import {
  CODEC,
  CryptoWebCrypto,
  Events,
  OrpInvalidState,
  OrpPairingRequired,
  OrpUnknownSession,
  SenderSession,
  ReceiverSession,
  buildFrame,
  readFrame,
  mulberry32,
  type Codec,
  type FrameHeader,
  type FrameStatus,
  PROTOCOL_VERSION,
} from "../src/index.ts";

const crypto = new CryptoWebCrypto();

/** Pairs two sessions through the strong path: init code, response code, reveal code. */
async function pair(sender: SenderSession, receiver: ReceiverSession): Promise<void> {
  receiver.scanInitCode(sender.initCode());
  const response = await receiver.responseCode();
  await sender.receiveResponseCode(response);
  await receiver.receiveRevealCode(sender.revealCode());
  expect(sender.sas()).toBe(receiver.sas());
  sender.confirmSas();
  receiver.confirmSas();
}

/**
 * Simulated optical channel: losses, duplicates, disorder. In shuffled mode,
 * frames leave in batches of eight, out of order — the fountain code does not
 * care, this is exactly what it handles.
 */
function lossyChannel(
  receive: (t: Uint8Array) => Promise<FrameStatus>,
  options: { loss: number; shuffle: boolean },
): { emit: (t: Uint8Array) => Promise<void> } {
  const rng = mulberry32(20261031);
  const queue: Uint8Array[] = [];
  let counter = 0;
  return {
    async emit(t: Uint8Array) {
      if (rng() < options.loss) return;
      queue.push(t);
      if (counter === 3) queue.push(t); // deterministic duplicate for the replay test
      counter++;
      if (!options.shuffle || counter % 8 === 0) {
        if (options.shuffle) queue.sort(() => rng() - 0.5);
        while (queue.length > 0) await receive(queue.shift()!);
      }
    },
  };
}

/** Waits for the "complete" event of the receiver, then stops the sender. */
async function untilComplete(sender: SenderSession, receiver: ReceiverSession, loop: Promise<void>): Promise<void> {
  const complete = new Promise<void>((r) => receiver.events.on("complete", () => r()));
  await complete;
  sender.finish();
  await loop;
}

describe("end-to-end session (WebCrypto)", () => {
  it("transfers an encrypted and compressed file, with losses and disorder", async () => {
    const plaintext = new Uint8Array(24_000).map((_, i) => (i * 7 + 3) & 0xff);
    const sender = new SenderSession(crypto);
    const receiver = new ReceiverSession(crypto);
    await sender.prepare(plaintext);
    await pair(sender, receiver);

    const channel = lossyChannel((t) => receiver.receiveFrame(t), { loss: 0.12, shuffle: true });
    const loop = sender.start((t) => channel.emit(t));
    await untilComplete(sender, receiver, loop);

    const result = await receiver.result();
    expect(result.verified).toBe(true);
    expect(Array.from(result.data)).toEqual(Array.from(plaintext));
    const progress = receiver.progress();
    expect(progress.completedBlocks).toBe(progress.blockCount);
    expect(progress.replays).toBeGreaterThan(0); // the duplicates fed to the channel are counted
  }, 30000);

  it("transfers a text message through the degraded path (passphrase), without encryption or compression", async () => {
    const message = new TextEncoder().encode("Plain test message — UC-01, without encryption.");
    const sender = new SenderSession(crypto, { encryption: "none", compression: false, pairing: "passphrase" });
    const receiver = new ReceiverSession(crypto, { encryption: "optional" });
    await sender.prepare(message);
    receiver.scanInitCode(sender.initCode());
    await receiver.pairWithPassphrase("shared-pairing-passphrase");
    await sender.receivePassphrase("shared-pairing-passphrase");
    expect(sender.sas()).toBe(receiver.sas());
    sender.confirmSas();
    receiver.confirmSas();

    await sender.start(async (t) => { await receiver.receiveFrame(t); }, 1);
    const result = await receiver.result();
    expect(new TextDecoder().decode(result.data)).toBe(new TextDecoder().decode(message));
  }, 15000);

  it("supports a codec fallback in the middle of the transfer (F-06), session and reconstruction preserved", async () => {
    const plaintext = new Uint8Array(60_000).map((_, i) => (i * 5) & 0xff);
    const sender = new SenderSession(crypto, { compression: false });
    const receiver = new ReceiverSession(crypto);
    await sender.prepare(plaintext);
    await pair(sender, receiver);

    const sentCodecs: Codec[] = [];
    sender.events.on("frame", ({ codec }) => sentCodecs.push(codec));
    const complete = new Promise<void>((r) => receiver.events.on("complete", () => r()));
    let count = 0;
    const loop = sender.start(async (t) => {
      count++;
      if (count === 120) sender.setCodec(CODEC.COLOR_4); // fallback 8 → 4
      await receiver.receiveFrame(t);
    });
    await complete;
    sender.finish();
    await loop;

    expect(sentCodecs.slice(0, 120).every((c) => c === CODEC.COLOR_8)).toBe(true);
    expect(sentCodecs.slice(120).some((c) => c === CODEC.COLOR_4)).toBe(true);
    const result = await receiver.result();
    expect(Array.from(result.data)).toEqual(Array.from(plaintext));
  }, 30000);

  it("ignores replays and rejects a forged frame (AEAD failure)", async () => {
    const plaintext = new Uint8Array(5_000).fill(0x42);
    const sender = new SenderSession(crypto, { compression: false });
    const receiver = new ReceiverSession(crypto);
    await sender.prepare(plaintext);
    await pair(sender, receiver);
    const buffer: Uint8Array[] = [];
    await sender.start(async (t) => {
      buffer.push(t);
    }, 1);
    expect(buffer.length).toBeGreaterThan(2);

    const first = buffer[0]!;
    expect((await receiver.receiveFrame(first)).accepted).toBe(true);
    expect(await receiver.receiveFrame(first)).toEqual({ accepted: false, rejection: "rejeu" });

    // Forgery by an active attacker: copied header (other seed), arbitrary
    // payload and tag, RS and CRC recomputed — everything is "valid" as far
    // as the channel goes, only the AEAD authentication can expose it.
    const template = readFrame(buffer[1]!);
    const forgedHeader: FrameHeader = { ...template.header, seed: 0xdeadbeef };
    const fakePayload = new Uint8Array(template.payload.length).fill(0x5a);
    const badTag = new Uint8Array(16).fill(0x5a);
    const forgedFrame = buildFrame(forgedHeader, fakePayload, badTag);
    expect(await receiver.receiveFrame(forgedFrame)).toEqual({ accepted: false, rejection: "falsifiee" });
  });

  it("rejects a frame from another session (OrpUnknownSession)", async () => {
    const plaintext = new Uint8Array(5_000).fill(7);
    const sender = new SenderSession(crypto, { compression: false });
    const receiver = new ReceiverSession(crypto);
    await sender.prepare(plaintext);
    await pair(sender, receiver);
    const buffer: Uint8Array[] = [];
    await sender.start(async (t) => {
      buffer.push(t);
    }, 1);

    // A second receiver, paired on ANOTHER session (new session_id).
    const senderB = new SenderSession(crypto, { compression: false });
    await senderB.prepare(plaintext);
    const receiverB = new ReceiverSession(crypto);
    receiverB.scanInitCode(senderB.initCode());
    const responseB = await receiverB.responseCode();
    await senderB.receiveResponseCode(responseB);
    await receiverB.receiveRevealCode(senderB.revealCode());
    senderB.confirmSas();
    receiverB.confirmSas();

    await expect(receiverB.receiveFrame(buffer[0]!)).rejects.toBeInstanceOf(OrpUnknownSession);
  });

  it("explicitly rejects an incompatible major version (F-21)", async () => {
    const plaintext = new Uint8Array(4_000);
    const sender = new SenderSession(crypto, { compression: false, encryption: "none" });
    const receiver = new ReceiverSession(crypto, { encryption: "optional" });
    await sender.prepare(plaintext);
    await pair(sender, receiver);
    const buffer: Uint8Array[] = [];
    await sender.start(async (t) => {
      buffer.push(t);
    }, 1);

    // A legitimately encoded "v1.0" frame (valid RS and CRC) from an imaginary,
    // too recent sender: the rejection must be explicit, never approximate.
    const template = readFrame(buffer[0]!);
    const tooRecent = buildFrame(
      { ...template.header, version: { major: 1, minor: 0 } },
      template.payload,
      template.tag,
    );
    expect(await receiver.receiveFrame(tooRecent)).toEqual({ accepted: false, rejection: "version" });
    void PROTOCOL_VERSION;
  });

  it("enforces the state machine", async () => {
    const sender = new SenderSession(crypto);
    expect(() => sender.initCode()).toThrow(OrpPairingRequired);
    await sender.prepare(new Uint8Array(1000));
    await expect(sender.start(async () => {})).rejects.toThrow(OrpInvalidState);
    expect(() => sender.sas()).toThrow(OrpInvalidState);

    const receiver = new ReceiverSession(crypto);
    expect(() => receiver.sas()).toThrow(OrpInvalidState);
    receiver.scanInitCode(sender.initCode());
  });

  it("supports pause/resume within the active session (§8.1)", async () => {
    const plaintext = new Uint8Array(30_000).fill(0x11);
    const sender = new SenderSession(crypto, { compression: false });
    const receiver = new ReceiverSession(crypto);
    await sender.prepare(plaintext);
    await pair(sender, receiver);

    const complete = new Promise<void>((r) => receiver.events.on("complete", () => r()));
    let pausedOnce = false;
    const loop = sender.start(async (t) => {
      if (!pausedOnce && sender.sentFrames > 50) {
        pausedOnce = true;
        sender.pause();
        expect(sender.state).toBe("pause");
        // Asynchronous resume: the sending loop waits.
        setTimeout(() => sender.resume(), 10);
      }
      await receiver.receiveFrame(t);
    });
    await complete;
    sender.finish();
    await loop;
    expect(pausedOnce).toBe(true);
    const result = await receiver.result();
    expect(Array.from(result.data)).toEqual(Array.from(plaintext));
  }, 30000);
});

void Events;
