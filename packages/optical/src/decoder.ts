/**
 * v0.1 optical decoder: captured image → bytes of the data zone.
 *
 * Pipeline (§5.4): luminance → Otsu binarization → detection of the three
 * finder patterns (1:1:3:1:1 pattern) → AFFINE transform from the three
 * centers (rotation, scale, translation — full perspective is still to be
 * done, see OPTI-07) → sampling at the center of each module → colorimetric
 * classification with a confidence margin.
 *
 * Hardened v0.1 decision: an ambiguous module still gets the closest class
 * (never an erasure at the bit level) — Reed-Solomon corrects up to 4
 * errors per segment and the fountain recovers lost frames; error detection
 * remains the rule (§10.2-4) through CRC, AEAD and SHA-256 digest. The
 * confidence is still measured and exposed for diagnostics (F-11) and mode
 * validation (F-05).
 */

import { Codec } from "@optirelay/core";
import { classify, Lab, rgbToLab } from "./cielab.ts";
import { FINDERS, DATA_MODULES, GRID_SIZE } from "./grid.ts";
import { bitsPerModule, paletteOf } from "./palettes.ts";
import { ImageRGBA } from "./render.ts";

export interface CalibratedPalette {
  codec: Codec;
  /** One Lab centroid per palette index. */
  centroids: Lab[];
  /** Mean confidence of the calibration (0..1) — the "score" of F-05. */
  confidence: number;
}

export interface DecodeOptions {
  palette?: CalibratedPalette;
  /** Confidence threshold under which a module counts as "uncertain" (diagnostics). */
  confidenceThreshold?: number;
}

export interface DecodeResult {
  /** Bytes of the data zone, in DATA_MODULES order (MSB first). */
  bytes: Uint8Array;
  /** Mean classification confidence of the data modules (0..1). */
  meanConfidence: number;
  /** Fraction of modules under the confidence threshold (0..1) — "uncertain symbols" of F-11. */
  uncertainShare: number;
}

// ── Luminance and binarization ────────────────────────────────────────────

export function luminance(image: ImageRGBA): Float32Array {
  const l = new Float32Array(image.width * image.height);
  for (let i = 0; i < l.length; i++) {
    const o = i * 4;
    l[i] = 0.299 * image.data[o]! + 0.587 * image.data[o + 1]! + 0.114 * image.data[o + 2]!;
  }
  return l;
}

/** Otsu threshold — automatic black/white separation. */
export function otsuThreshold(l: Float32Array): number {
  const histogram = new Float64Array(256);
  for (let i = 0; i < l.length; i++) histogram[Math.min(255, Math.max(0, Math.round(l[i]!)))]!++;
  const total = l.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i]!;
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let maxVariance = -1;
  for (let t = 0; t < 256; t++) {
    weightB += histogram[t]!;
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * histogram[t]!;
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > maxVariance) {
      maxVariance = variance;
      best = t;
    }
  }
  return best;
}

function binarize(l: Float32Array, threshold: number): Uint8Array {
  const b = new Uint8Array(l.length);
  for (let i = 0; i < l.length; i++) b[i] = l[i]! > threshold ? 1 : 0;
  return b;
}

/**
 * Adaptive binarization (Bradley): white if the luminance exceeds 85 % of
 * the local mean. Window ≈ 1/8 of the short side — larger than a 7×7 finder
 * at useful module sizes, so the black core always sees some white.
 */
function binarizeLocal(l: Float32Array, width: number, height: number): Uint8Array {
  const radius = Math.max(7, Math.round(Math.min(width, height) / 16));
  const w1 = width + 1;
  const integral = new Float64Array(w1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += l[y * width + x]!;
      integral[(y + 1) * w1 + x + 1] = integral[y * w1 + x + 1]! + row;
    }
  }
  const b = new Uint8Array(l.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const sum = integral[y1 * w1 + x1]! - integral[y0 * w1 + x1]! - integral[y1 * w1 + x0]! + integral[y0 * w1 + x0]!;
      const n = (x1 - x0) * (y1 - y0);
      b[y * width + x] = l[y * width + x]! * n > sum * 0.85 ? 1 : 0;
    }
  }
  return b;
}

