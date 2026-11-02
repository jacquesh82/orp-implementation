/**
 * "Stream" TM receiver — pure, no DOM: it is given each camera image, it
 * locates, classifies (R / P / mixed), forms a pair at each R↔P switch,
 * decides in TM8 then in TM4 and only returns a frame if Reed-Solomon + CRC
 * validate it. An R subframe (gray) is the same for every frame: it pairs
 * with any recent P, which makes the stream tolerant to images lost during
 * a transfer where frames scroll by.
 */

import { CODEC, Codec, crc32, readFrame } from "@optirelay/core";
import type { ImageRGBA } from "./render.ts";
import type { Location } from "./location.ts";
import {
  analyzeSubframe,
  decideTm,
  subframeDifference,
  locateTm,
  averageSubframes,
  measureTmPair,
  type TmMeasurement,
  type TmSubframe,
} from "./temporal.ts";

export interface TmReceivedFrame {
  /** Decided bytes (full frame, padding included). */
  bytes: Uint8Array;
  /** Recognized mode: COLOR_8 (TM8) or COLOR_4 (TM4). */
  codec: Codec;
  /** False if it is the same frame as the previous one returned. */
  isNew: boolean;
  confidence: number;
  measurement: TmMeasurement;
}

export interface TmImageResult {
  location: Location | null;
  subframe: TmSubframe | null;
  /** Framing advice for the user ("" if all is well). */
  advice: string;
  /** Present when a pair has just produced a valid frame. */
  frame?: TmReceivedFrame;
  /** True when a pair was formed but gave no valid frame. */
  invalidPair?: boolean;
}

export interface TmReceiverStats {
  images: number;
  located: number;
  mixedCount: number;
  pairs: number;
  validCount: number;
}

export interface TmReceiverOptions {
  /** Modes tried, in order (default: TM8 then TM4). */
  codecs?: Codec[];
  /** Maximum age (ms) of a subframe to be paired (default 1200). */
  validityDuration?: number;
  /**
   * AVERAGING (high frame rate video): several images capture the same
   * subframe. The R reference — identical for every frame — is the mean of
   * the grayest Rs of the last second; each new P image is decoded on the
   * mean of the last 4 Ps with the same content. On a real 240 fps slow
   * motion (3×3, TM8), ×7 decoded frames.
   */
  averaging?: boolean;
}

/** Readable framing advice, from the location and the subframe. */
export function framingAdvice(
  loc: Location | null,
  sub: Pick<TmSubframe, "saturation"> | null,
  mixedShare = 0,
): string {
  if (!loc) return "Aim at the screen: keep the three large corner squares in the frame.";
  if (loc.pxPerModule < 6) return "Too far: move closer to the screen.";
  if (!loc.alignment) return "Frame the whole grid, including the bottom-right corner.";
  if (loc.perspectiveSkew > 7) return "Hold the phone more parallel to the screen.";
  if (sub && sub.saturation > 0.03) return "Image saturated: lower the brightness of the sender screen.";
  if (mixedShare > 0.4) return "Many transition images: lengthen the subframe duration.";
  return "";
}

/** Largest displacement of the three finders between two locations, in modules. */
function finderDisplacement(a: Location, b: Location): number {
  let max = 0;
  for (let i = 0; i < 3; i++) {
    max = Math.max(max, Math.hypot(a.finders[i]![0] - b.finders[i]![0], a.finders[i]![1] - b.finders[i]![1]));
  }
  return max / b.pxPerModule;
}

/** Below this (modules), the finders did not move: detection noise only. */
const STILL = 0.08;
/** Beyond this (modules), a jump must be confirmed by the next image. */
const JUMP = 3;

/**
 * RETAINED geometry of a grid: as long as the finders do not move, the same
 * homography serves every image — R and P of a pair are read at the same
 * place, and an image where the alignment pattern was missed (or where a P
 * subframe created a false triangle) no longer makes the grid "jump". A
 * small displacement is followed immediately; a jump of more than JUMP
 * modules is only believed if the next image confirms it (a false triangle
 * does not repeat at the same place).
 */
