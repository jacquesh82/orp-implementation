import { describe, expect, it } from "vitest";
import { CODEC, CryptoWebCrypto, mulberry32, SenderSession, ReceiverSession, SYMBOL_SIZE, type Codec } from "../src/index.ts";

/** Frames needed to rebuild a file, over a LOSSLESS channel. */
async function framesNeeded(size: number, codec: Codec): Promise<{ frames: number; k: number }> {
  const crypto = new CryptoWebCrypto();
  const rng = mulberry32(size);
  const file = Uint8Array.from({ length: size }, () => Math.floor(rng() * 256)); // incompressible
  const sender = new SenderSession(crypto, { codecs: [codec], compression: false });
  const receiver = new ReceiverSession(crypto);
  await sender.prepare(file);
  receiver.scanInitCode(sender.initCode());
  await sender.receiveResponseCode(await receiver.responseCode());
  await receiver.receiveRevealCode(sender.revealCode());
  sender.confirmSas();
  receiver.confirmSas();
  let frames = 0;
  await sender.start(async (t) => {
    frames++;
    await receiver.receiveFrame(t);
    if (receiver.done || frames > 2000) sender.finish();
  });
  expect(receiver.done).toBe(true);
  return { frames, k: Math.ceil(size / SYMBOL_SIZE) };
}

describe("fountain code efficiency per frame", () => {
  for (const [codec, perFrame] of [[CODEC.COLOR_8, 4], [CODEC.COLOR_4, 2]] as const) {
    it(`${perFrame} new symbols per frame — large block (k = 200): near ideal thanks to Gauss`, async () => {
      const { frames, k } = await framesNeeded(19_200, codec);
      // Ideal k / perFrame; the fixed bug (reused seeds) multiplied the number
      // of frames by perFrame, and peeling alone added ~30 %.
      expect(frames).toBeLessThanOrEqual(Math.ceil((1.1 * k) / perFrame) + 1);
    });

    it(`${perFrame} new symbols per frame — small block (k = 63): bounded LT overhead`, async () => {
      const { frames, k } = await framesNeeded(6000, codec);
      // Small K: some source symbols stay uncovered for longer (low degrees of
      // the robust soliton, frozen by the protocol) — no elimination can
      // recover them. The overhead stays bounded, not ×perFrame.
      expect(frames).toBeLessThanOrEqual(Math.ceil((1.8 * k) / perFrame));
    });
  }
});