// ── Finder pattern detection ──────────────────────────────────────────────

export interface FinderCandidate {
  x: number;
  y: number;
  score: number;
}

/**
 * Searches the 1:1:3:1:1 pattern on the binarized rows, checked vertically.
 * Returns the candidates sorted by decreasing score.
 */
export function detectFinders(image: ImageRGBA, options: { threshold?: "otsu" | "local" } = {}): FinderCandidate[] {
  const l = luminance(image);
  // Global Otsu by default; LOCAL threshold (moving average) as a fallback
  // when the screen lighting is not uniform (glare, vignetting, screen seen
  // at an angle) — a global threshold then cuts a finder in two.
  const b = options.threshold === "local" ? binarizeLocal(l, image.width, image.height) : binarize(l, otsuThreshold(l));
  const { width, height } = image;
  const candidates: FinderCandidate[] = [];
  const visited = new Set<number>();

  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (b[y * width + x] !== 0) {
        x++;
        continue;
      }
      // Start of a sequence of black runs: measure 5 runs 1:1:3:1:1.
      const ranges: number[] = [];
      let cursor = x;
      for (let p = 0; p < 5; p++) {
        const start = cursor;
        while (cursor < width && b[y * width + cursor] === (p % 2 === 0 ? 0 : 1)) cursor++;
        ranges.push(cursor - start);
        if (cursor >= width && p < 4) break;
      }
      if (ranges.length === 5) {
        const [a, c, d, e, f] = ranges;
        const total = a! + c! + d! + e! + f!;
        if (total >= 14 && total <= 600 && checkRatio(ranges)) {
          const cx = x + total / 2;
          const unit = total / 7;
          // Recenter vertically: the pattern shows up on several rows, only the
          // CENTER row aligns the 7 modules of the finder.
          const { cy, score } = centerVertically(b, width, height, Math.round(cx), y, unit);
          if (score >= 6) {
            const key = Math.round(cx / 4) * 1000 + Math.round(cy / 4);
            if (!visited.has(key)) {
              visited.add(key);
              // Subpixel refinement: centroid of the black 3×3 core — the angular drift
              // of the affine over 34 modules is 34× the error here.
              const affine = refineCenter(b, width, height, cx, cy, unit);
              candidates.push({ x: affine[0], y: affine[1], score: total });
            }
          }
        }
      }
      // CORRECT and fast jump: a pattern necessarily starts at the BEGINNING of
      // a black run (first run bounded by white) — so we skip the current
      // black run and the white one that follows. No true pattern can start
      // in between, and the cost becomes O(runs) rather than O(pixels): at
      // 1080p this is the difference between freezing and real time.
      x += ranges.length >= 2 ? ranges[0]! + ranges[1]! : (ranges[0] ?? 0) + 1;
    }
  }
  return candidates;
}

function checkRatio(ranges: number[]): boolean {
  const [a, c, d, e, f] = ranges as [number, number, number, number, number];
  const unit = (a + c + e + f) / 4;
  const near = (v: number, target: number) => Math.abs(v - target) <= Math.max(1, 0.45 * target);
  return near(a, 1 * unit) && near(c, 1 * unit) && near(d, 3 * unit) && near(e, 1 * unit) && near(f, 1 * unit);
}

/**
 * Centroid of the black pixels of the 3×3 core — subpixel precision, robust
 * to rotation (the core blob rotates, its centroid stays at the center).
 */
function refineCenter(b: Uint8Array, width: number, height: number, cx: number, cy: number, unit: number): [number, number] {
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  const radius = 1.6 * unit; // the 3×3 core spans ±1.5 module
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (b[y * width + x] !== 0) continue;
      sumX += x + 0.5;
      sumY += y + 0.5;
      n++;
    }
  }
  if (n === 0) return [cx, cy];
  return [sumX / n, sumY / n];
}