/** Averaging: maximum age (ms) of the last clean R used as the reference. */
const MEAN_REFERENCE_DURATION = 15000;

export class RetainedGeometry {
  private retained: { loc: Location; t: number; fromR: boolean; jump: Location | null } | null = null;

  /** Geometry to use for the image measured at time `t`. */
  retain(measured: Location, t: number): Location {
    const g = this.retained && t - this.retained.t < 1000 ? this.retained : null;
    if (!g) {
      this.retained = { loc: measured, t, fromR: false, jump: null };
      return measured;
    }
    const deviation = finderDisplacement(measured, g.loc);
    if (deviation < STILL) {
      g.t = t;
      g.jump = null;
      if (!g.loc.alignment && measured.alignment) Object.assign(g, { loc: measured, fromR: false });
      return g.loc;
    }
    if (deviation > JUMP && !(g.jump && finderDisplacement(measured, g.jump) < STILL)) {
      g.jump = measured;
      return g.loc;
    }
    this.retained = { loc: measured, t, fromR: false, jump: null };
    return measured;
  }

  /**
   * The image came from a gray subframe: its finders are sharp. If it is at
   * the same place, its measurement replaces (once) the retained geometry.
   */
  refineFromR(measured: Location): void {
    const g = this.retained;
    if (g && !g.fromR && measured.alignment && finderDisplacement(measured, g.loc) < STILL) {
      Object.assign(g, { loc: measured, fromR: true });
    }
  }

  forget(): void {
    this.retained = null;
  }
}

export class TmReceiver {
  readonly stats: TmReceiverStats = { images: 0, located: 0, mixedCount: 0, pairs: 0, validCount: 0 };
  private readonly codecs: Codec[];
  private readonly validityDuration: number;
  private previous: { loc: Location; t: number } | null = null;
  private readonly geometry = new RetainedGeometry();
  private readonly averaging: boolean;
  /** Averaging: recent Rs, their mean (recomputed at each R), Ps of the current content. */
  private rs: { sub: TmSubframe; t: number }[] = [];
  private rMean: TmSubframe | null = null;
  private nextP: TmSubframe[] = [];
  /** Last saturation measured per type: the advice must not blink at the R/P rate. */
  private saturation: Record<"R" | "P", { v: number; t: number } | null> = { R: null, P: null };
  private last: Record<"R" | "P", { sub: TmSubframe; t: number } | null> = { R: null, P: null };
  private lastType: "R" | "P" | null = null;
  private lastDigest = -1;

  constructor(options: TmReceiverOptions = {}) {
    this.codecs = options.codecs ?? [CODEC.COLOR_8, CODEC.COLOR_4];
    this.validityDuration = options.validityDuration ?? 1200;
    this.averaging = options.averaging ?? false;
  }

  /** Forgets the pairing state (sender change, resume). */
  reset(): void {
    this.previous = null;
    this.geometry.forget();
    this.rs = [];
    this.rMean = null;
    this.nextP = [];
    this.saturation = { R: null, P: null };
    this.last = { R: null, P: null };
    this.lastType = null;
    this.lastDigest = -1;
  }

  process(image: ImageRGBA, t: number): TmImageResult {
    this.stats.images++;
    const tracker = this.previous && t - this.previous.t < 500 ? this.previous.loc : null;
    const loc = locateTm(image, tracker);
    if (!loc) {
      this.previous = null;
      return { location: null, subframe: null, advice: framingAdvice(null, null) };
    }
    return this.processLocated(image, loc, t, false);
  }

