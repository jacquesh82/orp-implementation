import { describe, expect, it } from "vitest";

import {
  CODEC,
  buildFrame,
  readFrame,
  mulberry32,
  SYMBOL_SIZE,
  FRAME_VERSION,
  type FrameHeader,
} from "@optirelay/core";
import {
  availableBits,
  calibrate,
  encodePairingCode,
  decodeGrid,
  encodeTestPattern,
  encodeFrame,
  DATA_MODULE_COUNT,
  paletteOf,
  render,
  simulateCapture,
  validateMode,
} from "../src/index.ts";

function testFrame(codec: FrameHeader["codec"], symbolCount: number): { header: FrameHeader; payload: Uint8Array } {
  const rng = mulberry32(2026);
  const payload = Uint8Array.from({ length: symbolCount * SYMBOL_SIZE }, () => Math.floor(rng() * 256));
  return {
    header: { version: FRAME_VERSION, codec, flags: 0, token: 0x11223344, block: 2, k: 50, symbolCount, seed: 99 },
    payload,
  };
}

describe("v0.1 grid", () => {
  it("offers 1423 data modules and a capacity consistent with the protocol", () => {
    expect(DATA_MODULE_COUNT).toBe(1423);
    expect(availableBits(CODEC.MONO_2)).toBe(1423);
    expect(availableBits(CODEC.COLOR_8)).toBe(3 * 1423);
  });
});

describe("round trip frame → grid → render → decode", () => {
  for (const [codec, count] of [
    [CODEC.MONO_2, 1],
    [CODEC.COLOR_4, 2],
    [CODEC.COLOR_8, 4],
  ] as const) {
    it(`codec ${codec} — ideal capture`, () => {
      const { header, payload } = testFrame(codec, count);
      const grid = encodeFrame(header, payload);
      const image = render(grid, paletteOf(codec), { moduleSize: 8 });
      const result = decodeGrid(image, codec);
      const decoded = readFrame(result.bytes);
      expect(decoded.header.token).toBe(0x11223344);
      expect(decoded.header.block).toBe(2);
      expect(decoded.payload).toEqual(payload);
      expect(result.meanConfidence, `codec ${codec}`).toBeGreaterThan(0.8);
    });
  }
});

describe("geometric robustness (camera simulation)", () => {
  it("supports rotation, scale and translation in MONO_2", () => {
    const { header, payload } = testFrame(CODEC.MONO_2, 1);
    const grid = encodeFrame(header, payload);
    for (const options of [
      { rotationDegrees: 5 },
      { rotationDegrees: -6 },
      { scale: 0.8 },
      { scale: 1.08, translation: [8, -6] as const },
    ]) {
      const image = simulateCapture(grid, paletteOf(CODEC.MONO_2), options);
      const decoded = readFrame(decodeGrid(image, CODEC.MONO_2).bytes);
      expect(decoded.payload, `options ${JSON.stringify(options)}`).toEqual(payload);
    }
  });

  it("supports rotation and scale in COLOR_8 with calibration (D-008: calibration is mandatory)", () => {
    const { header, payload } = testFrame(CODEC.COLOR_8, 4);
    const grid = encodeFrame(header, payload);
    const testPattern = encodeTestPattern(CODEC.COLOR_8);
    for (const options of [
      { rotationDegrees: 4 },
      { scale: 0.9 },
      { rotationDegrees: -5, scale: 0.95, translation: [-10, 15] as const },
    ]) {
      // Flow compliant with §5.3: test pattern captured in the same conditions as
      // the transfer, calibration, then decoding against the estimated classes.
      const calibrated = calibrate(simulateCapture(testPattern, paletteOf(CODEC.COLOR_8), options), CODEC.COLOR_8);
      const image = simulateCapture(grid, paletteOf(CODEC.COLOR_8), options);
      const decoded = readFrame(decodeGrid(image, CODEC.COLOR_8, { palette: calibrated }).bytes);
      expect(decoded.payload, `options ${JSON.stringify(options)}`).toEqual(payload);
    }
  }, 20000);

  it("absorbs a moderate noise in COLOR_8 (σ = 6)", () => {
    const { header, payload } = testFrame(CODEC.COLOR_8, 4);
    const grid = encodeFrame(header, payload);
    const image = simulateCapture(grid, paletteOf(CODEC.COLOR_8), { noise: 6, seed: 7 });
    const decoded = readFrame(decodeGrid(image, CODEC.COLOR_8).bytes);
    expect(decoded.payload).toEqual(payload);
  });
});