function centerVertically(
  b: Uint8Array,
  width: number,
  height: number,
  x: number,
  cy0: number,
  unit: number,
): { cy: number; score: number } {
  // The 3×3 core of the finder forms a black block of 3 modules along the
  // column: its center IS the center of the finder. Around the scan row, we
  // look for the black block whose length is closest to 3·unit.
  const column = (y: number): number | undefined =>
    y < 0 || y >= height || x < 0 || x >= width ? undefined : b[y * width + x];
  const start = Math.max(0, Math.round(cy0 - 5 * unit));
  const end = Math.min(height - 1, Math.round(cy0 + 5 * unit));
  let best: { cy: number; score: number } | null = null;
  let y = start;
  while (y <= end) {
    if (column(y) === 0) {
      const origin = y;
      while (y <= end && column(y) === 0) y++;
      const length = y - origin;
      if (best === null || Math.abs(length - 3 * unit) < Math.abs(best.score - 3 * unit)) {
        // repurposed score: remembers the block length for the comparison
        best = { cy: (origin + y) / 2, score: length };
      }
    } else {
      y++;
    }
  }
  if (!best) return { cy: cy0, score: 0 };
  // Validates the 7-module pattern around the center found.
  const expected = [0, 1, 0, 0, 0, 1, 0];
  let score = 0;
  for (let m = 0; m < 7; m++) {
    const yy = Math.round(best.cy + (m - 3) * unit);
    if (column(yy) === expected[m]!) score++;
  }
  return { cy: best.cy, score };
}

/** Three ordered finder centers: [TL, TR, BL]. */
export type Triplet = [[number, number], [number, number], [number, number]];

/**
 * Acceptance test of ONE triple, taken in index order (p0 < p1 < p2): the
 * error (pythagorean + isosceles) and the ordered [TL, TR, BL] triplet, or
 * null when the triple is not a plausible grid.
 */
function evaluateTriple(p0: FinderCandidate, p1: FinderCandidate, p2: FinderCandidate): { triplet: Triplet; error: number } | null {
  const pts = [p0, p1, p2];
  // A module smaller than 5 px cannot be decoded — the "triplet" is scene
  // noise (e.g. 3.7 % confidence on a bowl).
  const side1 = Math.hypot(p0.x - p1.x, p0.y - p1.y);
  const side2 = Math.hypot(p0.x - p2.x, p0.y - p2.y);
  if (Math.min(side1, side2) / 34 < 5) return null;
  const d = (p: FinderCandidate, q: FinderCandidate) => Math.hypot(p.x - q.x, p.y - q.y);
  const sides = [
    { length: d(p1, p2), opposite: 0 },
    { length: d(p0, p2), opposite: 1 },
    { length: d(p0, p1), opposite: 2 },
  ].sort((a, b2) => b2.length - a.length);
  const hypotenuse = sides[0]!.length;
  const c1 = sides[1]!.length;
  const c2 = sides[2]!.length;
  const pythagoreanError = Math.abs(hypotenuse * hypotenuse - (c1 * c1 + c2 * c2)) / (hypotenuse * hypotenuse);
  const isoscelesError = Math.abs(c1 - c2) / Math.max(c1, c2);
  const error = pythagoreanError + isoscelesError;
  if (pythagoreanError > 0.15 || isoscelesError > 0.2) return null;
  // Scale consistency: the module size given by the triangle (side / 34)
  // must be the one measured by the finders themselves. Their `score`
  // is the length of the 1:1:3:1:1 pattern along a HORIZONTAL row,
  // i.e. 7 modules / max(|cos θ|, |sin θ|) for a grid rotated by θ: we
  // bring it back to the angle of the triangle. Without this test, the
  // top-left finders of three NEIGHBORING grids (mosaic) form an
  // isosceles right triangle that is just as perfect, 45 modules on a
  // side instead of 34.
  const vertex = pts[sides[0]!.opposite]!;
  const others = pts.filter((_, idx) => idx !== sides[0]!.opposite);
  const [p, q] = [others[0]!, others[1]!];
  const theta = Math.atan2(p.y - vertex.y, p.x - vertex.x);
  const tilt = Math.max(Math.abs(Math.cos(theta)), Math.abs(Math.sin(theta)));
  const finderModule = ((p0.score + p1.score + p2.score) / 21) * tilt;
  const triangleModule = (c1 + c2) / 2 / 34;
  if (Math.abs(triangleModule / finderModule - 1) > 0.18) return null;
  // TL = vertex opposite the hypotenuse; TR / BL by the SIGN of the cross
  // product (image frame, y pointing down: TL→TR then TL→BL turns
  // clockwise). The former "largest x" criterion swapped TR and BL as soon
  // as the phone rotated by more than 45° — grid read mirrored.
  const cross = (p.x - vertex.x) * (q.y - vertex.y) - (p.y - vertex.y) * (q.x - vertex.x);
  const [tr, bl] = cross > 0 ? [p, q] : [q, p];
  return { triplet: [[vertex.x, vertex.y], [tr.x, tr.y], [bl.x, bl.y]], error };
}

