import { describe, expect, it } from "vitest";
import { CODEC, Codec, buildFrame, mulberry32, SYMBOL_SIZE, FRAME_VERSION } from "@optirelay/core";
import { TM_ALIGNMENT, locateAll, TM_PALETTE, TmReceiver, simulateCapture, payloadSubframe, referenceSubframe, type SimulationOptions } from "../src/index.ts";

function frame(codec: Codec, seed: number): Uint8Array {
  const count = codec === CODEC.COLOR_8 ? 4 : 2;
  const rng = mulberry32(seed);
  const payload = Uint8Array.from({ length: count * SYMBOL_SIZE }, () => Math.floor(rng() * 256));
  return buildFrame({ version: FRAME_VERSION, codec, flags: 0, token: 7, block: 0, k: 8, symbolCount: count, seed }, payload);
}

describe("TmReceiver — stream of scrolling frames", () => {
  for (const codec of [CODEC.COLOR_8, CODEC.COLOR_4] as const) {
    it(`${codec === CODEC.COLOR_8 ? "TM8" : "TM4"}: R, P1, R, P2, R, P3 → three frames, mode recognized without knowing it`, () => {
      const frames = [frame(codec, 11), frame(codec, 12), frame(codec, 13)];
      const options: SimulationOptions = { rotationDegrees: 3, gains: [1.2, 0.8, 1.1], noise: 5, perspective: [0.08, 0], scale: 0.85 };
      const receiver = new TmReceiver();
      const received: Uint8Array[] = [];
      let t = 0;
      let seed = 1;
      for (const raw of frames) {
        for (const grid of [referenceSubframe(raw, codec), payloadSubframe(raw, codec)]) {
          const r = receiver.process(simulateCapture(grid, TM_PALETTE, { ...options, seed: seed++ }), (t += 250));
          if (r.frame?.isNew) {
            expect(r.frame.codec).toBe(codec);
            received.push(r.frame.bytes);
          }
        }
      }
      expect(received.length).toBe(3);
      frames.forEach((b, i) => expect(Array.from(received[i]!.subarray(0, b.length))).toEqual(Array.from(b)));
      expect(receiver.stats.mixedCount).toBe(0);
    });
  }

  it("rejects a pair too far apart in time", () => {
    const raw = frame(CODEC.COLOR_8, 3);
    const receiver = new TmReceiver({ validityDuration: 500 });
    receiver.process(simulateCapture(referenceSubframe(raw, CODEC.COLOR_8), TM_PALETTE, {}), 0);
    const r = receiver.process(simulateCapture(payloadSubframe(raw, CODEC.COLOR_8), TM_PALETTE, {}), 2000);
    expect(r.frame).toBeUndefined();
  });
});

describe("TmReceiver — still camera, hard conditions", () => {
  it("the geometry does not jump and no pair is lost", () => {
    // Tilt, haze, tint: on some P subframes, the global search picked a false
    // triangle (jump of ~270 px) or missed the alignment pattern — 8 pairs
    // out of 59 lost, green/orange frame.
    const options: SimulationOptions = {
      rotationDegrees: 4,
      noise: 10,
      perspective: [0.12, 0.05],
      scale: 0.85,
      blur: 1,
      gains: [1.2, 0.85, 1.1],
      haze: [20, 20, 25],
    };
    const receiver = new TmReceiver();
    let t = 0;
    let seed = 1;
    let pairs = 0;
    let validCount = 0;
    let jump = 0;
    let before: [number, number] | null = null;
    for (let i = 0; i < 30; i++) {
      const raw = frame(CODEC.COLOR_8, 100 + i);
      for (const grid of [referenceSubframe(raw, CODEC.COLOR_8), payloadSubframe(raw, CODEC.COLOR_8)]) {
        const image = simulateCapture(grid, TM_PALETTE, { ...options, seed: seed++ });
        const locs = locateAll(image, TM_ALIGNMENT);
        const r = locs[0] ? receiver.processLocated(image, locs[0], (t += 150)) : receiver.process(image, (t += 150));
        const loc = r.location!;
        expect(loc.alignment).not.toBeNull();
        if (before) jump = Math.max(jump, Math.hypot(loc.finders[0][0] - before[0], loc.finders[0][1] - before[1]));
        before = loc.finders[0];
        if (r.frame || r.invalidPair) pairs++;
        if (r.frame) validCount++;
      }
    }
    expect(jump).toBeLessThan(1);
    expect(pairs).toBe(59);
    expect(validCount).toBe(59);
  }, 30000);
});
