import { describe, expect, it } from "vitest";

import {
  CODEC,
  CryptoWebCrypto,
  SenderSession,
  ReceiverSession,
  mulberry32,
} from "@optirelay/core";
import {
  calibrate,
  decodeGrid,
  encodeTestPattern,
  encodeRawFrame,
  paletteOf,
  simulateCapture,
} from "../src/index.ts";

/**
 * End-to-end acceptance test WITHOUT hardware (§10.1, basis of QA-01): a
 * complete ORP session — pairing, SAS, encrypted sending — goes through the
 * optical encoder, the camera simulation (rotation, scale, noise), the
 * decoder, then the reception. Losses, duplicates and disorder at the frame
 * level. This is the EXACT path of the PWA: session → frame → grid → screen
 * → camera → decoding → session.
 */

const crypto = new CryptoWebCrypto();

describe("end-to-end optical acceptance", () => {
  it("transfers 12 KB encrypted, calibrated COLOR_8, rotation + noise + 10 % losses", async () => {
    const plaintext = new Uint8Array(12_000).map((_, i) => (i * 31 + 7) & 0xff);
    const sender = new SenderSession(crypto);
    const receiver = new ReceiverSession(crypto);
    await sender.prepare(plaintext);
    receiver.scanInitCode(sender.initCode());
    const response = await receiver.responseCode();
    await sender.receiveResponseCode(response);
    expect(sender.sas()).toBe(receiver.sas());
    sender.confirmSas();
    receiver.confirmSas();

    // Capture conditions shared by the test pattern and the transfer (§5.3) —
    // this is the compliant flow: calibration is mandatory for COLOR_8.
    const conditions = { rotationDegrees: 3, scale: 0.97, noise: 4, seed: 11 };
    const palette = paletteOf(CODEC.COLOR_8);
    const calibrated = calibrate(
      simulateCapture(encodeTestPattern(CODEC.COLOR_8), palette, conditions),
      CODEC.COLOR_8,
    );

    const rng = mulberry32(2026);
    const pending: Uint8Array[] = [];
    let counter = 0;
    const emit = async (t: Uint8Array) => {
      if (rng() < 0.1) return; // lost frame
      pending.push(t);
      if (counter === 5) pending.push(t); // deterministic duplicate
      counter++;
      if (counter % 6 === 0) {
        pending.sort(() => rng() - 0.5); // disorder within the batch
        while (pending.length > 0) {
          const raw = pending.shift()!;
          const grid = encodeRawFrame(raw, CODEC.COLOR_8);
          const image = simulateCapture(grid, palette, conditions);
          const decode = decodeGrid(image, CODEC.COLOR_8, { palette: calibrated });
          await receiver.receiveFrame(decode.bytes);
        }
      }
    };

    const complete = new Promise<void>((r) => receiver.events.on("complete", () => r()));
    const loop = sender.start(emit);
    await complete;
    sender.finish();
    await loop;

    const result = await receiver.result();
    expect(result.verified).toBe(true);
    expect(Array.from(result.data)).toEqual(Array.from(plaintext));
    const progress = receiver.progress();
    expect(progress.completedBlocks).toBe(progress.blockCount);
  }, 120000);

  it("transfers a text message in MONO_2 (fallback mode, F-02), 5 % losses", async () => {
    const plaintext = new TextEncoder().encode("Monochrome fallback message — OptiRelay F-02.");
    const sender = new SenderSession(crypto, { codecs: [CODEC.MONO_2], compression: false });
    const receiver = new ReceiverSession(crypto);
    await sender.prepare(plaintext);
    receiver.scanInitCode(sender.initCode());
    const response = await receiver.responseCode();
    await sender.receiveResponseCode(response);
    sender.confirmSas();
    receiver.confirmSas();

    const rng = mulberry32(77);
    const emit = async (t: Uint8Array) => {
      if (rng() < 0.05) return;
      const image = simulateCapture(encodeRawFrame(t, CODEC.MONO_2), paletteOf(CODEC.MONO_2), {
        rotationDegrees: -4,
        noise: 5,
        seed: 5,
      });
      await receiver.receiveFrame(decodeGrid(image, CODEC.MONO_2).bytes);
    };

    const complete = new Promise<void>((r) => receiver.events.on("complete", () => r()));
    const loop = sender.start(emit);
    await complete;
    sender.finish();
    await loop;
    const result = await receiver.result();
    expect(new TextDecoder().decode(result.data)).toBe(new TextDecoder().decode(plaintext));
  }, 60000);
});