// Bounds of the plausible-triple enumeration, DERIVED from the acceptance
// test above (with ≥ 5 % margin, so that no accepted triple is ever missed):
// - the leg from the vertex to the LOWER-index of the two other finders is
//   ≥ 170 px (min-side test, 5 px × 34: the lowest index of the triple is
//   either the vertex — both legs ≥ 170 — or that finder);
// - with m the mean leg, m ∈ [0.9, 1.125] × leg, and the scale test gives
//   m ∈ [0.82, 1.18] × 34 · tilt · S / 21 (S: sum of the 3 scores, tilt ∈
//   [√2/2, 1]): a leg lies in [0.834 S, 2.123 S];
// - the pythagorean test bounds |cos| of the right angle by 0.181 and the
//   isosceles test the ratio of the legs to [0.8, 1.25]: the third finder
//   lies within 0.337 × leg of the second one turned by ±90° around the
//   vertex.
// These bounds only prune: every triple that passes them still goes through
// the exact test, which alone decides.
const MIN_LEG = 169;
const LEG_PER_SCORE_MIN = 0.79;
const LEG_PER_SCORE_MAX = 2.23;
const THIRD_RADIUS = 0.36;
const LEG_RATIO_MIN = 0.78;
const LEG_RATIO_MAX = 1.28;
const MAX_COS = 0.2;
/** Mean leg / S: [0.82 · 34 · √2/2 / 21, 1.18 · 34 / 21] = [0.939, 1.910], ± 3 %. */
const MEAN_LEG_PER_SCORE_MIN = 0.91;
const MEAN_LEG_PER_SCORE_MAX = 1.97;

/**
 * Calls `visit(i, j, k)` (i < j < k) for a SUPERSET of the triples that
 * `evaluateTriple` accepts — instead of the n³/6 triples. For each candidate
 * taken as the right-angle vertex and each second finder at a compatible
 * distance (scores), the third one is only looked for in a disc around its
 * predicted position (uniform grid of cells). O(n² + accepted neighbors).
 * A triple may be visited more than once.
 */
