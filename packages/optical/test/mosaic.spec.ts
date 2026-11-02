import { describe, expect, it } from "vitest";
import { CODEC, Codec, buildFrame, mulberry32, SYMBOL_SIZE, FRAME_VERSION } from "@optirelay/core";
import {
  TM_ALIGNMENT,
  degradeImage,
  locateAll,
  TM_PALETTE,
  TmMosaicReceiver,
  renderMosaic,
  payloadSubframe,
  referenceSubframe,
  type SimulationOptions,
} from "../src/index.ts";

function frame(codec: Codec, seed: number): Uint8Array {
  const count = codec === CODEC.COLOR_8 ? 4 : 2;
  const rng = mulberry32(seed);
  const payload = Uint8Array.from({ length: count * SYMBOL_SIZE }, () => Math.floor(rng() * 256));
  return buildFrame({ version: FRAME_VERSION, codec, flags: 0, token: 9, block: 0, k: 40, symbolCount: count, seed }, payload);
}

/** A batch: n different frames displayed together, R then P. */
function batch(frames: Uint8Array[], codec: Codec, columns: number, moduleSize: number) {
  const options = { moduleSize, quietZone: 2 };
  return {
    r: renderMosaic(frames.map((t) => referenceSubframe(t, codec)), TM_PALETTE, columns, options),
    p: renderMosaic(frames.map((t) => payloadSubframe(t, codec)), TM_PALETTE, columns, options),
  };
}

const CHANNEL: SimulationOptions = { rotationDegrees: 4, scale: 0.92, gains: [1.2, 0.85, 1.1], noise: 5 };

describe("mosaic: several frames per screen", () => {
  for (const [columns, moduleSize] of [[2, 8], [3, 7], [4, 7]] as const) {
    it(`${columns}×${columns}: every grid found and decoded, reading order preserved`, () => {
      const n = columns * columns;
      const frames = Array.from({ length: n }, (_, i) => frame(CODEC.COLOR_8, 100 + i));
      const { r, p } = batch(frames, CODEC.COLOR_8, columns, moduleSize);
      const imgR = degradeImage(r, { ...CHANNEL, seed: 1 });
      const imgP = degradeImage(p, { ...CHANNEL, seed: 2 });
      const locsR = locateAll(imgR, TM_ALIGNMENT);
      expect(locsR.length).toBe(n);
      const receiver = new TmMosaicReceiver();
      receiver.process(imgR, locsR, 0);
      const results = receiver.process(imgP, locateAll(imgP, TM_ALIGNMENT), 250);
      const decodedFrames = results.map((x) => x.frame?.bytes).filter((o): o is Uint8Array => !!o);
      expect(decodedFrames.length).toBe(n);
      frames.forEach((t, i) => expect(Array.from(decodedFrames[i]!.subarray(0, t.length))).toEqual(Array.from(t)));
    });
  }

  it("two successive batches: each cell keeps its pairing, eight new frames", () => {
    const receiver = new TmMosaicReceiver();
    const received = new Set<string>();
    let t = 0;
    for (const base of [200, 300]) {
      const frames = Array.from({ length: 4 }, (_, i) => frame(CODEC.COLOR_8, base + i));
      const { r, p } = batch(frames, CODEC.COLOR_8, 2, 8);
      for (const [img, g] of [[r, base], [p, base + 1]] as const) {
        const deg = degradeImage(img, { ...CHANNEL, seed: g });
        for (const res of receiver.process(deg, locateAll(deg, TM_ALIGNMENT), (t += 100))) {
          if (res.frame?.isNew) received.add(Array.from(res.frame.bytes.subarray(0, 40)).join(","));
        }
      }
    }
    expect(received.size).toBe(8);
  });
});

describe("mosaic on a real camera: the P subframe hides grids", () => {
  it("R shows the 4 grids, P only lets one be seen: the 4 cells are read anyway", () => {
    const frames = Array.from({ length: 4 }, (_, i) => frame(CODEC.COLOR_8, 400 + i));
    const { r, p } = batch(frames, CODEC.COLOR_8, 2, 8);
    const imgR = degradeImage(r, { ...CHANNEL, seed: 7 });
    const imgP = degradeImage(p, { ...CHANNEL, seed: 8 });
    const receiver = new TmMosaicReceiver();
    receiver.process(imgR, locateAll(imgR, TM_ALIGNMENT), 0);
    // Partial detection on P: a single grid found in this image.
    const results = receiver.process(imgP, locateAll(imgP, TM_ALIGNMENT).slice(0, 1), 150);
    const decodedFrames = results.filter((x) => x.frame).length;
    expect(decodedFrames).toBe(4);
    expect(receiver.stats.validCount).toBe(4);
  });
});
