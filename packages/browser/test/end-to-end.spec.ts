import { describe, expect, it } from "vitest";
import {
  CODEC,
  Codec,
  CryptoWebCrypto,
  mulberry32,
  SenderSession,
  ReceiverSession,
  INIT_CODE_SIZE,
  RESPONSE_CODE_SIZE,
  REVEAL_CODE_SIZE,
} from "@optirelay/core";
import { TM_PALETTE, TmReceiver, simulateCapture, payloadSubframe, referenceSubframe, type SimulationOptions } from "@optirelay/optical";
import { pairingPayload, frameCodec, isPairingFrame, pairingFrame } from "../src/tm.ts";

/** Simulated optical channel: each frame goes R then P in front of a "camera". */
function channel(options: SimulationOptions) {
  const receiver = new TmReceiver();
  let t = 0;
  let seed = 1;
  return (raw: Uint8Array, codec: Codec): Uint8Array | null => {
    let decoded: Uint8Array | null = null;
    for (const grid of [referenceSubframe(raw, codec), payloadSubframe(raw, codec)]) {
      const r = receiver.process(simulateCapture(grid, TM_PALETTE, { ...options, seed: seed++ }), (t += 250));
      if (r.frame?.isNew) decoded = r.frame.bytes;
    }
    return decoded;
  };
}

describe("end to end: TM4 pairing both ways, TM8 then TM4 data", () => {
  it("transfers an encrypted file, byte for byte, through two simulated cameras", async () => {
    const rng = mulberry32(99);
    const file = Uint8Array.from({ length: 3000 }, () => Math.floor(rng() * 256));
    const crypto = new CryptoWebCrypto();
    const sender = new SenderSession(crypto, { codecs: [CODEC.COLOR_8, CODEC.COLOR_4] });
    const receiver = new ReceiverSession(crypto);
    const toPhone = channel({ rotationDegrees: 3, gains: [1.2, 0.8, 1.1], noise: 5, perspective: [0.08, -0.05], scale: 0.85 });
    const toWebcam = channel({ rotationDegrees: -5, gains: [0.9, 1.1, 0.75], noise: 7, haze: [15, 10, 5] });

    await sender.prepare(file);
    // 1. The phone reads the init code (displayed in a loop: two passes are enough).
    const init = pairingFrame(sender.initCode());
    const decodedInit = toPhone(init, CODEC.COLOR_4) ?? toPhone(init, CODEC.COLOR_4);
    expect(decodedInit).not.toBeNull();
    receiver.scanInitCode(pairingPayload(decodedInit!, INIT_CODE_SIZE)!);
    // 2. The sender's webcam reads the phone's response.
    const response = pairingFrame(await receiver.responseCode());
    const decodedResponse = toWebcam(response, CODEC.COLOR_4) ?? toWebcam(response, CODEC.COLOR_4);
    await sender.receiveResponseCode(pairingPayload(decodedResponse!, RESPONSE_CODE_SIZE)!);
    // 3. The phone reads the reveal code (the sender's key, opening the commitment of the init code).
    const reveal = pairingFrame(sender.revealCode());
    const decodedReveal = toPhone(reveal, CODEC.COLOR_4) ?? toPhone(reveal, CODEC.COLOR_4);
    await receiver.receiveRevealCode(pairingPayload(decodedReveal!, REVEAL_CODE_SIZE)!);
    // 4. Identical SAS codes, confirmed on both sides.
    expect(sender.sas()).toBe(receiver.sas());
    sender.confirmSas();
    receiver.confirmSas();
    // 5. Data: TM8, TM4 fallback halfway; the receiver recognizes the mode on its own.
    let sentCount = 0;
    await sender.start(async (frame) => {
      sentCount++;
      if (sentCount === 4) sender.setCodec(CODEC.COLOR_4);
      const decoded = toPhone(frame, frameCodec(frame));
      if (decoded && !isPairingFrame(decoded)) await receiver.receiveFrame(decoded);
      if (receiver.done || sentCount > 200) sender.finish();
    });
    expect(receiver.done).toBe(true);
    const result = await receiver.result();
    expect(result.verified).toBe(true);
    expect(Array.from(result.data)).toEqual(Array.from(file));
  }, 60_000);
});
