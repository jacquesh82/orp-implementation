/**
 * TM4 / TM8 — differential temporal modulation (annex 10 bis of the ORP v0.1
 * protocol, bench REC-05).
 *
 * Each frame is displayed as TWO alternating subframes:
 *   R (reference): structure + data and pilot zones in mid GRAY;
 *   P (payload)  : identical structure + each data module carries
 *                  gray ± A on each RGB channel (a "direction").
 * The receiver decodes the DIFFERENCE P − R per module.
 *
 *   TM8 — 3 bits/module: r = b2, g = b1, b = b0 (the 8 vertices of the cube).
 *   TM4 — 2 bits/module: 4 EVEN-PARITY vertices of the cube (tetrahedron);
 *         two words always differ on TWO channels, a distance √2 times
 *         larger than in TM8, and a soft decision (maximum likelihood) that
 *         corrects a weak channel — the robust fallback mode.
 *
 * Reception pipeline (each step answers a defect seen on the bench):
 *   1. FRAMING — finders + 5×5 alignment pattern in the bottom-right corner →
 *      homography (perspective of a hand-held phone); each subframe is
 *      located SEPARATELY (the hand moves between R and P).
 *   2. PHOTOMETRY — each subframe is normalized channel by channel on ITS
 *      structure (black of the finders, white of the quiet zone): exposure
 *      and white-balance changes BETWEEN R and P cancel out to first order.
 *   3. COLOR MATRIX — the 16 pilots sweep the 8 directions twice (full
 *      factorial design): the 3×3 screen→camera matrix (gains AND crosstalk
 *      between channels) and the offset are estimated by least squares, then
 *      inverted. This is the real white-balance correction.
 *   4. LOCAL GAIN — the gray of R at the module itself normalizes the
 *      vignetting and the non-uniform lighting of the screen.
 *   5. DECISION + CONFIDENCE — sign per channel (TM8) or closest word (TM4);
 *      confidence = decision margin relative to the amplitude.
 *   6. SUBFRAME CLASSIFICATION — R, P or MIXED (rolling shutter catching the
 *      screen switch: half R, half P) — mixed ones are rejected instead of
 *      producing wrong bytes.
 */

import { CODEC, Codec, mulberry32 } from "@optirelay/core";
import { render, type ImageRGBA } from "./render.ts";
import { sample } from "./decoder.ts";
import { structuralGrid, FINDERS, DATA_MODULES, roleOf, GRID_SIZE } from "./grid.ts";
import { applyH, locate, type Location } from "./location.ts";

/** Modulation amplitude around the gray (sRGB levels). */
export const TM_AMPLITUDE = 64;
const TM_GRAY = 128;

/** TM palette: 0 black, 1 white (structure), 2 gray (R), 3..10 = directions. */
export const TM_PALETTE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [255, 255, 255],
  [TM_GRAY, TM_GRAY, TM_GRAY],
  ...Array.from({ length: 8 }, (_, d) => {
    const v = (bit: number) => (bit ? TM_GRAY + TM_AMPLITUDE : TM_GRAY - TM_AMPLITUDE);
    return [v((d >> 2) & 1), v((d >> 1) & 1), v(d & 1)] as const;
  }),
];

const GRAY = 2; // palette index of the mid gray
const BASE_DIRECTION = 3; // first index of the 8 directions

/** Center (module indices) of the 5×5 alignment pattern — symmetric of FINDERS. */
export const TM_ALIGNMENT: readonly [number, number] = [GRID_SIZE - 4, GRID_SIZE - 4];

export function inTmAlignment(x: number, y: number): boolean {
  return Math.abs(x - TM_ALIGNMENT[0]) <= 2 && Math.abs(y - TM_ALIGNMENT[1]) <= 2;
}

/** TM data modules: those of the v0.1 grid minus the alignment pattern (1398). */
export const TM_DATA_MODULES: readonly (readonly [number, number])[] = DATA_MODULES.filter(
  ([x, y]) => !inTmAlignment(x, y),
);

/** Scrambling mask (XOR) of the TM bytes — fixed sequence, `mulberry32(0x544d5041)`. */
const TM_MASK: Uint8Array = (() => {
  const rng = mulberry32(0x544d5041);
  return Uint8Array.from({ length: Math.ceil((TM_DATA_MODULES.length * 3) / 8) }, () => Math.floor(rng() * 256));
})();

