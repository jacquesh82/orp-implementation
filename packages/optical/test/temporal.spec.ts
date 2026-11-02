import { describe, expect, it } from "vitest";

import { CODEC, Codec, buildFrame, readFrame, FRAME_VERSION, SYMBOL_SIZE, mulberry32, frameSize } from "@optirelay/core";
import {
  TM_ALIGNMENT,
  analyzeSubframe,
  tmCapacity,
  decodeTm,
  decideTm,
  directionIndex,
  locate,
  locateTm,
  measureTmPair,
  tmTestPattern,
  TM_DATA_MODULES,
  TM_PALETTE,
  simulateCapture,
  payloadSubframe,
  referenceSubframe,
  type ImageRGBA,
  type SimulationOptions,
} from "../src/index.ts";

function testFrame(codec: Codec): Uint8Array {
  const count = codec === CODEC.COLOR_8 ? 4 : 2;
  const rng = mulberry32(2026 + codec);
  const payload = Uint8Array.from({ length: count * SYMBOL_SIZE }, () => Math.floor(rng() * 256));
  const header = { version: FRAME_VERSION, codec, flags: 0, token: 0x544d38, block: 1, k: 4, symbolCount: count, seed: 7 };
  return buildFrame(header, payload);
}

/** Captures R then P — INDEPENDENT noise between the two (seed + 1), as on a real camera. */
function capture(raw: Uint8Array, codec: Codec, options: SimulationOptions, optionsP: SimulationOptions = { ...options, seed: (options.seed ?? 42) + 1 }) {
  return {
    ref: simulateCapture(referenceSubframe(raw, codec), TM_PALETTE, options),
    pay: simulateCapture(payloadSubframe(raw, codec), TM_PALETTE, optionsP),
  };
}

function errors(expected: Uint8Array, readBack: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < expected.length; i++) if (expected[i] !== readBack[i]) n++;
  return n;
}

const HOSTILE: SimulationOptions = { rotationDegrees: 4, gains: [1.4, 0.65, 1.2], noise: 7, seed: 5, haze: [30, -15, 10] };

describe("TM subframes", () => {
  it("R: black/white structure, 5×5 alignment, gray data and pilots; P: 8 directions at the pilots", () => {
    const raw = testFrame(CODEC.COLOR_8);
    const ref = referenceSubframe(raw, CODEC.COLOR_8);
    const pay = payloadSubframe(raw, CODEC.COLOR_8);
    const [ax, ay] = TM_ALIGNMENT;
    expect(ref[3 * 41 + 3]).toBe(0);
    expect(ref[ay * 41 + ax]).toBe(0); // black center
    expect(ref[ay * 41 + ax + 1]).toBe(1); // white ring
    expect(ref[ay * 41 + ax + 2]).toBe(0); // black ring
    expect(pay[ay * 41 + ax]).toBe(0);
    expect(ref[10 * 41 + 10]).toBe(2);
    expect(pay[10 * 41 + 10]).toBeGreaterThanOrEqual(3);
    const pilots = new Set<number>();
    for (let i = 0; i < 8; i++) pilots.add(pay[40 * 41 + 8 + i]!);
    expect(pilots.size).toBe(8);
  });

  it("the direction index maps the bits onto the channels (r = b2, g = b1, b = b0)", () => {
    expect(TM_PALETTE[directionIndex(1, 0, 1)]).toEqual([192, 64, 192]);
    expect(TM_PALETTE[directionIndex(0, 1, 0)]).toEqual([64, 192, 64]);
  });

  it("TM4 only emits the 4 even-parity vertices", () => {
    const pay = payloadSubframe(testFrame(CODEC.COLOR_4), CODEC.COLOR_4);
    const seenSet = new Set<number>();
    for (const [x, y] of TM_DATA_MODULES) seenSet.add(pay[y * 41 + x]! - 3);
    expect([...seenSet].sort()).toEqual([0, 3, 5, 6]); // 000, 011, 101, 110
  });

  it("the session frames fit in the TM capacity (alignment pattern deducted)", () => {
    expect(TM_DATA_MODULES.length).toBe(1398);
    expect(tmCapacity(CODEC.COLOR_8)).toBeGreaterThanOrEqual(frameSize(4, true));
    expect(tmCapacity(CODEC.COLOR_4)).toBeGreaterThanOrEqual(frameSize(2, true));
  });

  it("the TM test pattern is deterministic", () => {
    expect(Array.from(tmTestPattern(CODEC.COLOR_8).payload)).toEqual(Array.from(tmTestPattern(CODEC.COLOR_8).payload));
  });
});

