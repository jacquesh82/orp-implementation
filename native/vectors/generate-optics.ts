/**
 * Reference vectors of `packages/optical` (and of `TmPipeline`,
 * packages/browser/src/tm-pipeline.ts) for the Rust port `orp-optics`.
 *
 * Run from the repository root:
 *   node node_modules/.pnpm/vite-node@2.1.9/node_modules/vite-node/vite-node.mjs native/vectors/generate-optics.ts
 *
 * Writes into native/vectors/optics/:
 *   - optics.json: grids (hex), 32-bit FNV-1a digests of the rendered and
 *     degraded images (pixels), locations, subframe analyses, decodings,
 *     receiver sequences (single, averaging, mosaic, pipeline);
 *   - a few raw images (*.rgba, RGBA row by row) + their meta in
 *     optics.json — direct inputs of the decoder, independent of the
 *     simulation.
 *
 * The degraded images are DESCRIBED (source + simulation options): the Rust
 * port regenerates them, checks the digest to the pixel, then compares
 * location, analysis and decoding on those same images.
 * Float32Array arrays are summarized by the digest of their bytes
 * (little-endian) — bit-exact equality.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CODEC, Codec, buildFrame, mulberry32, SYMBOL_SIZE, FRAME_VERSION } from "../../packages/core/src/index.ts";
import {
  TM_ALIGNMENT,
  analyzeSubframe,
  calibrate,
  tmCapacity,
  chooseTriplet,
  decodeGrid,
  decodeTm,
  decideTm,
  degradeImage,
  detectFinders,
  encodeTestPattern,
  encodeFrame,
  structuralGrid,
  locate,
  locateTm,
  locateAll,
  measureTmPair,
  TM_DATA_MODULES,
  DATA_MODULE_COUNT,
  TM_PALETTE,
  paletteOf,
  TmMosaicReceiver,
  TmReceiver,
  render,
  renderMosaic,
  renderTmPair,
  simulateCapture,
  payloadSubframe,
  referenceSubframe,
  trackLocation,
  type ImageRGBA,
  type Location,
  type SimulationOptions,
  type TmImageResult,
  type TmSubframe,
} from "../../packages/optical/src/index.ts";
import { TmPipeline } from "../../packages/browser/src/tm-pipeline.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "optics");
mkdirSync(DIR, { recursive: true });

// ── Tools ─────────────────────────────────────────────────────────────────

const hex = (o: Uint8Array | Uint8ClampedArray): string => Buffer.from(o.buffer, o.byteOffset, o.byteLength).toString("hex");

/** 32-bit FNV-1a over bytes. */
function fnv(o: Uint8Array | Uint8ClampedArray | Float32Array): number {
  const b = new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  return h >>> 0;
}

const imageDigest = (img: ImageRGBA) => ({ width: img.width, height: img.height, fnv: fnv(img.data) });

