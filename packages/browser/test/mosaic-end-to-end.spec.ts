import { it, expect } from "vitest";
import { CODEC, CryptoWebCrypto, mulberry32, SenderSession, ReceiverSession } from "@optirelay/core";
import { TM_ALIGNMENT, degradeImage, locateAll, TM_PALETTE, TmMosaicReceiver, renderMosaic, payloadSubframe, referenceSubframe } from "@optirelay/optical";
import { frameCodec, isPairingFrame } from "../src/tm.ts";

it("app → app, 3×3 mosaic: every frame read is accepted and the file is rebuilt", async () => {
  const crypto = new CryptoWebCrypto();
  const rng = mulberry32(5);
  const file = Uint8Array.from({ length: 20000 }, () => Math.floor(rng() * 256));
  const em = new SenderSession(crypto, { codecs: [CODEC.COLOR_8, CODEC.COLOR_4] });
  const re = new ReceiverSession(crypto);
  await em.prepare(file);
  re.scanInitCode(em.initCode());
  await em.receiveResponseCode(await re.responseCode());
  em.confirmSas(); re.confirmSas();
  const rejections: Record<string, number> = {};
  re.events.on("rejection", ({ reason }) => { rejections[reason] = (rejections[reason] ?? 0) + 1; });
  const mosaic = new TmMosaicReceiver();
  let batch: Uint8Array[] = []; let t = 0; let acceptedCount = 0; let readCount = 0; let batches = 0;
  await em.start(async (frame) => {
    batch.push(frame);
    if (batch.length < 9) return;
    const shown = batch; batch = []; batches++;
    const opt = { moduleSize: 7, quietZone: 2 };
    const r = renderMosaic(shown.map((x) => referenceSubframe(x, frameCodec(x))), TM_PALETTE, 3, opt);
    const p = renderMosaic(shown.map((x) => payloadSubframe(x, frameCodec(x))), TM_PALETTE, 3, opt);
    for (const img of [r, p]) {
      const d = degradeImage(img, { gains: [1.1, 0.9, 1], noise: 4, seed: batches });
      for (const res of mosaic.process(d, locateAll(d, TM_ALIGNMENT), (t += 150))) {
        if (!res.frame?.isNew || isPairingFrame(res.frame.bytes)) continue;
        readCount++;
        const s = await re.receiveFrame(res.frame.bytes);
        if (s.accepted) acceptedCount++;
      }
    }
    if (re.done || batches > 30) em.finish();
  });
  expect(rejections).toEqual({});
  expect(acceptedCount).toBe(readCount);
  expect(re.done).toBe(true);
  expect(Array.from((await re.result()).data)).toEqual(Array.from(file));
}, 120000);

import { BENCH_PASSPHRASE } from "../src/tm.ts";

it("bench → app (bench passphrase, nothing typed): same codes, file received; different keys: visible \"falsifiee\" rejections", async () => {
  const crypto = new CryptoWebCrypto();
  const file = new TextEncoder().encode("bench to application test ".repeat(200));
  const em = new SenderSession(crypto, { codecs: [CODEC.COLOR_8], pairing: "passphrase" });
  await em.prepare(file);
  await em.receivePassphrase(BENCH_PASSPHRASE);
  const good = new ReceiverSession(crypto);
  const info = good.scanInitCode(em.initCode());
  expect(info.byPassphrase).toBe(true);
  await good.pairWithPassphrase(BENCH_PASSPHRASE);
  expect(good.sas()).toBe(em.sas());
  // The former defect: a receiver answering with a response code to a passphrase sender.
  const bad = new ReceiverSession(crypto);
  bad.scanInitCode(em.initCode());
  await bad.responseCode();
  em.confirmSas(); good.confirmSas(); bad.confirmSas();
  const refusals: string[] = [];
  bad.events.on("rejection", ({ reason }) => refusals.push(reason));
  await em.start(async (t) => {
    await good.receiveFrame(t);
    await bad.receiveFrame(t);
    if (good.done) em.finish();
  });
  expect(Array.from((await good.result()).data)).toEqual(Array.from(file));
  expect(refusals.length).toBeGreaterThan(0);
  expect(refusals.every((m) => m === "falsifiee")).toBe(true);
});