/** Pilots in order: [x, y, direction 0..7]. */
const TM_PILOTS: readonly (readonly [number, number, number])[] = (() => {
  const list: [number, number, number][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (roleOf(x, y) !== "pilot") continue;
      const rank = x === GRID_SIZE - 1 ? y - 8 : x - 8;
      list.push([x, y, rank & 7]);
    }
  }
  return list;
})();

/** Bits per module: TM4 (frame codec COLOR_4) = 2, TM8 (COLOR_8) = 3. */
export function tmBits(codec: Codec): 2 | 3 {
  if (codec === CODEC.COLOR_4) return 2;
  if (codec === CODEC.COLOR_8) return 3;
  throw new Error("TM: only TM4 (COLOR_4) and TM8 (COLOR_8) exist");
}

export function tmName(codec: Codec): "TM4" | "TM8" {
  return tmBits(codec) === 2 ? "TM4" : "TM8";
}

/** Bytes a pair of subframes can carry. */
export function tmCapacity(codec: Codec): number {
  return Math.floor((TM_DATA_MODULES.length * tmBits(codec)) / 8);
}

/** TM4: 2-bit value → even-parity vertex (r, g, b). */
const TM4_WORDS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 0],
];

/** TM palette index of a direction (r = b2, g = b1, b = b0). */
export function directionIndex(b2: number, b1: number, b0: number): number {
  return BASE_DIRECTION + ((b2 & 1) << 2) + ((b1 & 1) << 1) + (b0 & 1);
}

function directionOf(value: number, bits: 2 | 3): number {
  if (bits === 3) return directionIndex(value >> 2, value >> 1, value);
  const [r, g, b] = TM4_WORDS[value & 3]!;
  return directionIndex(r, g, b);
}

/** R subframe (reference): structure + alignment, data and pilots in gray. */
export function referenceSubframe(raw: Uint8Array, codec: Codec): Uint8Array {
  return tmFrame(raw, codec, false);
}

/** P subframe (payload): each module carries its direction, the pilots sweep the 8 directions. */
export function payloadSubframe(raw: Uint8Array, codec: Codec): Uint8Array {
  return tmFrame(raw, codec, true);
}

function tmFrame(raw: Uint8Array, codec: Codec, payload: boolean): Uint8Array {
  const bits = tmBits(codec);
  if (raw.length > tmCapacity(codec)) {
    throw new Error(`TM: frame of ${raw.length} bytes > ${tmName(codec)} capacity of ${tmCapacity(codec)}`);
  }
  // Structure identical to the static grid (pure black/white); pilots,
  // alignment and data are rewritten.
  const g = structuralGrid(codec);
  for (const [x, y, dir] of TM_PILOTS) g[y * GRID_SIZE + x] = payload ? BASE_DIRECTION + dir : GRAY;
  for (const [x, y] of DATA_MODULES) {
    const i = y * GRID_SIZE + x;
    if (inTmAlignment(x, y)) {
      const ring = Math.max(Math.abs(x - TM_ALIGNMENT[0]), Math.abs(y - TM_ALIGNMENT[1]));
      g[i] = ring === 1 ? 1 : 0; // black ring, white ring, black center
    } else {
      g[i] = GRAY;
    }
  }
  if (!payload) return g;

  // Bytes → modules (MSB first, TM_DATA_MODULES order), SCRAMBLED by a fixed
  // pseudo-random mask (XOR). Without it, regular content — the padding zeros
  // of a pairing code, a sparse file — gives uniform "−A" patches: P gets
  // darker than R (auto exposure reacts to the switch) and passes for a
  // MIXED subframe.
  const mask = TM_MASK;
  let bitsLeft = 0;
  let currentByte = 0;
  let cursor = 0;
  for (const [x, y] of TM_DATA_MODULES) {
    let value = 0;
    for (let b = 0; b < bits; b++) {
      if (bitsLeft === 0) {
        currentByte = (cursor < raw.length ? raw[cursor]! : 0) ^ mask[cursor]!;
        cursor++;
        bitsLeft = 8;
      }
      value = (value << 1) | ((currentByte >> (bitsLeft - 1)) & 1);
      bitsLeft--;
    }
    g[y * GRID_SIZE + x] = directionOf(value, bits);
  }
  return g;
}

/** Renders BOTH subframes as screen images (TM palette). */
export function renderTmPair(
  raw: Uint8Array,
  codec: Codec,
  options: { moduleSize?: number; quietZone?: number } = {},
): { reference: ImageRGBA; payload: ImageRGBA } {
  const moduleSize = options.moduleSize ?? 12;
  const quietZone = options.quietZone ?? 2;
  return {
    reference: render(referenceSubframe(raw, codec), TM_PALETTE, { moduleSize, quietZone }),
    payload: render(payloadSubframe(raw, codec), TM_PALETTE, { moduleSize, quietZone }),
  };
}