  /** Same thing, the grid being ALREADY located (mosaic: one location per cell). */
  processLocated(image: ImageRGBA, measured: Location, t: number, count = true): TmImageResult {
    if (count) this.stats.images++;
    const mixedShare = this.stats.located > 20 ? this.stats.mixedCount / this.stats.located : 0;
    const loc = this.geometry.retain(measured, t);
    this.previous = { loc, t };
    this.stats.located++;
    const sub = analyzeSubframe(image, loc);
    if (sub.type !== "mixed") this.saturation[sub.type] = { v: sub.saturation, t };
    // The "saturated" advice is about the recent R/P couple, not the single image.
    let saturation = 0;
    for (const s of Object.values(this.saturation)) if (s && t - s.t < 1000) saturation = Math.max(saturation, s.v);
    const result: TmImageResult = { location: loc, subframe: sub, advice: framingAdvice(loc, { saturation }, mixedShare) };
    if (sub.type === "R") this.geometry.refineFromR(measured);
    if (sub.type === "mixed") {
      this.stats.mixedCount++;
      this.nextP = [];
      return result;
    }
    if (this.averaging && this.average(sub, t, result)) {
      this.last[sub.type] = { sub, t };
      this.lastType = sub.type;
      return result;
    }
    this.last[sub.type] = { sub, t };
    const flip = this.lastType !== null && this.lastType !== sub.type;
    this.lastType = sub.type;
    if (!flip) return result;
    const other = this.last[sub.type === "R" ? "P" : "R"];
    if (!other || t - other.t > this.validityDuration) return result;

    const [r, p] = sub.type === "R" ? [sub, other.sub] : [other.sub, sub];
    this.stats.pairs++;
    const measurement = measureTmPair(r, p);
    for (const codec of this.codecs) {
      const decision = decideTm(measurement.soft, codec);
      try {
        readFrame(decision.bytes);
      } catch {
        continue;
      }
      this.stats.validCount++;
      const digest = crc32(decision.bytes);
      const isNew = digest !== this.lastDigest;
      this.lastDigest = digest;
      result.frame = { bytes: decision.bytes, codec, isNew, confidence: decision.meanConfidence, measurement };
      return result;
    }
    result.invalidPair = true;
    return result;
  }

  /** Decodes the frame of a pair (R, P); null if no mode validates it. */
  private decoder(r: TmSubframe, p: TmSubframe): TmReceivedFrame | null {
    const measurement = measureTmPair(r, p);
    for (const codec of this.codecs) {
      const decision = decideTm(measurement.soft, codec);
      try {
        readFrame(decision.bytes);
      } catch {
        continue;
      }
      const digest = crc32(decision.bytes);
      const isNew = digest !== this.lastDigest;
      this.lastDigest = digest;
      return { bytes: decision.bytes, codec, isNew, confidence: decision.meanConfidence, measurement };
    }
    return null;
  }

  /**
   * Averaging (see TmReceiverOptions.averaging). Returns true if a valid frame
   * was produced — pairing at the switch is then useless.
   */
  private average(sub: TmSubframe, t: number, result: TmImageResult): boolean {
    if (sub.type === "R") {
      this.nextP = [];
      this.rs.push({ sub, t });
      this.rs = this.rs.filter((x) => t - x.t < 1000 && t >= x.t);
      // The grayest Rs: a short R keeps a remnant of the previous P.
      const sorted = [...this.rs].sort((a, b) => a.sub.activity - b.sub.activity);
      this.rMean = averageSubframes(sorted.slice(0, Math.ceil(sorted.length / 2)).map((x) => x.sub));
      return false;
    }
    // P: same content as the previous one? Otherwise (next batch without a seen R), start over.
    const last = this.nextP[this.nextP.length - 1];
    if (last && subframeDifference(last, sub) > 20) this.nextP = [];
    this.nextP.push(sub);
    if (this.nextP.length > 4) this.nextP.shift();
    // The R is the SAME gray for every frame: its mean remains a valid reference
    // as long as the sending lasts (MEAN_REFERENCE_DURATION), even if the
    // screen no longer shows it long enough for a clean image (17 ms
    // subframe: the R, a single refresh, stays tinted).
    const r = this.rMean;
    if (!r || this.rs.length === 0 || t - this.rs[this.rs.length - 1]!.t > MEAN_REFERENCE_DURATION) return false;
    this.stats.pairs++;
    const frame = this.decoder(r, averageSubframes(this.nextP));
    if (!frame) return false;
    this.stats.validCount++;
    result.frame = frame;
    return true;
  }
}

