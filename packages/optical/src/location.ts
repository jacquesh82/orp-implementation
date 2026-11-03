/**
 * Grid location — framing (OPTI-07).
 *
 * The three finder patterns only fix an AFFINE: rotation, scale, shear. A
 * hand-held phone in front of a screen sees the grid in PERSPECTIVE
 * (keystone): the affine sticks to the three finders but drifts towards the
 * bottom-right corner, precisely where it has no anchor point — the modules
 * there are read off their center.
 *
 * Here: affine from the three finders → prediction of a FOURTH point (5×5
 * alignment pattern placed by the TM representation) → local template
 * search, centroid refinement → exact four-point HOMOGRAPHY. When no pattern
 * is found, the homography degenerates into the affine (v0.1 behavior).
 */

import {
  affineFromTriplet,
  chooseTriplet,
  chooseTriplets,
  detectFinders,
  sample,
  type Affine,
} from "./decoder.ts";
import { FINDERS } from "./grid.ts";
import type { ImageRGBA } from "./render.ts";

/** 3×3 homography (row by row): module (x, y) → image pixel. */
export type Homography = readonly [number, number, number, number, number, number, number, number, number];

export function homographyFromAffine(t: Affine): Homography {
  return [t.a, t.c, t.e, t.b, t.d, t.f, 0, 0, 1];
}

export function applyH(h: Homography, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** Exact homography from four correspondences (h8 = 1). */
export function homographyFrom4(
  source: readonly (readonly [number, number])[],
  target: readonly (readonly [number, number])[],
): Homography | null {
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = source[i]!;
    const [u, v] = target[i]!;
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the augmented 8×8 system.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      if (f === 0) continue;
      for (let k = col; k < 9; k++) m[r]![k]! -= f * m[col]![k]!;
    }
  }
  const h = m.map((row, i) => row[8]! / row[i]!);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

export interface Location {
  /** Retained module → pixel transform (homography, or affine as a fallback). */
  h: Homography;
  affine: Affine;
  /** Image centers of the TL, TR, BL finders. */
  finders: [[number, number], [number, number], [number, number]];
  /** Image center of the alignment pattern, if it was found. */
  alignment: [number, number] | null;
  /** Gap (in modules) between the affine prediction and the pattern found — a measure of the perspective. */
  perspectiveSkew: number;
  /** Apparent size of a module (px), between TL and TR. */
  pxPerModule: number;
  /** Black/white luminance threshold measured on the finders. */
  threshold: number;
}