/** TM test pattern: deterministic pseudo-random data (fixed seed). */
export function tmTestPattern(codec: Codec, seed = 0x4f525031): { reference: Uint8Array; payload: Uint8Array } {
  const rng = mulberry32(seed);
  const bytes = Uint8Array.from({ length: tmCapacity(codec) }, () => Math.floor(rng() * 256));
  return { reference: referenceSubframe(bytes, codec), payload: payloadSubframe(bytes, codec) };
}

// ── Reception ─────────────────────────────────────────────────────────────

/**
 * Locates a TM subframe. If the alignment pattern is not found (colored data
 * around it, blur) but a previous location had it, and the finders barely
 * moved, its perspective is kept.
 */
export function locateTm(image: ImageRGBA, previous?: Location | null): Location | null {
  const loc = locate(image, TM_ALIGNMENT, previous);
  if (!loc) return null;
  if (!loc.alignment && previous?.alignment) {
    let displacement = 0;
    for (let i = 0; i < 3; i++) {
      displacement = Math.max(
        displacement,
        Math.hypot(loc.finders[i]![0] - previous.finders[i]![0], loc.finders[i]![1] - previous.finders[i]![1]),
      );
    }
    if (displacement < 0.5 * loc.pxPerModule) {
      return { ...loc, h: previous.h, alignment: previous.alignment, perspectiveSkew: previous.perspectiveSkew };
    }
  }
  return loc;
}

type RGB = [number, number, number];

export interface TmPhotometry {
  /** Captured level of the structure black, per channel. */
  black: RGB;
  /** Captured level of the structure white, per channel. */
  white: RGB;
}

export interface TmSubframe {
  location: Location;
  /** R (gray), P (colored) or "mixed" (switch caught while reading). */
  type: "R" | "P" | "mixed";
  /** Median chromatic activity of the blocks (normalized levels 0..255). */
  activity: number;
  /** Share of colored data blocks (0..1). */
  coloredShare: number;
  /** Share of saturated data modules (a channel ≥ 250 raw). */
  saturation: number;
  photometry: TmPhotometry;
  /** Normalized RGB (black → 0, white → 255) per module of TM_DATA_MODULES. */
  data: Float32Array;
  /** Normalized RGB of the 16 pilots. */
  pilots: Float32Array;
}

const ACTIVITY_THRESHOLD = 14; // normalized levels: R ≈ 2-6 (noise), P ≈ 40-70

function median(values: number[]): number {
  const t = [...values].sort((a, b) => a - b);
  return t.length === 0 ? 0 : t[t.length >> 1]!;
}

/** Samples a module at its center, a 0.3-module patch at the LOCAL scale (perspective). */
function sampleModule(image: ImageRGBA, loc: Location, x: number, y: number, radiusModules = 0.3) {
  const [px, py] = applyH(loc.h, x + 0.5, y + 0.5);
  const [qx, qy] = applyH(loc.h, x + 1.5, y + 0.5);
  const scale = Math.hypot(qx - px, qy - py);
  return sample(image, px, py, Math.max(1, radiusModules * scale));
}

function measurePhotometry(image: ImageRGBA, loc: Location): TmPhotometry {
  const blacks: RGB[] = [];
  for (const [mx, my] of FINDERS) {
    const c = sampleModule(image, loc, mx, my, 0.8); // black 3×3 core
    blacks.push([c.r, c.g, c.b]);
  }
  // White: quiet zone (2 white modules around the grid), failing that the
  // inner white ring of the finders.
  const whites: RGB[] = [];
  const inside = (x: number, y: number) => {
    const [px, py] = applyH(loc.h, x, y);
    const margin = loc.pxPerModule;
    return px > margin && py > margin && px < image.width - margin && py < image.height - margin;
  };
  for (let k = 0; k < GRID_SIZE; k += 4) {
    for (const [x, y] of [[-1.5, k], [GRID_SIZE + 0.5, k], [k, -1.5], [k, GRID_SIZE + 0.5]] as const) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const c = sampleModule(image, loc, x, y);
      whites.push([c.r, c.g, c.b]);
    }
  }
  if (whites.length < 8) {
    for (const [mx, my] of FINDERS) {
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) {
        const c = sampleModule(image, loc, mx + dx, my + dy, 0.25);
        whites.push([c.r, c.g, c.b]);
      }
    }
  }
  const perChannel = (list: RGB[], c: number) => median(list.map((v) => v[c]!));
  return {
    black: [perChannel(blacks, 0), perChannel(blacks, 1), perChannel(blacks, 2)],
    white: [perChannel(whites, 0), perChannel(whites, 1), perChannel(whites, 2)],
  };
}