/**
 * MOSAIC receiver: several grids in the same image, each carrying its own
 * frame. Each grid keeps its place from one image to the next — a "cell" is
 * found again by the position of its top-left finder — and has its own R/P
 * pairing, like a single TmReceiver.
 *
 * A cell NOT found in an image is read again at its last position if it is
 * less than half a second old. This is the common case on a real camera: the
 * gray R subframe shows every grid, the colored P subframe blurs the finder
 * detection and only lets part of them be seen. Without this carry-over, the
 * Rs and Ps of the same cell never met — a single grid of the mosaic was read.
 */
export class TmMosaicReceiver {
  /**
   * `tClean`: last image where the cell was read as a clean R or P. A cell
   * that is NEVER clean is a ghost grid (false triangle straddling two tiles
   * of a P subframe): it is not carried over, it is quickly forgotten and
   * gives way to a real grid at the same place.
   */
  private cells: { x: number; y: number; t: number; created: number; tClean: number; loc: Location; receiver: TmReceiver }[] = [];
  /** Cumulated over every cell, even forgotten ones. */
  readonly stats: TmReceiverStats = { images: 0, located: 0, mixedCount: 0, pairs: 0, validCount: 0 };

  constructor(private readonly options: TmReceiverOptions = {}) {}

  /** Cells seen in the last 2 seconds. */
  get cellCount(): number {
    return this.cells.length;
  }

  reset(): void {
    this.cells = [];
  }

  process(image: ImageRGBA, locs: readonly Location[], t: number): TmImageResult[] {
    // Forgotten: silent for 2 s (framing changed), never clean for 0.5 s, or no
    // longer clean for 1 s (ghosts).
    this.cells = this.cells.filter((c) =>
      t - c.t < 2000 && (c.tClean === -Infinity ? t - c.created < 500 : t - c.tClean < 1000),
    );
    this.stats.images++;
    const served = new Set<(typeof this.cells)[number]>();
    const results: TmImageResult[] = [];
    for (const loc of locs) {
      const [x, y] = loc.finders[0];
      const distance = (k: (typeof this.cells)[number]) => Math.hypot(k.x - x, k.y - y) / loc.pxPerModule;
      let c = this.cells.find((k) => !served.has(k) && distance(k) < 12);
      if (!c) {
        // Overlaps an existing cell (a grid is 41 modules wide, two neighboring
        // tiles are 45 apart): duplicate or ghost, unless the cell in place was
        // never clean — it is then replaced.
        const neighbor = this.cells.find((k) => distance(k) < 30);
        if (neighbor && (served.has(neighbor) || neighbor.tClean !== -Infinity)) continue;
        if (neighbor) this.cells.splice(this.cells.indexOf(neighbor), 1);
        c = { x, y, t, created: t, tClean: -Infinity, loc, receiver: new TmReceiver(this.options) };
        this.cells.push(c);
      }
      Object.assign(c, { x, y, t, loc });
      served.add(c);
      results.push(this.read(c, image, c.loc, t));
    }
    // Carry-over: clean cells missing from THIS image but seen a moment ago.
    for (const c of this.cells) {
      if (served.has(c) || t - c.t > 500 || t - c.tClean > 500) continue;
      results.push(this.read(c, image, c.loc, t));
    }
    // Reading order of the mosaic: rows then columns.
    const step = Math.min(...results.map((r) => r.location?.pxPerModule ?? Infinity)) * 20;
    return results.sort((a, b) => {
      const [ax, ay] = a.location!.finders[0];
      const [bx, by] = b.location!.finders[0];
      return Math.abs(ay - by) > step ? ay - by : ax - bx;
    });
  }

  private read(c: (typeof this.cells)[number], image: ImageRGBA, loc: Location, t: number): TmImageResult {
    const r = c.receiver.processLocated(image, loc, t);
    if (r.subframe && r.subframe.type !== "mixed") c.tClean = t;
    return this.count(r);
  }

  private count(r: TmImageResult): TmImageResult {
    this.stats.located++;
    if (r.subframe?.type === "mixed") this.stats.mixedCount++;
    if (r.frame || r.invalidPair) this.stats.pairs++;
    if (r.frame) this.stats.validCount++;
    return r;
  }
}