function lumaAt(image: ImageRGBA, px: number, py: number, radius: number): number {
  const c = sample(image, px, py, radius);
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

function median(values: number[]): number {
  const t = [...values].sort((a, b) => a - b);
  return t.length === 0 ? 0 : t[t.length >> 1]!;
}

/**
 * Locates the grid in a captured image. `alignment`: module index of the
 * center of the expected 5×5 pattern (absent: affine only).
 */
export function locate(
  image: ImageRGBA,
  alignment?: readonly [number, number],
  tracker?: Location | null,
): Location | null {
  const candidates = detectFinders(image);
  // TRACKING: if a recent location exists (previous subframe), take the
  // candidates closest to ITS finders. A P subframe (colored data) produces
  // dozens of false 1:1:3:1:1 patterns; the "best isosceles right triangle"
  // may then be a false one — and the whole pair is read off target, with a
  // misleadingly high confidence.
  let triplet = tracker ? track(candidates, tracker) : null;
  if (!triplet) triplet = chooseTriplet(candidates);
  if (!triplet) triplet = chooseTriplet(detectFinders(image, { threshold: "local" }));
  if (!triplet) return null;
  if (tracker && !consistent(triplet, tracker)) return null; // false triangle: better nothing at all
  return locateFromTriplet(image, triplet, alignment);
}

/**
 * Every grid of an image (mosaic): triangles chosen one by one, the finders
 * of a found grid removed before looking for the next one. Returned sorted
 * by rows then columns — the reading order of the mosaic.
 */
/** Maximum number of grids searched: a 7 × 7 mosaic (limit of a 4K camera). */
export const MAX_GRIDS = 49;

export function locateAll(image: ImageRGBA, alignment?: readonly [number, number], maximum = MAX_GRIDS): Location[] {
  // GLOBAL threshold (Otsu) first, then LOCAL threshold: when the image holds
  // a lot of true black (screen edge, background), Otsu settles between that
  // black and the rest and the dark gray finders of a mosaic fall on the
  // light side (measured: 4 to 8 finders out of 27 in 3×3, against ≈ 45 with
  // the local one). Keep the threshold that finds the most grids — Otsu on a
  // tie. Every triplet gives a location: the choice is made on the triplets,
  // and only the retained ones are located (alignment search).
  const globals = chooseTriplets(detectFinders(image), maximum);
  const locals = chooseTriplets(detectFinders(image, { threshold: "local" }), maximum);
  const foundList = (locals.length > globals.length ? locals : globals).map((triplet) => locateFromTriplet(image, triplet, alignment));
  if (foundList.length === 0) return foundList;
  const row = Math.min(...foundList.map((l) => l.pxPerModule)) * 20;
  return foundList.sort((a, b) => {
    const dy = a.finders[0][1] - b.finders[0][1];
    return Math.abs(dy) > row ? dy : a.finders[0][0] - b.finders[0][0];
  });
}

/** Copy of a window of the image, clamped to the edges. */
function crop(image: ImageRGBA, x0: number, y0: number, x1: number, y1: number): ImageRGBA {
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** Finder found again in a window around its expected position, or null. */
function finderAround(image: ImageRGBA, mx: number, my: number, module: number): [number, number] | null {
  const radius = Math.ceil(8 * module);
  const x0 = Math.max(0, Math.floor(mx - radius));
  const y0 = Math.max(0, Math.floor(my - radius));
  const x1 = Math.min(image.width, Math.ceil(mx + radius));
  const y1 = Math.min(image.height, Math.ceil(my + radius));
  if (x1 - x0 < 4 * module || y1 - y0 < 4 * module) return null;
  const win = crop(image, x0, y0, x1, y1);
  for (const threshold of ["otsu", "local"] as const) {
    let best: [number, number] | null = null;
    let distance = 1.5 * module;
    for (const c of detectFinders(win, { threshold })) {
      const size = c.score / 7 / module; // length of the pattern along the row: ≥ 7 modules
      if (size < 0.7 || size > 1.6) continue;
      const d = Math.hypot(c.x + x0 - mx, c.y + y0 - my);
      if (d < distance) {
        distance = d;
        best = [c.x + x0, c.y + y0];
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * FAST TRACKING of an already located grid: its three finders are only
 * searched in small windows (±8 modules) around their previous position — a
 * few milliseconds instead of scanning the whole image and searching for
 * triangles. If no finder moved by more than `still` module, the previous
 * location is returned as is (same homography, no new search for the
 * alignment pattern). Returns null if a finder is missing: the full search
 * must take over.
 */
export function trackLocation(
  image: ImageRGBA,
  previous: Location,
  alignment?: readonly [number, number],
  still = 0.08,
): Location | null {
  const m = previous.pxPerModule;
  const foundCount: [number, number][] = [];
  let deviation = 0;
  for (const [mx, my] of previous.finders) {
    const t = finderAround(image, mx, my, m);
    if (!t) return null;
    deviation = Math.max(deviation, Math.hypot(t[0] - mx, t[1] - my) / m);
    foundCount.push(t);
  }
  if (deviation < still) return previous;
  const triplet: [[number, number], [number, number], [number, number]] = [foundCount[0]!, foundCount[1]!, foundCount[2]!];
  if (!consistent(triplet, previous)) return null;
  return locateFromTriplet(image, triplet, alignment);
}

/**
 * Location of an image within a STREAM (camera, video): the known grids are
 * tracked through windows (trackLocation); the full search (locateAll) only
 * runs periodically — to discover a grid that appeared — or as soon as a
 * tracked grid is lost. Known grids that the full search did not see again
 * (P subframe that blurs the detection) are kept if their tracking succeeds.
 */
export class GridTracker {
  private known: Location[] = [];
  private lastComplete = -Infinity;
  /** Full searches and fast trackings performed (diagnostics). */
  readonly tally = { completed: 0, fast: 0 };

  constructor(
    private readonly alignment?: readonly [number, number],
    /** Interval (ms) between two full searches when everything is tracked. */
    private readonly fullPeriod = 250,
  ) {}

  locate(image: ImageRGBA, t: number): Location[] {
    if (this.known.length > 0 && t - this.lastComplete < this.fullPeriod && t >= this.lastComplete) {
      const trackedCount = this.known.map((l) => trackLocation(image, l, this.alignment));
      if (trackedCount.every((l) => l !== null)) {
        this.tally.fast++;
        this.known = trackedCount as Location[];
        return this.known;
      }
    }
    this.tally.completed++;
    this.lastComplete = t;
    const foundList = locateAll(image, this.alignment);
    for (const stale of this.known) {
      const tl = stale.finders[0];
      const review = foundList.some((l) => Math.hypot(l.finders[0][0] - tl[0], l.finders[0][1] - tl[1]) < 20 * stale.pxPerModule);
      if (review) continue;
      const tracked = trackLocation(image, stale, this.alignment);
      if (tracked) foundList.push(tracked);
    }
    this.known = foundList;
    return foundList;
  }

  forget(): void {
    this.known = [];
    this.lastComplete = -Infinity;
  }
}

function locateFromTriplet(
  image: ImageRGBA,
  triplet: [[number, number], [number, number], [number, number]],
  alignment?: readonly [number, number],
): Location {
  const affine = affineFromTriplet(triplet[0], triplet[1], triplet[2]);
  const pxPerModule = Math.hypot(triplet[1][0] - triplet[0][0], triplet[1][1] - triplet[0][1]) / 34;
  const toImage = (x: number, y: number): [number, number] => [
    affine.a * x + affine.c * y + affine.e,
    affine.b * x + affine.d * y + affine.f,
  ];

  // Black/white threshold LOCAL to the grid: finder cores (black) and inner
  // white ring at ±2 modules from the center.
  const blacks: number[] = [];
  const whites: number[] = [];
  for (const [mx, my] of FINDERS) {
    const cx = mx + 0.5;
    const cy = my + 0.5;
    blacks.push(lumaAt(image, ...toImage(cx, cy), Math.max(1, 0.8 * pxPerModule)));
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) {
      whites.push(lumaAt(image, ...toImage(cx + dx, cy + dy), Math.max(1, 0.25 * pxPerModule)));
    }
  }
  const threshold = (median(blacks) + median(whites)) / 2;

  const base: Location = {
    h: homographyFromAffine(affine),
    affine,
    finders: triplet,
    alignment: null,
    perspectiveSkew: 0,
    pxPerModule,
    threshold,
  };
  if (!alignment || median(whites) - median(blacks) < 30) return base;

  const found = findAlignment(image, toImage, alignment[0] + 0.5, alignment[1] + 0.5, pxPerModule, threshold);
  if (!found) return base;
  const h = homographyFrom4(
    [
      [FINDERS[0]![0] + 0.5, FINDERS[0]![1] + 0.5],
      [FINDERS[1]![0] + 0.5, FINDERS[1]![1] + 0.5],
      [FINDERS[2]![0] + 0.5, FINDERS[2]![1] + 0.5],
      [alignment[0] + 0.5, alignment[1] + 0.5],
    ],
    [triplet[0], triplet[1], triplet[2], found.center],
  );
  if (!h || !saneHomography(h)) return base;
  return { ...base, h, alignment: found.center, perspectiveSkew: found.deviation };
}

/** A triplet found outside tracking must stay plausible: same size (±25 %), TL within 8 modules. */
function consistent(triplet: [[number, number], [number, number], [number, number]], tracker: Location): boolean {
  const size = Math.hypot(triplet[1][0] - triplet[0][0], triplet[1][1] - triplet[0][1]) / 34;
  if (Math.abs(size - tracker.pxPerModule) > 0.25 * tracker.pxPerModule) return false;
  return Math.hypot(triplet[0][0] - tracker.finders[0][0], triplet[0][1] - tracker.finders[0][1]) < 8 * tracker.pxPerModule;
}

function track(
  candidates: { x: number; y: number }[],
  tracker: Location,
): [[number, number], [number, number], [number, number]] | null {
  const tolerance = 1.5 * tracker.pxPerModule;
  const foundCount: [number, number][] = [];
  for (const [mx, my] of tracker.finders) {
    let best: { x: number; y: number } | null = null;
    let distance = tolerance;
    for (const c of candidates) {
      const d = Math.hypot(c.x - mx, c.y - my);
      if (d < distance) {
        distance = d;
        best = c;
      }
    }
    if (!best) return null;
    foundCount.push([best.x, best.y]);
  }
  return [foundCount[0]!, foundCount[1]!, foundCount[2]!];
}

/** Rejects a homography that folds the grid (w ≤ 0 on a corner). */
function saneHomography(h: Homography): boolean {
  for (const [x, y] of [[0, 0], [41, 0], [0, 41], [41, 41]] as const) {
    if (h[6] * x + h[7] * y + h[8] <= 0.05) return false;
  }
  return true;
}

/**
 * Template search of the 5×5 alignment pattern (black ring, white ring,
 * black center) around the affine prediction.
 *
 * The perspective of a phone tilted by 15-20° shifts the bottom-right corner
 * by 5 to 8 modules relative to the affine AND changes the local scale there
 * by ±20 %: the search covers ±10 modules and tries 3×3 scales (horizontal ×
 * vertical) of the template. Luminance lattice with a ¼-module step,
 * computed once; the scales are read from it by rounding.
 */
function findAlignment(
  image: ImageRGBA,
  toImage: (x: number, y: number) => [number, number],
  cx: number,
  cy: number,
  pxPerModule: number,
  threshold: number,
): { center: [number, number]; deviation: number } | null {
  const STEP = 4; // samples per module
  const RANGE = 10; // search modules on either side
  const SCALES = [0.82, 1, 1.2];
  const HALF = Math.ceil((RANGE + 2.5 * SCALES[2]!) * STEP);
  const side = 2 * HALF + 1;
  const black = new Uint8Array(side * side);
  const radius = Math.max(1, 0.15 * pxPerModule);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const [px, py] = toImage(cx + (i - HALF) / STEP, cy + (j - HALF) / STEP);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
        black[j * side + i] = 2; // outside the image: matches nothing
        continue;
      }
      black[j * side + i] = lumaAt(image, px, py, radius) < threshold ? 1 : 0;
    }
  }
  // Templates: lattice offsets of the 25 cells for each pair of scales.
  const templates = SCALES.flatMap((sx) =>
    SCALES.map((sy) => {
      const cellList: [number, number, number][] = [];
      for (let v = -2; v <= 2; v++) {
        for (let u = -2; u <= 2; u++) {
          cellList.push([Math.round(u * sx * STEP), Math.round(v * sy * STEP), Math.max(Math.abs(u), Math.abs(v)) === 1 ? 0 : 1]);
        }
      }
      return cellList;
    }),
  );
  // Flat lattice offsets and expected values of the 9 × 25 cells.
  const CELLS = 25;
  const offsets = new Int32Array(templates.length * CELLS);
  const expectedCells = new Uint8Array(templates.length * CELLS);
  templates.forEach((cellList, t) =>
    cellList.forEach(([di, dj, expected], m) => {
      offsets[t * CELLS + m] = dj * side + di;
      expectedCells[t * CELLS + m] = expected;
    }),
  );
  let best = -1;
  let positions: [number, number][] = [];
  for (let oj = -RANGE * STEP; oj <= RANGE * STEP; oj++) {
    for (let oi = -RANGE * STEP; oi <= RANGE * STEP; oi++) {
      const base = (HALF + oj) * side + HALF + oi;
      // Fast cut: the center must be black.
      if (black[base] !== 1) continue;
      // Best template score. A template is abandoned as soon as it can no
      // longer reach max(score, best): the score stays exact whenever it is
      // ≥ best — the only case where it counts.
      let score = 0;
      for (let t = 0; t < templates.length && score < CELLS; t++) {
        const floor = Math.max(score, best);
        let s = 0;
        for (let m = 0; m < CELLS; m++) {
          if (black[base + offsets[t * CELLS + m]!] === expectedCells[t * CELLS + m]) s++;
          else if (s + CELLS - 1 - m < floor) break;
        }
        if (s > score) score = s;
      }
      if (score > best) {
        best = score;
        positions = [[oi, oj]];
      } else if (score === best) {
        positions.push([oi, oj]);
      }
    }
  }
  if (best < 23) return null;
  // Plateau of the best score: only the neighborhood (≤ 1 module) of the first
  // position is averaged — two disjoint plateaus = ambiguous pattern.
  const [ri, rj] = positions[0]!;
  const neighbors = positions.filter(([i, j]) => Math.abs(i - ri) <= STEP && Math.abs(j - rj) <= STEP);
  if (neighbors.length < positions.length / 2) return null;
  const ox = neighbors.reduce((a, [i]) => a + i, 0) / neighbors.length / STEP;
  const oy = neighbors.reduce((a, [, j]) => a + j, 0) / neighbors.length / STEP;
  let [px, py] = toImage(cx + ox, cy + oy);
  // Refinement: centroid of the dark pixels of the center (radius 1.2 module:
  // the white ring isolates the central module from the black ring).
  for (let iter = 0; iter < 2; iter++) {
    const r = 1.2 * pxPerModule;
    let mx = 0;
    let my = 0;
    let m = 0;
    for (let y = Math.max(0, Math.floor(py - r)); y <= Math.min(image.height - 1, Math.ceil(py + r)); y++) {
      for (let x = Math.max(0, Math.floor(px - r)); x <= Math.min(image.width - 1, Math.ceil(px + r)); x++) {
        if ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 > r * r) continue;
        const o = (y * image.width + x) * 4;
        const l = 0.299 * image.data[o]! + 0.587 * image.data[o + 1]! + 0.114 * image.data[o + 2]!;
        if (l >= threshold) continue;
        mx += x + 0.5;
        my += y + 0.5;
        m++;
      }
    }
    if (m === 0) return null;
    px = mx / m;
    py = my / m;
  }
  const [ax, ay] = toImage(cx, cy);
  return { center: [px, py], deviation: Math.hypot(px - ax, py - ay) / pxPerModule };
}