function forEachPlausibleTriple(c: readonly FinderCandidate[], visit: (i: number, j: number, k: number) => void): void {
  const n = c.length;
  if (n < 3) return;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const ss = new Float64Array(n);
  let minScore = Infinity;
  let maxScore = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = c[i]!;
    xs[i] = k.x;
    ys[i] = k.y;
    ss[i] = k.score;
    minScore = Math.min(minScore, k.score);
    maxScore = Math.max(maxScore, k.score);
    minX = Math.min(minX, k.x);
    minY = Math.min(minY, k.y);
    maxX = Math.max(maxX, k.x);
    maxY = Math.max(maxY, k.y);
  }
  // Uniform grid of cells ≈ the search radius of a typical grid (leg ≈ 4.6
  // scores); inside a cell, candidates by decreasing score (then index), so
  // that a search stops at the first score too small.
  const median = Float64Array.from(ss).sort()[n >> 1]!;
  const cell = Math.max(8, THIRD_RADIUS * 4.6 * median);
  const columns = Math.floor((maxX - minX) / cell) + 1;
  const rows = Math.floor((maxY - minY) / cell) + 1;
  const cellCount = columns * rows;
  const cellOf = new Int32Array(n);
  const start = new Int32Array(cellCount + 1);
  for (let i = 0; i < n; i++) {
    cellOf[i] = Math.floor((ys[i]! - minY) / cell) * columns + Math.floor((xs[i]! - minX) / cell);
    start[cellOf[i]! + 1]!++;
  }
  for (let i = 0; i < cellCount; i++) start[i + 1]! += start[i]!;
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => ss[q]! - ss[p]! || p - q);
  const fill = start.slice(0, cellCount);
  const items = new Int32Array(n);
  for (const i of order) items[fill[cellOf[i]!]!++] = i;
  const cellMax = new Float64Array(cellCount).fill(-Infinity);
  for (let i = 0; i < cellCount; i++) if (start[i + 1]! > start[i]!) cellMax[i] = ss[items[start[i]!]!]!;

  // Score window of the third finder, implied by the leg-ratio and scale
  // tests below (1 % margin): sum of the scores ∈ mean leg / [1.97, 0.91].
  const thirdMin = ((1 + LEG_RATIO_MIN) / 2 / MEAN_LEG_PER_SCORE_MAX) * 0.99;
  const thirdMax = ((1 + LEG_RATIO_MAX) / 2 / MEAN_LEG_PER_SCORE_MIN) * 1.01;
  for (let v = 0; v < n; v++) {
    const vx = xs[v]!;
    const vy = ys[v]!;
    for (let p = 0; p < n; p++) {
      if (p === v) continue;
      const dx = xs[p]! - vx;
      const dy = ys[p]! - vy;
      const leg2 = dx * dx + dy * dy;
      if (leg2 < MIN_LEG * MIN_LEG) continue;
      const pair = ss[v]! + ss[p]!;
      const low = (pair + minScore) * LEG_PER_SCORE_MIN;
      const high = (pair + maxScore) * LEG_PER_SCORE_MAX;
      if (leg2 < low * low || leg2 > high * high) continue;
      const leg = Math.sqrt(leg2);
      const scoreMin = thirdMin * leg - pair;
      const scoreMax = thirdMax * leg - pair;
      const r = THIRD_RADIUS * leg;
      for (let sign = 1; sign >= -1; sign -= 2) {
        // Second finder turned by ±90° around the vertex.
        const qx = vx - sign * dy;
        const qy = vy + sign * dx;
        const cx0 = Math.max(0, Math.floor((qx - r - minX) / cell));
        const cx1 = Math.min(columns - 1, Math.floor((qx + r - minX) / cell));
        const cy0 = Math.max(0, Math.floor((qy - r - minY) / cell));
        const cy1 = Math.min(rows - 1, Math.floor((qy + r - minY) / cell));
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const idx = cy * columns + cx;
            if (cellMax[idx]! < scoreMin) continue;
            for (let s = start[idx]!; s < start[idx + 1]!; s++) {
              const q = items[s]!;
              const sq = ss[q]!;
              if (sq < scoreMin) break;
              if (sq > scoreMax || q <= p || q === v) continue;
              const ex = xs[q]! - qx;
              const ey = ys[q]! - qy;
              if (ex * ex + ey * ey > r * r) continue;
              // Cheap necessary tests before the exact one: ratio of the
              // legs, right angle, scale of the finders.
              const fx = xs[q]! - vx;
              const fy = ys[q]! - vy;
              const other = Math.sqrt(fx * fx + fy * fy);
              if (other < LEG_RATIO_MIN * leg || other > LEG_RATIO_MAX * leg) continue;
              if (Math.abs(dx * fx + dy * fy) > MAX_COS * leg * other) continue;
              const mean = (leg + other) / 2;
              const sum = pair + sq;
              if (mean < MEAN_LEG_PER_SCORE_MIN * sum || mean > MEAN_LEG_PER_SCORE_MAX * sum) continue;
              // Indices in increasing order: the acceptance test is evaluated
              // on the triple in candidate order, as an exhaustive scan would.
              const lo = Math.min(v, p, q);
              const hi = Math.max(v, p, q);
              visit(lo, v + p + q - lo - hi, hi);
            }
          }
        }
      }
    }
  }
}

/** An accepted triple: candidate indices (i < j < k), error and ordered triplet. */
interface TripleFit {
  i: number;
  j: number;
  k: number;
  error: number;
  triplet: Triplet;
}

/** Total order of the choice: smallest error, then first triple in (i, j, k) order — that of an exhaustive scan. */
function before(a: TripleFit, b: TripleFit): number {
  return a.error - b.error || a.i - b.i || a.j - b.j || a.k - b.k;
}