/** Samples, normalizes and CLASSIFIES a captured subframe. */
export function analyzeSubframe(image: ImageRGBA, loc: Location): TmSubframe {
  const photometry = measurePhotometry(image, loc);
  const scale = [0, 1, 2].map((c) => 255 / Math.max(16, photometry.white[c]! - photometry.black[c]!));
  const normalize = (v: number, c: number) => (v - photometry.black[c]!) * scale[c]!;

  const data = new Float32Array(TM_DATA_MODULES.length * 3);
  let saturated = 0;
  TM_DATA_MODULES.forEach(([x, y], m) => {
    const c = sampleModule(image, loc, x, y);
    if (c.r >= 250 || c.g >= 250 || c.b >= 250) saturated++;
    data[m * 3] = normalize(c.r, 0);
    data[m * 3 + 1] = normalize(c.g, 1);
    data[m * 3 + 2] = normalize(c.b, 2);
  });
  const pilots = new Float32Array(TM_PILOTS.length * 3);
  TM_PILOTS.forEach(([x, y], i) => {
    const c = sampleModule(image, loc, x, y);
    pilots[i * 3] = normalize(c.r, 0);
    pilots[i * 3 + 1] = normalize(c.g, 1);
    pilots[i * 3 + 2] = normalize(c.b, 2);
  });

  // Classification. PILOT amplitude first: their directions are known, the
  // correlation Σ v·σ / 16 is ≈ A·gain in P and ≈ 0 in R, whatever the noise
  // (mean over 16 modules). Then by 4×4 blocks of the grid: a subframe where
  // only some blocks are colored is a switch caught by the rolling shutter
  // (half R, half P): MIXED, rejected instead of producing wrong bytes.
  let pilotAmplitude = 0;
  TM_PILOTS.forEach(([, , d], i) => {
    const signs = [(d >> 2) & 1 ? 1 : -1, (d >> 1) & 1 ? 1 : -1, d & 1 ? 1 : -1];
    for (let c = 0; c < 3; c++) pilotAmplitude += (pilots[i * 3 + c]! * signs[c]!) / (TM_PILOTS.length * 3);
  });
  const blocks: number[][][] = Array.from({ length: 16 }, () => [[], [], []]);
  TM_DATA_MODULES.forEach(([x, y], m) => {
    const block = Math.floor((y * 4) / GRID_SIZE) * 4 + Math.floor((x * 4) / GRID_SIZE);
    for (let c = 0; c < 3; c++) blocks[block]![c]!.push(data[m * 3 + c]!);
  });
  const activities: number[] = [];
  for (const block of blocks) {
    if (block[0]!.length < 16) continue;
    let sum = 0;
    for (const channel of block) {
      const med = median(channel);
      sum += channel.reduce((a, v) => a + Math.abs(v - med), 0) / channel.length;
    }
    activities.push(sum / 3);
  }
  // Threshold of a colored block: relative to the pilot amplitude if the
  // subframe looks like P; otherwise relative to the calmest block (the noise).
  const pLike = pilotAmplitude >= ACTIVITY_THRESHOLD;
  const calmest = Math.min(...activities);
  const blockThreshold = pLike ? 0.45 * pilotAmplitude : Math.max(ACTIVITY_THRESHOLD, 2 * calmest);
  const colored = activities.filter((a) => a > blockThreshold).length;
  const type: TmSubframe["type"] =
    pLike && colored === activities.length ? "P" : !pLike && colored === 0 ? "R" : "mixed";
  return {
    location: loc,
    type,
    activity: median(activities),
    coloredShare: activities.length > 0 ? colored / activities.length : 0,
    saturation: saturated / TM_DATA_MODULES.length,
    photometry,
    data,
    pilots,
  };
}

/**
 * Mean of several captures of the SAME subframe (same grid, same content):
 * normalized data and pilots averaged, the rest taken from the last one. The
 * sensor noise (short exposure of a slow motion) drops in √n.
 */