describe("TM over a hostile channel — byte-exact decoding without calibration", () => {
  for (const codec of [CODEC.COLOR_8, CODEC.COLOR_4] as const) {
    const name = codec === CODEC.COLOR_8 ? "TM8" : "TM4";

    it(`${name}: distorted gains, additive haze, rotation, noise`, () => {
      const raw = testFrame(codec);
      const { ref, pay } = capture(raw, codec, HOSTILE);
      const r = decodeTm(ref, pay, codec);
      expect(errors(raw, r.bytes), `gains ${r.gains}`).toBe(0);
      expect(r.meanConfidence).toBeGreaterThan(0.4);
      expect(() => readFrame(r.bytes)).not.toThrow();
    });

    it(`${name}: perspective (keystone) — homography through the alignment pattern`, () => {
      const raw = testFrame(codec);
      // ≈ phone tilted by 15-20°: the bottom-right corner is 8 modules away from
      // the affine prediction.
      const options: SimulationOptions = { perspective: [0.15, -0.1], scale: 0.75, rotationDegrees: 6, noise: 5, seed: 9, moduleSize: 10 };
      const { ref, pay } = capture(raw, codec, options);
      const r = decodeTm(ref, pay, codec);
      expect(r.location.alignment).not.toBeNull();
      expect(r.location.perspectiveSkew).toBeGreaterThan(5);
      expect(errors(raw, r.bytes)).toBe(0);
      // Control: the affine alone (three finders, former behavior) reads the
      // grid off target — almost every byte is wrong.
      const affR = locate(ref)!;
      const affP = locate(pay, undefined, affR)!;
      const sentinel = decideTm(measureTmPair(analyzeSubframe(ref, affR), analyzeSubframe(pay, affP)).soft, codec);
      expect(errors(raw, sentinel.bytes)).toBeGreaterThan(raw.length / 2);
    });

    it(`${name}: channel crosstalk and different exposure between R and P`, () => {
      const raw = testFrame(codec);
      const matrix = [
        [0.75, 0.3, -0.12],
        [0.28, 0.7, 0.18],
        [-0.1, 0.32, 0.72],
      ] as const;
      const { ref, pay } = capture(
        raw,
        codec,
        { matrix, gains: [1.1, 1, 0.9], haze: [12, 8, 20], noise: 5, seed: 3 },
        // P captured with another exposure and another white balance
        { matrix, gains: [0.85, 0.95, 1.1], haze: [25, 0, 5], noise: 5, seed: 4 },
      );
      const r = decodeTm(ref, pay, codec);
      expect(r.fullMatrix).toBe(true);
      expect(r.crosstalk).toBeGreaterThan(0.2);
      expect(errors(raw, r.bytes)).toBe(0);
    });

    it(`${name}: rotated phone (90°, 180°) — finder order by cross product`, () => {
      const raw = testFrame(codec);
      for (const rotationDegrees of [90, 180, 233]) {
        const { ref, pay } = capture(raw, codec, { rotationDegrees, scale: 0.7, noise: 4, seed: rotationDegrees, moduleSize: 12 });
        const r = decodeTm(ref, pay, codec);
        expect(errors(raw, r.bytes), `rotation ${rotationDegrees}°`).toBe(0);
      }
    });
  }

  it("TM4 withstands strong noise better than TM8 (soft decision on the tetrahedron)", () => {
    const options: SimulationOptions = { gains: [1.3, 0.55, 1.15], noise: 60, seed: 40 };
    const read = (codec: Codec) => {
      const raw = testFrame(codec);
      const { ref, pay } = capture(raw, codec, options);
      const r = decodeTm(ref, pay, codec);
      return { errors: errors(raw, r.bytes), uncertain: r.uncertainShare };
    };
    const tm8 = read(CODEC.COLOR_8);
    const tm4 = read(CODEC.COLOR_4);
    expect(tm8.errors).toBeGreaterThan(10);
    expect(tm4.errors).toBeLessThan(tm8.errors / 5);
    expect(tm4.uncertain).toBeLessThan(tm8.uncertain);
  });
});

describe("pairing and accumulation", () => {
  it("classifies R, P and MIXED (rolling shutter during the switch)", () => {
    const raw = testFrame(CODEC.COLOR_8);
    const { ref, pay } = capture(raw, CODEC.COLOR_8, { gains: [1.2, 0.9, 1.1], noise: 4 });
    const loc = locateTm(ref)!;
    expect(analyzeSubframe(ref, loc).type).toBe("R");
    expect(analyzeSubframe(pay, locateTm(pay)!).type).toBe("P");
    // Top half R, bottom half P.
    const mixed: ImageRGBA = { width: ref.width, height: ref.height, data: new Uint8ClampedArray(ref.data) };
    const cut = Math.floor(ref.height / 2) * ref.width * 4;
    mixed.data.set(pay.data.subarray(cut), cut);
    expect(analyzeSubframe(mixed, loc).type).toBe("mixed");
  });

  it("the soft accumulation of several noisy pairs beats the best single pair", () => {
    const codec = CODEC.COLOR_8;
    const raw = testFrame(codec);
    const cumulative = new Float32Array(TM_DATA_MODULES.length * 3);
    let best = Infinity;
    for (let trial = 0; trial < 4; trial++) {
      const o = { gains: [1.2, 0.6, 1.1] as const, noise: 45, moduleSize: 6 };
      const { ref, pay } = capture(raw, codec, { ...o, seed: 100 + trial * 2 }, { ...o, seed: 101 + trial * 2 });
      const locR = locateTm(ref)!;
      const measurement = measureTmPair(analyzeSubframe(ref, locR), analyzeSubframe(pay, locateTm(pay, locR)!));
      best = Math.min(best, errors(raw, decideTm(measurement.soft, codec).bytes));
      for (let i = 0; i < cumulative.length; i++) cumulative[i]! += measurement.soft[i]!;
    }
    const cumulated = errors(raw, decideTm(cumulative, codec).bytes);
    expect(best).toBeGreaterThan(0);
    expect(cumulated).toBeLessThan(best);
  });
});