/** Every accepted triple, sorted in choice order, without duplicates. */
function acceptedTriples(candidates: readonly FinderCandidate[]): TripleFit[] {
  const fits: TripleFit[] = [];
  forEachPlausibleTriple(candidates, (i, j, k) => {
    const fit = evaluateTriple(candidates[i]!, candidates[j]!, candidates[k]!);
    if (fit) fits.push({ i, j, k, error: fit.error, triplet: fit.triplet });
  });
  fits.sort(before);
  return fits.filter((f, n) => n === 0 || before(fits[n - 1]!, f) !== 0);
}

/**
 * Picks the L-shaped triplet (TL, TR, BL) and orders it: [TL, TR, BL] — the
 * accepted triple of smallest error (first in candidate order on a tie).
 */
export function chooseTriplet(candidates: FinderCandidate[]): Triplet | null {
  const best: { fit: TripleFit | null } = { fit: null };
  forEachPlausibleTriple(candidates, (i, j, k) => {
    const fit = evaluateTriple(candidates[i]!, candidates[j]!, candidates[k]!);
    if (!fit) return;
    const f = { i, j, k, error: fit.error, triplet: fit.triplet };
    if (!best.fit || before(f, best.fit) < 0) best.fit = f;
  });
  return best.fit ? best.fit.triplet : null;
}

/**
 * Every grid of a mosaic, one triangle after the other: the best triplet,
 * then the best one among the candidates that remain once every finder
 * INSIDE the grid found is discarded (not only its three anchors: the colored
 * data of a P subframe create false patterns, which must not become a ghost
 * grid). Same result as `chooseTriplet` called again on the remaining
 * candidates, but the triples are enumerated and tested only ONCE: removing
 * candidates neither changes the test of a triple nor the order of two
 * triples.
 */
export function chooseTriplets(candidates: FinderCandidate[], maximum: number): Triplet[] {
  const fits = acceptedTriples(candidates);
  const alive = new Uint8Array(candidates.length).fill(1);
  const chosen: Triplet[] = [];
  let cursor = 0;
  while (chosen.length < maximum) {
    while (cursor < fits.length && !(alive[fits[cursor]!.i] && alive[fits[cursor]!.j] && alive[fits[cursor]!.k])) cursor++;
    if (cursor === fits.length) break;
    const triplet = fits[cursor]!.triplet;
    chosen.push(triplet);
    const { a, b, c, d, e, f } = affineFromTriplet(triplet[0], triplet[1], triplet[2]);
    const det = a * d - b * c;
    candidates.forEach((k, idx) => {
      const mx = (d * (k.x - e) - c * (k.y - f)) / det;
      const my = (a * (k.y - f) - b * (k.x - e)) / det;
      if (!(mx < -2 || my < -2 || mx > GRID_SIZE + 2 || my > GRID_SIZE + 2)) alive[idx] = 0;
    });
  }
  return chosen;
}

// ── Affine transform and sampling ─────────────────────────────────────────

