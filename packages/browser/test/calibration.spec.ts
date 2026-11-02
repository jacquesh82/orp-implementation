import { describe, expect, it } from "vitest";
import { CODEC, buildFrame, FLAG, SYMBOL_SIZE, FRAME_VERSION } from "@optirelay/core";
import { TM_ALIGNMENT, degradeImage, locateAll, TM_PALETTE, TmMosaicReceiver, renderMosaic, payloadSubframe, referenceSubframe } from "@optirelay/optical";
import {
  FRAME_PAYLOAD_SIZE,
  calibrationCode,
  CALIBRATION_TRIALS,
  readCalibration,
  readCalibrationCode,
  CalibrationMeasurement,
  CALIBRATION_PREAMBLE,
  calibrationFrame,
  loadCalibration,
  saveCalibration,
  CALIBRATION_KEY,
} from "../src/calibration.ts";

describe("calibration", () => {
  it("a calibration frame carries its trial and its index; another frame is not one", () => {
    expect(readCalibration(calibrationFrame(4, 37))).toEqual({ trial: 4, index: 37 });
    const other = buildFrame(
      { version: FRAME_VERSION, codec: CODEC.COLOR_8, flags: FLAG.TEST_PATTERN, token: 1, block: 4, k: 1, symbolCount: 1, seed: 0 },
      new Uint8Array(SYMBOL_SIZE),
    );
    expect(readCalibration(other)).toBeNull();
    expect(readCalibration(new Uint8Array(10))).toBeNull();
    // Deterministic content, different from one frame to the next.
    expect(calibrationFrame(2, 5)).toEqual(calibrationFrame(2, 5));
    expect(calibrationFrame(2, 5)).not.toEqual(calibrationFrame(2, 6));
  });

  it("measurement: duplicates and preamble ignored, share and throughput per trial, recommendation", () => {
    const m = new CalibrationMeasurement();
    expect(m.add(calibrationFrame(CALIBRATION_PREAMBLE, 0))).toBe(false);
    // Trial 2 (33 ms · 1): 40 frames out of 50; trial 4 (33 ms · 2×2): 120 out of 200; trial 7: 30 out of 100.
    for (let r = 0; r < 50; r++) if (r % 5 !== 0) m.add(calibrationFrame(2, r));
    m.add(calibrationFrame(2, 49));
    expect(m.add(calibrationFrame(2, 1))).toBe(false); // duplicate
    for (let r = 0; r < 200; r++) if (r % 5 < 3) m.add(calibrationFrame(4, r));
    m.add(calibrationFrame(4, 199));
    for (let r = 0; r < 100; r++) if (r % 10 < 3) m.add(calibrationFrame(7, r));
    m.add(calibrationFrame(7, 99));
    const res = m.results();
    const e2 = res.find((e) => e.id === 2)!;
    expect(e2.readCount).toBe(40);
    expect(e2.sentCount).toBe(50);
    expect(e2.share).toBeCloseTo(0.8);
    expect(e2.throughput).toBeCloseTo((40 * FRAME_PAYLOAD_SIZE) / 2.5);
    expect(res.find((e) => e.id === 1)!.readCount).toBe(0);
    // Does trial 7 have the most frames per second? No: 31 read < 121; and it is under 50 %.
    const best = m.recommendation()!;
    expect(best.id).toBe(4);
    expect(calibrationCode(best)).toBe("33-2");
  });

  it("no frame: no recommendation", () => {
    expect(new CalibrationMeasurement().recommendation()).toBeNull();
  });

  it("short codes", () => {
    expect(readCalibrationCode("33-2")).toEqual({ period: 33, columns: 2 });
    expect(readCalibrationCode(" 17 × 3 ")).toEqual({ period: 17, columns: 3 });
    expect(readCalibrationCode("67 1")).toEqual({ period: 67, columns: 1 });
    expect(readCalibrationCode("33-4")).toEqual({ period: 33, columns: 4 });
    expect(readCalibrationCode("8-3")).toEqual({ period: 8, columns: 3 });
    expect(readCalibrationCode("33-8")).toBeNull();
    expect(readCalibrationCode("33-0")).toBeNull();
    expect(readCalibrationCode("42-2")).toBeNull();
    expect(readCalibrationCode("n'importe")).toBeNull();
    for (const e of CALIBRATION_TRIALS) expect(readCalibrationCode(calibrationCode(e))).toEqual({ period: e.period, columns: e.columns });
  });

  it("optical end to end: a 2×2 mosaic of calibration frames is read, trial and index included", () => {
    const receiver = new TmMosaicReceiver();
    const m = new CalibrationMeasurement();
    let t = 0;
    for (let batch = 0; batch < 4; batch++) {
      const frames = Array.from({ length: 4 }, (_, k) => calibrationFrame(4, batch * 4 + k));
      const opt = { moduleSize: 7, quietZone: 2 };
      const r = renderMosaic(frames.map((x) => referenceSubframe(x, CODEC.COLOR_8)), TM_PALETTE, 2, opt);
      const p = renderMosaic(frames.map((x) => payloadSubframe(x, CODEC.COLOR_8)), TM_PALETTE, 2, opt);
      for (const img of [r, p]) {
        const d = degradeImage(img, { gains: [1.05, 0.95, 1], noise: 3, seed: batch });
        for (const res of receiver.process(d, locateAll(d, TM_ALIGNMENT), (t += 33))) {
          if (res.frame?.isNew) m.add(res.frame.bytes);
        }
      }
    }
    const e4 = m.results().find((e) => e.id === 4)!;
    expect(e4.readCount).toBe(16);
    expect(e4.sentCount).toBe(16);
  });
});

describe("stored calibration", () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k) => m.get(k) ?? null,
      key: (i) => [...m.keys()][i] ?? null,
      removeItem: (k) => void m.delete(k),
      setItem: (k, v) => void m.set(k, v),
    };
  };

  it("saves and reads back a calibration", () => {
    const storage = memory();
    expect(saveCalibration({ period: 33, columns: 2 }, "sender", storage)).toBe(true);
    expect(loadCalibration(storage)).toMatchObject({ period: 33, columns: 2, code: "33-2", side: "sender" });
  });

  it("converts the format of earlier versions (French keys) and writes it back", () => {
    const storage = memory();
    storage.setItem(CALIBRATION_KEY, JSON.stringify({ periode: 17, colonnes: 3, code: "17-3", date: 5, cote: "emetteur" }));
    expect(loadCalibration(storage)).toEqual({ period: 17, columns: 3, code: "17-3", date: 5, side: "sender" });
    expect(JSON.parse(storage.getItem(CALIBRATION_KEY)!)).toEqual({ period: 17, columns: 3, code: "17-3", date: 5, side: "sender" });
    storage.setItem(CALIBRATION_KEY, JSON.stringify({ periode: 33, colonnes: 1, cote: "recepteur" }));
    expect(loadCalibration(storage)?.side).toBe("receiver");
  });

  it("nothing or garbage stored: null", () => {
    const storage = memory();
    expect(loadCalibration(storage)).toBeNull();
    storage.setItem(CALIBRATION_KEY, "{not json");
    expect(loadCalibration(storage)).toBeNull();
    storage.setItem(CALIBRATION_KEY, JSON.stringify({ period: 9, columns: 2, side: "sender" }));
    expect(loadCalibration(storage)).toBeNull();
  });
});
