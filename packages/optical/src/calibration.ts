/**
 * Color calibration (§5.3, F-05): the test pattern is captured, each data
 * module is attached to its closest nominal class, and the REAL centroid of
 * each class is estimated in Lab. The mean confidence of the margins gives
 * the score shown in diagnostic mode and the validation criterion of the
 * 8-color mode.
 */

import { Codec } from "@optirelay/core";
import { classify, labDistance, Lab, rgbToLab } from "./cielab.ts";
import { affineFromTriplet, detectFinders, sample, chooseTriplet, type Affine, type CalibratedPalette } from "./decoder.ts";
import { structuralGrid, DATA_MODULES, roleOf, GRID_SIZE } from "./grid.ts";
import { paletteOf } from "./palettes.ts";
import { ImageRGBA } from "./render.ts";

/**
 * Estimates the calibrated palette from the capture of a test pattern
 * produced by encodeTestPattern. The estimate does not depend on the seed:
 * it attaches each module to its closest nominal class, then averages in Lab.
 */
export function calibrate(image: ImageRGBA, codec: Codec, affine?: Affine): CalibratedPalette {
  const t =
    affine ??
    (() => {
      const triplet = chooseTriplet(detectFinders(image));
      if (!triplet) throw new Error("calibrate: finder patterns not found in the test pattern");
      return affineFromTriplet(triplet[0], triplet[1], triplet[2]);
    })();

  const palette = paletteOf(codec);
  const structure = structuralGrid(codec);

  // Pixel/module scale: distance between the centers of the TL and TR finders.
  const p0 = apply(t, 3.5, 3.5);
  const p1 = apply(t, 37.5, 3.5);
  const radius = Math.max(1, 0.32 * (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 34));

  // ── Channel drift estimated on the PILOTS (§5.1) ─────────────────────────
  // Their color is known: one gain per channel (least squares) brings the
  // initial centroids close to what the camera REALLY sees. Without it, a
  // strong tint sends a whole class (cyan → blue) into the wrong cluster
  // right away, and Lloyd can no longer save it.
  const gains = [1, 1, 1];
  {
    let sumSn = [0, 0, 0];
    let sumNn = [0, 0, 0];
    for (let py = 0; py < GRID_SIZE; py++) {
      for (let px = 0; px < GRID_SIZE; px++) {
        if (roleOf(px, py) !== "pilot") continue;
        const index = structure[py * GRID_SIZE + px]!;
        const nominal = palette[index]!;
        const [mx, my] = apply(t, px + 0.5, py + 0.5);
        const seen = sample(image, mx, my, radius);
        const seenSet = [seen.r, seen.g, seen.b];
        for (let c = 0; c < 3; c++) {
          sumSn[c] = sumSn[c]! + seenSet[c]! * nominal[c]!;
          sumNn[c] = sumNn[c]! + nominal[c]! * nominal[c]!;
        }
      }
    }
    for (let c = 0; c < 3; c++) {
      if (sumNn[c]! > 0) gains[c] = Math.min(1.6, Math.max(0.4, sumSn[c]! / sumNn[c]!));
    }
  }
  const initialCentroids = palette
    .map((c) => [c[0] * gains[0]!, c[1] * gains[1]!, c[2] * gains[2]!] as [number, number, number])
    .map(rgbToLab);

  const sums = initialCentroids.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
  const samples: Lab[] = [];
  for (const [x, y] of DATA_MODULES) {
    const [px, py] = apply(t, x + 0.5, y + 0.5);
    const c = sample(image, px, py, radius);
    const lab = rgbToLab([c.r, c.g, c.b]);
    samples.push(lab);
    const { index } = classify(lab, initialCentroids);
    const s = sums[index]!;
    s.l += lab.l;
    s.a += lab.a;
    s.b += lab.b;
    s.n++;
  }
  let centroids: Lab[] = sums.map((s) =>
    s.n > 0 ? { l: s.l / s.n, a: s.a / s.n, b: s.b / s.n } : { l: 0, a: 0, b: 0 },
  );
  // A few Lloyd iterations: refine the classes starting from the centroids
  // corrected by the pilot gains (2 passes are enough in practice).
  for (let pass = 0; pass < 3; pass++) {
    const recount = centroids.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
    for (const lab of samples) {
      const { index } = classify(lab, centroids);
      const r = recount[index]!;
      r.l += lab.l;
      r.a += lab.a;
      r.b += lab.b;
      r.n++;
    }
    centroids = recount.map((r, i) =>
      r.n > 0
        ? { l: r.l / r.n, a: r.a / r.n, b: r.b / r.n }
        : centroids[i]!,
    );
  }
  // SELF-CONSISTENT confidence: margins of the samples against the ESTIMATED
  // centroids — this is what measures the real separability of the channel (§5.3-2).
  let confidenceSum = 0;
  for (const lab of samples) confidenceSum += classify(lab, centroids).confidence;
  return { codec, centroids, confidence: samples.length > 0 ? confidenceSum / samples.length : 0 };
}

/**
 * Validates a color mode on a series of trial images (§5.3-4): the
 * calibration of EACH image must reach the quality threshold.
 */
export function validateMode(codec: Codec, captures: ImageRGBA[], affines: (Affine | undefined)[], threshold = 0.5): { valid: boolean; confidences: number[] } {
  const confidences = captures.map((img, i) => calibrate(img, codec, affines[i]).confidence);
  return { valid: confidences.length > 0 && confidences.every((c) => c >= threshold), confidences };
}

function apply(t: Affine, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

/** Re-export for the hosts: separation between the classes of a calibrated palette. */
export { labDistance };