describe("scale robustness (scan regression)", () => {
  it("detects and decodes the frame at every module size — the cursor−4 jump skipped finders", () => {
    // Regression from the real bench (REC-05): after a false measurement
    // ending at the start of a finder, the scan jumped to cursor−4 — 80 px
    // at 12 px/module — and missed the finder. The TR one disappeared
    // depending on the data content.
    for (const moduleSize of [10, 12, 16, 24]) {
      const { header, payload } = testFrame(CODEC.COLOR_8, 4);
      const image = render(encodeFrame(header, payload), paletteOf(CODEC.COLOR_8), { moduleSize });
      const decoded = readFrame(decodeGrid(image, CODEC.COLOR_8).bytes);
      expect(decoded.payload, `tailleModule ${moduleSize}`).toEqual(payload);
    }
  });
});

describe("calibration (F-05, §5.3)", () => {
  it("finds the nominal centroids on an ideal capture", () => {
    const testPattern = encodeTestPattern(CODEC.COLOR_8);
    const image = simulateCapture(testPattern, paletteOf(CODEC.COLOR_8), {});
    const calibrated = calibrate(image, CODEC.COLOR_8);
    expect(calibrated.centroids).toHaveLength(8);
    expect(calibrated.confidence).toBeGreaterThan(0.75);
    // The calibrated centroids classify better than the nominal ones.
    const { header, payload } = testFrame(CODEC.COLOR_8, 4);
    const frameImage = simulateCapture(encodeFrame(header, payload), paletteOf(CODEC.COLOR_8), {});
    const withCalibration = decodeGrid(frameImage, CODEC.COLOR_8, { palette: calibrated });
    const decoded = readFrame(withCalibration.bytes);
    expect(decoded.payload).toEqual(payload);
  });

  it("compensates a tint of the screen/camera pair: calibrated decodes better than nominal", () => {
    const gains: [number, number, number] = [1.25, 0.85, 1.1];
    const testPattern = encodeTestPattern(CODEC.COLOR_8);
    const tintedTestPattern = simulateCapture(testPattern, paletteOf(CODEC.COLOR_8), { gains });
    const calibrated = calibrate(tintedTestPattern, CODEC.COLOR_8);

    const { header, payload } = testFrame(CODEC.COLOR_8, 4);
    const image = simulateCapture(encodeFrame(header, payload), paletteOf(CODEC.COLOR_8), { gains });
    const withCalibration = decodeGrid(image, CODEC.COLOR_8, { palette: calibrated });
    const asNominal = decodeGrid(image, CODEC.COLOR_8);
    const decoded = readFrame(withCalibration.bytes);
    expect(decoded.payload).toEqual(payload);
    expect(withCalibration.meanConfidence).toBeGreaterThan(asNominal.meanConfidence);
  });

  it("validates the 8-color mode on a series of trial images (§5.3-4)", () => {
    const testPattern = encodeTestPattern(CODEC.COLOR_8);
    const captures = [
      simulateCapture(testPattern, paletteOf(CODEC.COLOR_8), { rotationDegrees: 3 }),
      simulateCapture(testPattern, paletteOf(CODEC.COLOR_8), { scale: 0.9 }),
      simulateCapture(testPattern, paletteOf(CODEC.COLOR_8), { noise: 4, seed: 3 }),
    ];
    const verdict = validateMode(CODEC.COLOR_8, captures, captures.map(() => undefined));
    expect(verdict.valid).toBe(true);
    expect(verdict.confidences.every((c) => c > 0.5)).toBe(true);
  });
});

describe("optical pairing codes (§7)", () => {
  it("encodes and reads back an init code in COLOR_4", () => {
    const payload = new Uint8Array(100).map((_, i) => (i * 13) & 0xff);
    const grid = encodePairingCode(payload);
    const image = simulateCapture(grid, paletteOf(CODEC.COLOR_4), { rotationDegrees: 3 });
    const decoded = readFrame(decodeGrid(image, CODEC.COLOR_4).bytes);
    expect(decoded.header.flags & 0x08).toBeTruthy();
    expect(Array.from(decoded.payload.subarray(0, 100))).toEqual(Array.from(payload));
  });
});

describe("unencrypted frames vs capacity", () => {
  it("the codec capacity does bound nb_symboles (heaviest encrypted frame)", () => {
    // An encrypted frame of maximum capacity must fit in the grid:
    for (const [codec, count] of [
      [CODEC.MONO_2, 1],
      [CODEC.COLOR_4, 2],
      [CODEC.COLOR_8, 4],
    ] as const) {
      const payload = new Uint8Array(count * SYMBOL_SIZE);
      const tag = new Uint8Array(16);
      const raw = buildFrame(
        { version: FRAME_VERSION, codec, flags: 0x02, token: 1, block: 1, k: 1, symbolCount: count, seed: 1 },
        payload,
        tag,
      );
      expect(raw.length * 8, `codec ${codec}`).toBeLessThanOrEqual(DATA_MODULE_COUNT * (codec === CODEC.MONO_2 ? 1 : codec === CODEC.COLOR_4 ? 2 : 3));
    }
  });
});