export interface Affine {
  /** image = A · module + t, with module in grid units (module center = integer coordinate + 0.5). */
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Solves the affine from three module → image correspondences. */
export function affineFromTriplet(
  tl: [number, number],
  tr: [number, number],
  bl: [number, number],
): Affine {
  // Finder centers in continuous coordinates: index (3,3) is the corner of
  // the 7×7 finder, its 3×3 core is centered at (3.5, 3.5).
  const [mx0, my0] = [FINDERS[0]![0] + 0.5, FINDERS[0]![1] + 0.5];
  const [mx1, my1] = [FINDERS[1]![0] + 0.5, FINDERS[1]![1] + 0.5];
  const [mx2, my2] = [FINDERS[2]![0] + 0.5, FINDERS[2]![1] + 0.5];
  const det = (mx1 - mx0) * (my2 - my0) - (mx2 - mx0) * (my1 - my0);
  const ix0 = tl[0];
  const iy0 = tl[1];
  const dx1 = (tr[0] - ix0) / det;
  const dx2 = (bl[0] - ix0) / det;
  const dy1 = (tr[1] - iy0) / det;
  const dy2 = (bl[1] - iy0) / det;
  const a = dx1 * (mx1 - mx0) + dx2 * (mx2 - mx0);
  const c = dx1 * (my1 - my0) + dx2 * (my2 - my0);
  const b = dy1 * (mx1 - mx0) + dy2 * (mx2 - mx0);
  const d = dy1 * (my1 - my0) + dy2 * (my2 - my0);
  return {
    a,
    b,
    c,
    d,
    e: ix0 - a * mx0 - c * my0,
    f: iy0 - b * mx0 - d * my0,
  };
}

export function applyAffine(t: Affine, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

/** Mean RGB of a patch. */
export interface meanRgb {
  r: number;
  g: number;
  b: number;
}

/** Mean RGB of a disc of given radius around an image point. */
export function sample(image: ImageRGBA, px: number, py: number, radius: number): meanRgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const x0 = Math.max(0, Math.floor(px - radius));
  const x1 = Math.min(image.width - 1, Math.ceil(px + radius));
  const y0 = Math.max(0, Math.floor(py - radius));
  const y1 = Math.min(image.height - 1, Math.ceil(py + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - px) * (x - px) + (y - py) * (y - py) > radius * radius) continue;
      const o = (y * image.width + x) * 4;
      r += image.data[o]!;
      g += image.data[o + 1]!;
      b += image.data[o + 2]!;
      n++;
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0 };
  return { r: r / n, g: g / n, b: b / n };
}

// ── Full decoding ─────────────────────────────────────────────────────────

/** Decodes the data zone of a captured image for a given codec. */
export function decodeGrid(image: ImageRGBA, codec: Codec, options: DecodeOptions = {}): DecodeResult {
  const candidates = detectFinders(image);
  const triplet = chooseTriplet(candidates);
  if (!triplet) throw new Error("decoder: finder patterns not found");
  const affine = affineFromTriplet(triplet[0], triplet[1], triplet[2]);
  return decodeWithAffine(image, codec, affine, options);
}

/** Variant with a known affine — used by the acceptance tests and by the test-pattern decoder. */
export function decodeWithAffine(
  image: ImageRGBA,
  codec: Codec,
  affine: Affine,
  options: DecodeOptions = {},
): DecodeResult {
  const palette = paletteOf(codec);
  const centroids = options.palette ? options.palette.centroids : palette.map(rgbToLab);
  const confidenceThreshold = options.confidenceThreshold ?? 0.1;
  const bits = bitsPerModule(codec);
  const sampleSize = 0.32; // patch radius, in modules — small to avoid the edges under rotation

  // Pixel/module scale: image distance between two finder centers / module distance.
  const [tl, tr] = [applyAffine(affine, FINDERS[0]![0] + 0.5, FINDERS[0]![1] + 0.5), applyAffine(affine, FINDERS[1]![0] + 0.5, FINDERS[1]![1] + 0.5)];
  const pxPerModule = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) / (GRID_SIZE - 7);
  const radius = Math.max(1, sampleSize * pxPerModule);

  const colors: meanRgb[] = [];
  for (const [x, y] of DATA_MODULES) {
    const [px, py] = applyAffine(affine, x + 0.5, y + 0.5);
    // Single centered patch: with the subpixel affine, widening it (vote over
    // several patches) spills onto the neighbors and degrades the
    // classification — the bleeding costs more than it brings.
    colors.push(sample(image, px, py, radius));
  }

  let confidenceSum = 0;
  let uncertain = 0;
  const stream: number[] = [];
  for (const c of colors) {
    const lab = rgbToLab([c.r, c.g, c.b]);
    const { index, confidence } = classify(lab, centroids);
    confidenceSum += confidence;
    if (confidence < confidenceThreshold) uncertain++;
    for (let b = bits - 1; b >= 0; b--) stream.push((index >> b) & 1);
  }
  const bytes = new Uint8Array(Math.ceil(stream.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    let o = 0;
    for (let b = 0; b < 8; b++) o = (o << 1) | (stream[i * 8 + b] ?? 0);
    bytes[i] = o;
  }
  return {
    bytes,
    meanConfidence: colors.length > 0 ? confidenceSum / colors.length : 0,
    uncertainShare: colors.length > 0 ? uncertain / colors.length : 0,
  };
}