function writeImage(name: string, img: ImageRGBA) {
  writeFileSync(join(DIR, `${name}.rgba`), Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
  return { file: `${name}.rgba`, ...imageDigest(img) };
}

function locJson(l: Location | null) {
  if (!l) return null;
  return {
    h: Array.from(l.h),
    affine: l.affine,
    finders: l.finders,
    alignment: l.alignment,
    perspectiveSkew: l.perspectiveSkew,
    pxPerModule: l.pxPerModule,
    threshold: l.threshold,
  };
}

function subframeJson(s: TmSubframe | null) {
  if (!s) return null;
  return {
    type: s.type,
    activity: s.activity,
    coloredShare: s.coloredShare,
    saturation: s.saturation,
    photometry: s.photometry,
    data: fnv(s.data),
    pilots: Array.from(s.pilots),
    location: locJson(s.location),
  };
}

function resultJson(r: TmImageResult) {
  return {
    location: locJson(r.location),
    type: r.subframe?.type ?? null,
    activity: r.subframe?.activity ?? null,
    advice: r.advice,
    invalidPair: r.invalidPair ?? false,
    frame: r.frame
      ? { bytes: hex(r.frame.bytes), codec: r.frame.codec, isNew: r.frame.isNew, confidence: r.frame.confidence, soft: fnv(r.frame.measurement.soft) }
      : null,
  };
}

// ── Frames and grids ──────────────────────────────────────────────────────

function frame(codec: Codec, seed: number, token: number, block: number, k: number, headerSeed: number): Uint8Array {
  const count = codec === CODEC.COLOR_8 ? 4 : 2;
  const rng = mulberry32(seed);
  const payload = Uint8Array.from({ length: count * SYMBOL_SIZE }, () => Math.floor(rng() * 256));
  return buildFrame({ version: FRAME_VERSION, codec, flags: 0, token, block, k, symbolCount: count, seed: headerSeed }, payload);
}
/** The one of temporal.spec.ts. */
const testFrame = (codec: Codec) => frame(codec, 2026 + codec, 0x544d38, 1, 4, 7);
/** The one of tm-receiver.spec.ts. */
const streamFrame = (codec: Codec, seed: number) => frame(codec, seed, 7, 0, 8, seed);

const T8 = testFrame(CODEC.COLOR_8);
const T4 = testFrame(CODEC.COLOR_4);
const output: Record<string, unknown> = {};

// Whitening mask: decided from all-positive soft values (stream of ones)
// → bytes = 0xFF ^ mask.
const softOnes = new Float32Array(TM_DATA_MODULES.length * 3).fill(1);
output.structure = {
  dataModuleCount: DATA_MODULE_COUNT,
  tmDataModuleCount: TM_DATA_MODULES.length,
  tmCapacity8: tmCapacity(CODEC.COLOR_8),
  tmCapacity4: tmCapacity(CODEC.COLOR_4),
  tmPalette: TM_PALETTE,
  structureC8: hex(structuralGrid(CODEC.COLOR_8)),
  onesDecision8: hex(decideTm(softOnes, CODEC.COLOR_8).bytes),
  onesDecision4: hex(decideTm(softOnes, CODEC.COLOR_4).bytes),
};

const GRIDS: Record<string, Uint8Array> = {
  R8: referenceSubframe(T8, CODEC.COLOR_8),
  P8: payloadSubframe(T8, CODEC.COLOR_8),
  R4: referenceSubframe(T4, CODEC.COLOR_4),
  P4: payloadSubframe(T4, CODEC.COLOR_4),
};
output.frames = { T8: hex(T8), T4: hex(T4) };
output.grids = Object.fromEntries(Object.entries(GRIDS).map(([k, g]) => [k, hex(g)]));

// Static grids (nominal palettes): COLOR_8 frame and test pattern.
const staticHeader = { version: FRAME_VERSION, codec: CODEC.COLOR_8, flags: 0, token: 0x11223344, block: 2, k: 50, symbolCount: 4, seed: 99 };
const rngS = mulberry32(2026);
const staticPayload = Uint8Array.from({ length: 4 * SYMBOL_SIZE }, () => Math.floor(rngS() * 256));
const staticGrid = encodeFrame(staticHeader, staticPayload);
const testPatternC8 = encodeTestPattern(CODEC.COLOR_8);
output.static = { grid: hex(staticGrid), testPattern: hex(testPatternC8), payload: hex(staticPayload) };

// ── Renders (pixels) ──────────────────────────────────────────────────────

const pair8 = renderTmPair(T8, CODEC.COLOR_8, { moduleSize: 6 });
const frames4 = [0, 1, 2, 3].map((i) => streamFrame(CODEC.COLOR_8, 100 + i));
const mosR = renderMosaic(frames4.map((t) => referenceSubframe(t, CODEC.COLOR_8)), TM_PALETTE, 2, { moduleSize: 8, quietZone: 2 });
const mosP = renderMosaic(frames4.map((t) => payloadSubframe(t, CODEC.COLOR_8)), TM_PALETTE, 2, { moduleSize: 8, quietZone: 2 });
const mos3 = renderMosaic(frames4.slice(0, 3).map((t) => payloadSubframe(t, CODEC.COLOR_8)), TM_PALETTE, 2, { moduleSize: 3, quietZone: 1 });
output.renders = {
  pairR6: imageDigest(pair8.reference),
  pairP6: imageDigest(pair8.payload),
  static8: imageDigest(render(staticGrid, paletteOf(CODEC.COLOR_8), { moduleSize: 8 })),
  mosaicR: imageDigest(mosR),
  mosaicP: imageDigest(mosP),
  mosaic3Incomplete: imageDigest(mos3),
  mosaicFrames: frames4.map(hex),
};

// ── Simulations (pixels) ──────────────────────────────────────────────────

const HOSTILE: SimulationOptions = { rotationDegrees: 4, gains: [1.4, 0.65, 1.2], noise: 7, seed: 5, haze: [30, -15, 10] };
const PERSP: SimulationOptions = { perspective: [0.15, -0.1], scale: 0.75, rotationDegrees: 6, noise: 5, seed: 9, moduleSize: 10 };
const MATRIX = [
  [0.75, 0.3, -0.12],
  [0.28, 0.7, 0.18],
  [-0.1, 0.32, 0.72],
] as const;
const HARD: SimulationOptions = { rotationDegrees: 4, noise: 10, perspective: [0.12, 0.05], scale: 0.85, blur: 1, gains: [1.2, 0.85, 1.1], haze: [20, 20, 25], translation: [8, -6] };

/** Description of a degraded image: source + options. */
interface Sim {
  name: string;
  /** TM grid ("R8", …), "static", "test-pattern", "mosaicR", "mosaicP". */
  source: string;
  options: SimulationOptions;
}
const SIMS: Sim[] = [
  { name: "R8-hostile", source: "R8", options: HOSTILE },
  { name: "P8-hostile", source: "P8", options: { ...HOSTILE, seed: 6 } },
  { name: "R4-hostile", source: "R4", options: HOSTILE },
  { name: "P4-hostile", source: "P4", options: { ...HOSTILE, seed: 6 } },
  { name: "R8-persp", source: "R8", options: PERSP },
  { name: "P8-persp", source: "P8", options: { ...PERSP, seed: 10 } },
  { name: "R8-matrix", source: "R8", options: { matrix: MATRIX, gains: [1.1, 1, 0.9], haze: [12, 8, 20], noise: 5, seed: 3 } },
  { name: "P8-matrix", source: "P8", options: { matrix: MATRIX, gains: [0.85, 0.95, 1.1], haze: [25, 0, 5], noise: 5, seed: 4 } },
  { name: "R4-rot233", source: "R4", options: { rotationDegrees: 233, scale: 0.7, noise: 4, seed: 233, moduleSize: 12 } },
  { name: "P4-rot233", source: "P4", options: { rotationDegrees: 233, scale: 0.7, noise: 4, seed: 234, moduleSize: 12 } },
  { name: "R8-hard", source: "R8", options: { ...HARD, seed: 21 } },
  { name: "P8-hard", source: "P8", options: { ...HARD, seed: 22 } },
  { name: "static-C8", source: "static", options: { rotationDegrees: 4, noise: 6, seed: 7 } },
  { name: "test-pattern-C8", source: "test-pattern", options: { gains: [1.25, 0.85, 1.1] } },
  { name: "mosR-channel", source: "mosaicR", options: { rotationDegrees: 4, scale: 0.92, gains: [1.2, 0.85, 1.1], noise: 5, seed: 7 } },
  { name: "mosP-channel", source: "mosaicP", options: { rotationDegrees: 4, scale: 0.92, gains: [1.2, 0.85, 1.1], noise: 5, seed: 8 } },
];
function produce(s: Sim): ImageRGBA {
  switch (s.source) {
    case "static":
      return simulateCapture(staticGrid, paletteOf(CODEC.COLOR_8), s.options);
    case "test-pattern":
      return simulateCapture(testPatternC8, paletteOf(CODEC.COLOR_8), s.options);
    case "mosaicR":
      return degradeImage(mosR, s.options);
    case "mosaicP":
      return degradeImage(mosP, s.options);
    default:
      return simulateCapture(GRIDS[s.source]!, TM_PALETTE, s.options);
  }
}
const IMAGES: Record<string, ImageRGBA> = {};
for (const s of SIMS) IMAGES[s.name] = produce(s);
output.simulations = SIMS.map((s) => ({ ...s, ...imageDigest(IMAGES[s.name]!) }));

// Raw inputs of the decoder (independent of the simulation).
output.rawImages = {
  R: writeImage("pair-tm8-hostile-r", IMAGES["R8-hostile"]!),
  P: writeImage("pair-tm8-hostile-p", IMAGES["P8-hostile"]!),
};

// ── Location ──────────────────────────────────────────────────────────────

const locations: Record<string, unknown> = {};
for (const name of ["R8-hostile", "P8-hostile", "R8-persp", "P8-persp", "R4-rot233", "R8-hard", "P8-hard"]) {
  const img = IMAGES[name]!;
  const candidates = detectFinders(img);
  const locR = locateTm(img);
  locations[name] = {
    candidates,
    localCandidates: detectFinders(img, { threshold: "local" }).length,
    triplet: chooseTriplet(candidates),
    affineOnly: locJson(locate(img)),
    tm: locJson(locR),
    all: locateAll(img, TM_ALIGNMENT).map(locJson),
  };
}
// Tracking: P located with R as the previous location, and fast windowed tracking.
{
  const locR = locateTm(IMAGES["R8-persp"]!)!;
  locations["tracking-persp"] = {
    tmWithPrevious: locJson(locateTm(IMAGES["P8-persp"]!, locR)),
    trackLocation: locJson(trackLocation(IMAGES["P8-persp"]!, locR, TM_ALIGNMENT)),
    trackStill: locJson(trackLocation(IMAGES["R8-persp"]!, locR, TM_ALIGNMENT)),
  };
}
output.locations = locations;

// ── Subframe analysis and pair decoding ───────────────────────────────────

const analyses: Record<string, unknown> = {};
const decodings: Record<string, unknown> = {};
for (const [nameR, nameP, codec] of [
  ["R8-hostile", "P8-hostile", CODEC.COLOR_8],
  ["R4-hostile", "P4-hostile", CODEC.COLOR_4],
  ["R8-persp", "P8-persp", CODEC.COLOR_8],
  ["R8-matrix", "P8-matrix", CODEC.COLOR_8],
  ["R4-rot233", "P4-rot233", CODEC.COLOR_4],
  ["R8-hard", "P8-hard", CODEC.COLOR_8],
] as const) {
  const r = IMAGES[nameR]!;
  const p = IMAGES[nameP]!;
  const locR = locateTm(r)!;
  const locP = locateTm(p, locR) ?? locR;
  const sR = analyzeSubframe(r, locR);
  const sP = analyzeSubframe(p, locP);
  analyses[nameR] = subframeJson(sR);
  analyses[nameP] = subframeJson(sP);
  const d = decodeTm(r, p, codec);
  const measurement = measureTmPair(sR, sP);
  decodings[`${nameR}+${nameP}`] = {
    codec,
    bytes: hex(d.bytes),
    meanConfidence: d.meanConfidence,
    uncertainShare: d.uncertainShare,
    gains: d.gains,
    crosstalk: d.crosstalk,
    residual: d.residual,
    fullMatrix: d.fullMatrix,
    soft: fnv(d.soft),
    softMeasured: fnv(measurement.soft),
    // The other mode on the same soft values.
    otherMode: hex(decideTm(d.soft, codec === CODEC.COLOR_8 ? CODEC.COLOR_4 : CODEC.COLOR_8).bytes),
  };
}
// MIXED subframe: top half R, bottom half P.
{
  const r = IMAGES["R8-hostile"]!;
  const p = IMAGES["P8-hostile"]!;
  const mixed: ImageRGBA = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
  const cut = Math.floor(r.height / 2) * r.width * 4;
  mixed.data.set(p.data.subarray(cut), cut);
  analyses["mixed-hostile"] = subframeJson(analyzeSubframe(mixed, locateTm(r)!));
}
output.analyses = analyses;
output.decodings = decodings;

// ── Receivers ─────────────────────────────────────────────────────────────

/** Image sequence of a receiver: description + timestamp. */
interface Step {
  source: string;
  options: SimulationOptions;
  t: number;
}

// 1) Stream R, P1, R, P2, R, P3 (tm-receiver.spec.ts), TM8 then TM4.
const sequences: Record<string, unknown> = {};
for (const codec of [CODEC.COLOR_8, CODEC.COLOR_4] as const) {
  const options: SimulationOptions = { rotationDegrees: 3, gains: [1.2, 0.8, 1.1], noise: 5, perspective: [0.08, 0], scale: 0.85 };
  const frames = [11, 12, 13].map((g) => streamFrame(codec, g));
  const receiver = new TmReceiver();
  const steps: unknown[] = [];
  let t = 0;
  let seed = 1;
  for (const raw of frames) {
    for (const [kind, grid] of [["R", referenceSubframe(raw, codec)], ["P", payloadSubframe(raw, codec)]] as const) {
      const opts = { ...options, seed: seed++ };
      const image = simulateCapture(grid, TM_PALETTE, opts);
      const r = receiver.process(image, (t += 250));
      steps.push({ kind, frame: hex(raw), options: opts, t, image: imageDigest(image), result: resultJson(r) });
    }
  }
  sequences[codec === CODEC.COLOR_8 ? "stream8" : "stream4"] = { steps, stats: receiver.stats };
}

// 2) Still camera, hard conditions: locateAll + processLocated.
{
  const receiver = new TmReceiver();
  const steps: unknown[] = [];
  let t = 0;
  let seed = 1;
  for (let i = 0; i < 6; i++) {
    const raw = streamFrame(CODEC.COLOR_8, 100 + i);
    for (const [kind, grid] of [["R", referenceSubframe(raw, CODEC.COLOR_8)], ["P", payloadSubframe(raw, CODEC.COLOR_8)]] as const) {
      const opts: SimulationOptions = { ...HARD, translation: [0, 0], seed: seed++ };
      const image = simulateCapture(grid, TM_PALETTE, opts);
      const locs = locateAll(image, TM_ALIGNMENT);
      t += 150;
      const r = locs[0] ? receiver.processLocated(image, locs[0], t) : receiver.process(image, t);
      steps.push({ kind, frame: hex(raw), options: opts, t, image: imageDigest(image), locationCount: locs.length, result: resultJson(r) });
    }
  }
  sequences.hard = { steps, stats: receiver.stats };
}

// 3) Averaging (240 fps slow motion): every subframe captured 3 times, strong noise.
{
  const receiver = new TmReceiver({ averaging: true });
  const steps: unknown[] = [];
  let t = 0;
  let seed = 500;
  for (let i = 0; i < 3; i++) {
    const raw = streamFrame(CODEC.COLOR_8, 300 + i);
    for (const [kind, grid] of [["R", referenceSubframe(raw, CODEC.COLOR_8)], ["P", payloadSubframe(raw, CODEC.COLOR_8)]] as const) {
      for (let k = 0; k < 3; k++) {
        const opts: SimulationOptions = { rotationDegrees: 2, gains: [1.1, 0.9, 1.05], noise: 30, seed: seed++ };
        const image = simulateCapture(grid, TM_PALETTE, opts);
        const r = receiver.process(image, (t += 1000 / 240));
        steps.push({ kind, frame: hex(raw), options: opts, t, image: imageDigest(image), result: resultJson(r) });
      }
    }
  }
  sequences.averaging = { steps, stats: receiver.stats };
}

// 4) 2×2 mosaic: location of every grid, R then P, and a partial P.
{
  const imgR = IMAGES["mosR-channel"]!;
  const imgP = IMAGES["mosP-channel"]!;
  const locsR = locateAll(imgR, TM_ALIGNMENT);
  const locsP = locateAll(imgP, TM_ALIGNMENT);
  const complete = new TmMosaicReceiver();
  const r1 = complete.process(imgR, locsR, 0).map(resultJson);
  const r2 = complete.process(imgP, locsP, 250).map(resultJson);
  const partial = new TmMosaicReceiver();
  const q1 = partial.process(imgR, locsR, 0).map(resultJson);
  const q2 = partial.process(imgP, locsP.slice(0, 1), 150).map(resultJson);
  sequences.mosaic = {
    locsR: locsR.map(locJson),
    locsP: locsP.map(locJson),
    complete: { r: r1, p: r2, stats: complete.stats, cells: complete.cellCount },
    partial: { r: q1, p: q2, stats: partial.stats, cells: partial.cellCount },
  };
}

// 5) TmPipeline (without DOM): single grid then mosaic, with fast tracking.
{
  const pipeline = new TmPipeline();
  const steps: unknown[] = [];
  let t = 0;
  const channel: SimulationOptions = { rotationDegrees: 3, gains: [1.15, 0.9, 1.05], noise: 4, scale: 0.9 };
  let seed = 900;
  const add = (desc: Record<string, unknown>, image: ImageRGBA, dt: number) => {
    t += dt;
    const all = pipeline.process(image, t);
    steps.push({ ...desc, t, image: imageDigest(image), results: all.map(resultJson), tally: { ...pipeline.tracker.tally } });
  };
  // Single grid: R, P, R, P, R (same frame then another one).
  for (const [i, kind] of [[0, "R"], [0, "P"], [0, "R"], [1, "P"], [1, "R"], [1, "P"]] as const) {
    const raw = streamFrame(CODEC.COLOR_8, 700 + i);
    const grid = kind === "R" ? referenceSubframe(raw, CODEC.COLOR_8) : payloadSubframe(raw, CODEC.COLOR_8);
    const options = { ...channel, seed: seed++ };
    add({ kind: "single", subframe: kind, frame: hex(raw), options }, simulateCapture(grid, TM_PALETTE, options), 100);
  }
  // 2×2 mosaic: R, P, R, P (two batches).
  for (const [batch, kind] of [[0, "R"], [0, "P"], [1, "R"], [1, "P"]] as const) {
    const frames = [0, 1, 2, 3].map((i) => streamFrame(CODEC.COLOR_8, 800 + 10 * batch + i));
    const grids = frames.map((b) => (kind === "R" ? referenceSubframe(b, CODEC.COLOR_8) : payloadSubframe(b, CODEC.COLOR_8)));
    const options = { ...channel, seed: seed++ };
    const image = degradeImage(renderMosaic(grids, TM_PALETTE, 2, { moduleSize: 8, quietZone: 2 }), options);
    add({ kind: "mosaic", subframe: kind, frames: frames.map(hex), options }, image, 120);
  }
  sequences.pipeline = { steps, stats: pipeline.stats, tally: pipeline.tracker.tally };
}
output.sequences = sequences;

// ── Static codecs (nominal palettes) ──────────────────────────────────────

{
  const img = IMAGES["static-C8"]!;
  const d = decodeGrid(img, CODEC.COLOR_8);
  const testPattern = IMAGES["test-pattern-C8"]!;
  const cal = calibrate(testPattern, CODEC.COLOR_8);
  const dCal = decodeGrid(img, CODEC.COLOR_8, { palette: cal });
  output.staticDecoding = {
    nominal: { bytes: hex(d.bytes), meanConfidence: d.meanConfidence, uncertainShare: d.uncertainShare },
    calibration: cal,
    calibrated: { bytes: hex(dCal.bytes), meanConfidence: dCal.meanConfidence, uncertainShare: dCal.uncertainShare },
  };
}

writeFileSync(join(DIR, "optics.json"), JSON.stringify(output, null, 1));
console.log(`optical vectors written to ${DIR}`);