export function averageSubframes(list: readonly TmSubframe[]): TmSubframe {
  const last = list[list.length - 1]!;
  if (list.length === 1) return last;
  const data = new Float32Array(last.data.length);
  const pilots = new Float32Array(last.pilots.length);
  for (const s of list) {
    for (let k = 0; k < data.length; k++) data[k]! += s.data[k]!;
    for (let k = 0; k < pilots.length; k++) pilots[k]! += s.pilots[k]!;
  }
  for (let k = 0; k < data.length; k++) data[k]! /= list.length;
  for (let k = 0; k < pilots.length; k++) pilots[k]! /= list.length;
  return { ...last, data, pilots };
}

/** Mean gap (normalized levels) between two captures: ≈ noise if same content, large otherwise. */
export function subframeDifference(a: TmSubframe, b: TmSubframe): number {
  let sum = 0;
  for (let k = 0; k < a.data.length; k++) sum += Math.abs(a.data[k]! - b.data[k]!);
  return sum / a.data.length;
}

export interface TmMeasurement {
  /** Soft values per module and channel (≈ ±1: sent sign × confidence). */
  soft: Float32Array;
  /** Channel gains (diagonal of the matrix), relative to the normalized nominal amplitude. */
  gains: RGB;
  /** Crosstalk: largest off-diagonal term / diagonal. */
  crosstalk: number;
  /** RMS residual of the pilots after the model, relative to the mean gain — the channel "noise". */
  residual: number;
  /** True if the full matrix was inverted (otherwise: diagonal gains only). */
  fullMatrix: boolean;
}

/** Soft measurement of an R/P pair: color matrix on the pilots, inversion, local gain. */
export function measureTmPair(reference: TmSubframe, payload: TmSubframe): TmMeasurement {
  const n = TM_PILOTS.length;
  const signs = TM_PILOTS.map(([, , d]) => [(d >> 2) & 1 ? 1 : -1, (d >> 1) & 1 ? 1 : -1, d & 1 ? 1 : -1]);
  // Δ pilots = G·σ + o — full factorial design ×2: orthogonal columns, the
  // least squares reduce to dot products.
  const G = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const o = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const delta = payload.pilots[i * 3 + c]! - reference.pilots[i * 3 + c]!;
      o[c]! += delta / n;
      for (let j = 0; j < 3; j++) G[c]![j]! += (delta * signs[i]![j]!) / n;
    }
  }
  let residual2 = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const model = G[c]![0]! * signs[i]![0]! + G[c]![1]! * signs[i]![1]! + G[c]![2]! * signs[i]![2]! + o[c]!;
      residual2 += (payload.pilots[i * 3 + c]! - reference.pilots[i * 3 + c]! - model) ** 2;
    }
  }
  const diag: RGB = [G[0]![0]!, G[1]![1]!, G[2]![2]!];
  const meanGain = Math.max(1e-6, (Math.abs(diag[0]) + Math.abs(diag[1]) + Math.abs(diag[2])) / 3);
  let crosstalk = 0;
  for (let c = 0; c < 3; c++) {
    for (let j = 0; j < 3; j++) if (c !== j) crosstalk = Math.max(crosstalk, Math.abs(G[c]![j]!) / Math.max(1e-6, Math.abs(diag[c]!)));
  }

  // Inversion: full matrix if well conditioned, otherwise diagonal.
  const floorValue = 3; // normalized levels — below this, the channel is dead
  let inverse: number[][] | null = null;
  const det =
    G[0]![0]! * (G[1]![1]! * G[2]![2]! - G[1]![2]! * G[2]![1]!) -
    G[0]![1]! * (G[1]![0]! * G[2]![2]! - G[1]![2]! * G[2]![0]!) +
    G[0]![2]! * (G[1]![0]! * G[2]![1]! - G[1]![1]! * G[2]![0]!);
  if (diag.every((d) => d > floorValue) && det > 0.25 * diag[0] * diag[1] * diag[2]) {
    const cof = (r: number, c: number) => {
      const rows = [0, 1, 2].filter((i) => i !== r);
      const columns = [0, 1, 2].filter((i) => i !== c);
      const [a, b] = rows as [number, number];
      const [p, q] = columns as [number, number];
      return ((r + c) % 2 === 0 ? 1 : -1) * (G[a]![p]! * G[b]![q]! - G[a]![q]! * G[b]![p]!);
    };
    inverse = [0, 1, 2].map((r) => [0, 1, 2].map((c) => cof(c, r) / det));
  }
  const inv = inverse ?? [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? 1 / Math.max(floorValue, diag[r]!) : 0)));

  // Local gain: gray of R at the module / mean gray of R at the pilots.
  const luma = (t: Float32Array, i: number) => 0.299 * t[i * 3]! + 0.587 * t[i * 3 + 1]! + 0.114 * t[i * 3 + 2]!;
  let pilotLuma = 0;
  for (let i = 0; i < n; i++) pilotLuma += luma(reference.pilots, i) / n;

  const count = TM_DATA_MODULES.length;
  const soft = new Float32Array(count * 3);
  for (let m = 0; m < count; m++) {
    const y = [0, 1, 2].map((c) => payload.data[m * 3 + c]! - reference.data[m * 3 + c]! - o[c]!);
    const lambda = pilotLuma > 8 ? Math.min(2, Math.max(0.5, luma(reference.data, m) / pilotLuma)) : 1;
    for (let c = 0; c < 3; c++) {
      soft[m * 3 + c] = (inv[c]![0]! * y[0]! + inv[c]![1]! * y[1]! + inv[c]![2]! * y[2]!) / lambda;
    }
  }
  const nominal = TM_AMPLITUDE; // expected amplitude in the normalized scale (black 0, white 255)
  return {
    soft,
    gains: [diag[0] / nominal, diag[1] / nominal, diag[2] / nominal],
    crosstalk,
    residual: Math.sqrt(residual2 / (n * 3)) / meanGain,
    fullMatrix: inverse !== null,
  };
}

