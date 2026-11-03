/**
 * The two examples of examples/ (hello-world, secure-hello-world), replayed
 * without a camera: same session calls, same frame order (init code, data
 * frame, init code, …), through a simulated TM4 capture.
 */
import { describe, expect, it } from "vitest";
import { CODEC, Codec, CryptoWebCrypto, INIT_CODE_SIZE, ReceiverSession, SenderSession, pairingCodeKind } from "@optirelay/core";
import { TM_PALETTE, TmReceiver, payloadSubframe, referenceSubframe, simulateCapture } from "@optirelay/optical";
import { isPairingFrame, pairingFrame, pairingPayload } from "../src/tm.ts";

function camera() {
  const receiver = new TmReceiver();
  let t = 0;
  let seed = 1;
  return (raw: Uint8Array, codec: Codec): Uint8Array | null => {
    let decoded: Uint8Array | null = null;
    for (const grid of [referenceSubframe(raw, codec), payloadSubframe(raw, codec)]) {
      const r = receiver.process(simulateCapture(grid, TM_PALETTE, { noise: 5, rotationDegrees: 2, gains: [1.1, 0.9, 1], seed: seed++ }), (t += 250));
      if (r.frame?.isNew) decoded = r.frame.bytes;
    }
    return decoded;
  };
}

/** Sender loop of the examples: the init code before each data frame. */
async function sendLoop(sender: SenderSession, onImage: (bytes: Uint8Array) => Promise<boolean>): Promise<void> {
  const init = pairingFrame(sender.initCode());
  const see = camera();
  let shown = 0;
  await sender.start(async (frame) => {
    for (const raw of [init, frame]) {
      const bytes = see(raw, CODEC.COLOR_4);
      if (bytes && (await onImage(bytes))) sender.finish();
    }
    if (++shown > 40) sender.finish();
  });
}

const crypto = new CryptoWebCrypto();

describe("examples", () => {
  it("hello-world: public passphrase, message received", async () => {
    const sender = new SenderSession(crypto, { pairing: "passphrase", codecs: [CODEC.COLOR_4] });
    await sender.prepare(new TextEncoder().encode("Hello world"));
    await sender.receivePassphrase("optirelay-hello-world");
    sender.confirmSas();
    const receiver = new ReceiverSession(crypto);
    let message = "";
    await sendLoop(sender, async (bytes) => {
      if (isPairingFrame(bytes)) {
        const code = pairingPayload(bytes, INIT_CODE_SIZE);
        if (receiver.state !== "initial" || !code || pairingCodeKind(code) !== "init") return false;
        receiver.scanInitCode(code);
        await receiver.pairWithPassphrase("optirelay-hello-world");
        receiver.confirmSas();
        return false;
      }
      if (receiver.state === "initial" || receiver.state === "appairage") return false;
      await receiver.receiveFrame(bytes);
      if (!receiver.done) return false;
      message = new TextDecoder().decode((await receiver.result()).data);
      return true;
    });
    expect(message).toBe("Hello world");
  }, 60_000);

  it("secure-hello-world: nothing decoded before the code; wrong code rejected; right code → message", async () => {
    const code = "K7QFM2XP9CHR";
    const sender = new SenderSession(crypto, { pairing: "passphrase", codecs: [CODEC.COLOR_4] });
    await sender.prepare(new TextEncoder().encode("Hello world — for your eyes only"));
    await sender.receivePassphrase(code);
    const senderSas = sender.sas(); // shown on the sender's screen
    sender.confirmSas();

    let initCode: Uint8Array | null = null;
    let receiver = new ReceiverSession(crypto);
    let ignoredBeforeCode = 0;
    let forged = 0;
    let typed: string | null = null;
    let message = "";
    const attempts = ["WRONGCODE123", code];
    await sendLoop(sender, async (bytes) => {
      if (isPairingFrame(bytes)) {
        const payload = pairingPayload(bytes, INIT_CODE_SIZE);
        if (!initCode && payload && pairingCodeKind(payload) === "init") initCode = payload;
        return false;
      }
      if (!initCode) return false;
      if (typed === null) {
        // The user has not typed yet: the frame is only pixels.
        ignoredBeforeCode++;
        if (ignoredBeforeCode < 2) return false;
        typed = attempts.shift()!;
        receiver = new ReceiverSession(crypto);
        receiver.scanInitCode(initCode);
        receiver.events.on("rejection", ({ reason }) => {
          if (reason === "falsifiee") forged++;
        });
        await receiver.pairWithPassphrase(typed);
        // The SAS is what the user compares: different only for the wrong code.
        expect(receiver.sas() === senderSas).toBe(typed === code);
        receiver.confirmSas(); // the user confirms anyway: the frames still say no
        return false;
      }
      await receiver.receiveFrame(bytes);
      if (typed !== code && forged >= 3) {
        typed = null; // "wrong code? type it again"
        return false;
      }
      if (!receiver.done) return false;
      message = new TextDecoder().decode((await receiver.result()).data);
      return true;
    });
    expect(forged).toBeGreaterThanOrEqual(3);
    expect(message).toBe("Hello world — for your eyes only");
  }, 60_000);
});
