/**
 * CIELAB space (D65/2°) — §5.3 of the requirements asks for the class
 * centroids to be measured "in a suitable color space (for example
 * CIELAB)". ΔE76 distance (Euclidean): enough for v0.1, ΔE2000 remains a
 * possible improvement (OPTI-05).
 */

import { RgbColor } from "./palettes.ts";

export interface Lab {
  l: number;
  a: number;
  b: number;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rgbToLab([r, g, b]: RgbColor): Lab {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  // XYZ D65 (linear sRGB → XYZ, standard matrix).
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;
  // D65 reference white.
  const fx = f(x / 0.95047);
  const fy = f(y / 1.0);
  const fz = f(z / 1.08883);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function f(t: number): number {
  const threshold = 216 / 24389;
  return t > threshold ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}

/** ΔE76 — Euclidean distance in Lab. */
export function labDistance(a: Lab, b: Lab): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

export interface Classification {
  index: number;
  /** (d2 − d1) / (d2 + d1) ∈ [0, 1] — relative margin between the two closest classes. */
  confidence: number;
}

/** Closest class among the centroids, with its confidence margin. */
export function classify(color: Lab, centroids: readonly Lab[]): Classification {
  let best = 0;
  let d1 = Infinity;
  let d2 = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = labDistance(color, centroids[i]!);
    if (d < d1) {
      d2 = d1;
      d1 = d;
      best = i;
    } else if (d < d2) {
      d2 = d;
    }
  }
  const sum = d1 + d2;
  return { index: best, confidence: sum > 0 ? (d2 - d1) / sum : 0 };
}