export interface TmDecision {
  bytes: Uint8Array;
  /** Mean confidence of the modules (0..1): decision margin / amplitude. */
  meanConfidence: number;
  /** Share of modules under the confidence threshold (0..1). */
  uncertainShare: number;
}

/** Confidence threshold of an "uncertain" module. */
export const TM_UNCERTAIN_THRESHOLD = 0.25;

/** Hard decision from the soft values (possibly cumulated over several pairs). */
export function decideTm(soft: Float32Array, codec: Codec): TmDecision {
  const bits = tmBits(codec);
  const count = soft.length / 3;
  const stream = new Uint8Array(count * bits);
  let confidenceSum = 0;
  let uncertain = 0;
  for (let m = 0; m < count; m++) {
    const s0 = soft[m * 3]!;
    const s1 = soft[m * 3 + 1]!;
    const s2 = soft[m * 3 + 2]!;
    let confidence: number;
    if (bits === 3) {
      stream[m * 3] = s0 > 0 ? 1 : 0;
      stream[m * 3 + 1] = s1 > 0 ? 1 : 0;
      stream[m * 3 + 2] = s2 > 0 ? 1 : 0;
      confidence = Math.min(Math.abs(s0), Math.abs(s1), Math.abs(s2));
    } else {
      // Maximum likelihood among the 4 even-parity words.
      let best = -Infinity;
      let second = -Infinity;
      let value = 0;
      for (let v = 0; v < 4; v++) {
        const [r, g, b] = TM4_WORDS[v]!;
        const score = (r ? s0 : -s0) + (g ? s1 : -s1) + (b ? s2 : -s2);
        if (score > best) {
          second = best;
          best = score;
          value = v;
        } else if (score > second) {
          second = score;
        }
      }
      stream[m * 2] = (value >> 1) & 1;
      stream[m * 2 + 1] = value & 1;
      confidence = (best - second) / 4; // neighboring words: 2 channels apart, ±1 each
    }
    confidence = Math.min(1, Math.max(0, confidence));
    confidenceSum += confidence;
    if (confidence < TM_UNCERTAIN_THRESHOLD) uncertain++;
  }
  const bytes = new Uint8Array(Math.floor(stream.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    let o = 0;
    for (let b = 0; b < 8; b++) o = (o << 1) | stream[i * 8 + b]!;
    bytes[i] = o ^ TM_MASK[i]!;
  }
  return {
    bytes,
    meanConfidence: count > 0 ? confidenceSum / count : 0,
    uncertainShare: count > 0 ? uncertain / count : 0,
  };
}

export type TmResult = TmDecision & Omit<TmMeasurement, "soft"> & { soft: Float32Array; location: Location };

/** Decodes a full pair of images (reference then payload). */
export function decodeTm(reference: ImageRGBA, payload: ImageRGBA, codec: Codec): TmResult {
  const locR = locateTm(reference);
  if (!locR) throw new Error("TM: finder patterns not found in the reference subframe");
  const locP = locateTm(payload, locR) ?? locR;
  const measurement = measureTmPair(analyzeSubframe(reference, locR), analyzeSubframe(payload, locP));
  return { ...measurement, ...decideTm(measurement.soft, codec), location: locR };
}
