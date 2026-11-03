/**
 * Choice of the finder triplets: the pruned enumeration (decoder.ts) must
 * give EXACTLY the result of the former exhaustive scan over every triple —
 * kept here as the reference — and stay fast on large mosaics.
 */
import { describe, expect, it } from "vitest";
import { CODEC, Codec, buildFrame, mulberry32, SYMBOL_SIZE, FRAME_VERSION } from "@optirelay/core";
import { affineFromTriplet, chooseTriplet, chooseTriplets, type FinderCandidate } from "../src/decoder.ts";
import { GRID_SIZE } from "../src/grid.ts";
import {
  TM_ALIGNMENT,
  TM_PALETTE,
  TmMosaicReceiver,
  degradeImage,
  detectFinders,
  locateAll,
  payloadSubframe,
  referenceSubframe,
  renderMosaic,
} from "../src/index.ts";

/** VERBATIM copy of the former exhaustive O(n³) chooseTriplet — the reference. */
function referenceChooseTriplet(candidates: FinderCandidate[]): [[number, number], [number, number], [number, number]] | null {
  let best: { d: [[number, number], [number, number], [number, number]]; error: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const pts = [candidates[i]!, candidates[j]!, candidates[k]!];
        // A module smaller than 5 px cannot be decoded — the "triplet" is scene
        // noise (e.g. 3.7 % confidence on a bowl).
        const side1 = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
        const side2 = Math.hypot(pts[0]!.x - pts[2]!.x, pts[0]!.y - pts[2]!.y);
        if (Math.min(side1, side2) / 34 < 5) continue;
        const d = (p: FinderCandidate, q: FinderCandidate) => Math.hypot(p.x - q.x, p.y - q.y);
        const sides = [
          { length: d(pts[1]!, pts[2]!), opposite: 0 },
          { length: d(pts[0]!, pts[2]!), opposite: 1 },
          { length: d(pts[0]!, pts[1]!), opposite: 2 },
        ].sort((a, b2) => b2.length - a.length);
        const hypotenuse = sides[0]!.length;
        const c1 = sides[1]!.length;
        const c2 = sides[2]!.length;
        const pythagoreanError = Math.abs(hypotenuse * hypotenuse - (c1 * c1 + c2 * c2)) / (hypotenuse * hypotenuse);
        const isoscelesError = Math.abs(c1 - c2) / Math.max(c1, c2);
        const error = pythagoreanError + isoscelesError;
        if (pythagoreanError > 0.15 || isoscelesError > 0.2) continue;
        // Scale consistency: the module size given by the triangle (side / 34)
        // must be the one measured by the finders themselves. Their `score`
        // is the length of the 1:1:3:1:1 pattern along a HORIZONTAL row,
        // i.e. 7 modules / max(|cos θ|, |sin θ|) for a grid rotated by θ: we
        // bring it back to the angle of the triangle. Without this test, the
        // top-left finders of three NEIGHBORING grids (mosaic) form an
        // isosceles right triangle that is just as perfect, 45 modules on a
        // side instead of 34.
        {
          const vertexE = pts[sides[0]!.opposite]!;
          const otherE = pts.find((_, idx) => idx !== sides[0]!.opposite)!;
          const theta = Math.atan2(otherE.y - vertexE.y, otherE.x - vertexE.x);
          const tilt = Math.max(Math.abs(Math.cos(theta)), Math.abs(Math.sin(theta)));
          const finderModule = ((pts[0]!.score + pts[1]!.score + pts[2]!.score) / 21) * tilt;
          const triangleModule = (c1 + c2) / 2 / 34;
          if (Math.abs(triangleModule / finderModule - 1) > 0.18) continue;
        }
        if (!best || error < best.error) {
          // TL = vertex opposite the hypotenuse; TR/BL in angle order.
          const vertex = pts[sides[0]!.opposite]!;
          const others = pts.filter((_, idx) => idx !== sides[0]!.opposite);
          // TR / BL by the SIGN of the cross product (image frame, y pointing
          // down: TL→TR then TL→BL turns clockwise). The former "largest x"
          // criterion swapped TR and BL as soon as the phone rotated by more
          // than 45° — grid read mirrored, everything wrong.
          const [p, q] = [others[0]!, others[1]!];
          const cross = (p.x - vertex.x) * (q.y - vertex.y) - (p.y - vertex.y) * (q.x - vertex.x);
          const [tr, bl] = cross > 0 ? [p, q] : [q, p];
          best = { d: [[vertex.x, vertex.y], [tr.x, tr.y], [bl.x, bl.y]] as [[number, number], [number, number], [number, number]], error };
        }
      }
    }
  }
  return best ? best.d : null;
}

/** The former greedy loop of locateFromCandidates, on the reference choice. */
function referenceChooseTriplets(candidates: FinderCandidate[], maximum: number) {
  let remaining = candidates;
  const chosen: [[number, number], [number, number], [number, number]][] = [];
  while (chosen.length < maximum) {
    const triplet = referenceChooseTriplet(remaining);
    if (!triplet) break;
    chosen.push(triplet);
    const { a, b, c, d, e, f } = affineFromTriplet(triplet[0], triplet[1], triplet[2]);
    const det = a * d - b * c;
    remaining = remaining.filter((k) => {
      const mx = (d * (k.x - e) - c * (k.y - f)) / det;
      const my = (a * (k.y - f) - b * (k.x - e)) / det;
      return mx < -2 || my < -2 || mx > GRID_SIZE + 2 || my > GRID_SIZE + 2;
    });
  }
  return chosen;
}

type Rng = () => number;

/** Finders of `grids` synthetic grids (random size, angle, position), each one detected 1 to 3 times, plus noise. */
function mosaicCandidates(rng: Rng, grids: number, noise: number): FinderCandidate[] {
  const out: FinderCandidate[] = [];
  for (let g = 0; g < grids; g++) {
    const u = 4.5 + rng() * 8;
    const theta = rng() * 2 * Math.PI;
    const [ox, oy] = [rng() * 1600, rng() * 1600];
    const tilt = Math.max(Math.abs(Math.cos(theta)), Math.abs(Math.sin(theta)));
    for (const [mx, my] of [[3.5, 3.5], [37.5, 3.5], [3.5, 37.5]] as const) {
      const x = ox + u * (mx * Math.cos(theta) - my * Math.sin(theta));
      const y = oy + u * (mx * Math.sin(theta) + my * Math.cos(theta));
      const copies = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < copies; k++) {
        out.push({ x: x + (rng() - 0.5) * 1.2, y: y + (rng() - 0.5) * 1.2, score: Math.round(((7 * u) / tilt) * (0.9 + 0.2 * rng())) });
      }
    }
  }
  for (let k = 0; k < noise; k++) out.push({ x: rng() * 2000, y: rng() * 2000, score: 14 + Math.floor(rng() * 186) });
  // Random order: the tie-break (first triple in candidate order) is exercised too.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Triangles drawn AROUND the acceptance limits (angle, legs ratio, scale), a few other points. */
function borderCandidates(rng: Rng): FinderCandidate[] {
  const out: FinderCandidate[] = [];
  const triangles = 1 + Math.floor(rng() * 2);
  for (let t = 0; t < triangles; t++) {
    const [vx, vy] = [rng() * 1000, rng() * 1000];
    // A third of the legs near the 5 px/module floor (170 px, 136 for the short leg).
    const leg = rng() < 0.33 ? 125 + rng() * 75 : 120 + rng() * 500;
    const phi = rng() * 2 * Math.PI;
    const lambda = 0.7 + rng() * 0.65;
    const delta = ((rng() - 0.5) * 32 * Math.PI) / 180;
    const side = rng() < 0.5 ? 1 : -1;
    const p = { x: vx + leg * Math.cos(phi), y: vy + leg * Math.sin(phi) };
    const psi = phi + side * (Math.PI / 2 + delta);
    const q = { x: vx + lambda * leg * Math.cos(psi), y: vy + lambda * leg * Math.sin(psi) };
    const tilt = Math.max(Math.abs(Math.cos(phi)), Math.abs(Math.sin(phi)));
    const finderModule = (leg * (1 + lambda)) / 2 / 34 / (0.75 + rng() * 0.5);
    const sum = (21 * finderModule) / tilt;
    const w = [0.2 + rng(), 0.2 + rng(), 0.2 + rng()];
    const total = w[0]! + w[1]! + w[2]!;
    [{ x: vx, y: vy }, p, q].forEach((pt, i) => out.push({ ...pt, score: Math.max(1, (sum * w[i]!) / total) }));
  }
  const extra = Math.floor(rng() * 4);
  for (let k = 0; k < extra; k++) out.push({ x: rng() * 1000, y: rng() * 1000, score: 14 + rng() * 150 });
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("triplet choice: same result as the exhaustive scan", () => {
  it("triangles around the acceptance limits", () => {
    const rng = mulberry32(11);
    let accepted = 0;
    for (let n = 0; n < 4000; n++) {
      const c = borderCandidates(rng);
      const expected = referenceChooseTriplet(c);
      if (expected) accepted++;
      expect(chooseTriplet(c)).toEqual(expected);
      expect(chooseTriplets(c, 49)).toEqual(referenceChooseTriplets(c, 49));
    }
    // The draw really straddles the limits: a good share accepted, a good share refused.
    expect(accepted).toBeGreaterThan(400);
    expect(accepted).toBeLessThan(3600);
  });

  it("random mosaics: duplicated finders, noise, random order", () => {
    const rng = mulberry32(12);
    for (let n = 0; n < 120; n++) {
      const c = mosaicCandidates(rng, 1 + Math.floor(rng() * 6), Math.floor(rng() * 40));
      expect(chooseTriplet(c)).toEqual(referenceChooseTriplet(c));
      expect(chooseTriplets(c, 49)).toEqual(referenceChooseTriplets(c, 49));
    }
  });

  it("real detections: 3×3 mosaic, P subframe (≈ 150 candidates, both thresholds)", () => {
    const frames = Array.from({ length: 9 }, (_, i) => frame(CODEC.COLOR_8, 100 + i));
    const p = renderMosaic(frames.map((t) => payloadSubframe(t, CODEC.COLOR_8)), TM_PALETTE, 3, { moduleSize: 7, quietZone: 2 });
    const img = degradeImage(p, { ...CHANNEL, seed: 2 });
    for (const threshold of ["otsu", "local"] as const) {
      const c = detectFinders(img, { threshold });
      expect(c.length).toBeGreaterThan(80);
      const expected = referenceChooseTriplets(c, 49);
      expect(expected.length).toBe(9);
      expect(chooseTriplets(c, 49)).toEqual(expected);
      expect(chooseTriplet(c)).toEqual(expected[0]);
    }
  });
});

function frame(codec: Codec, seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const payload = Uint8Array.from({ length: 4 * SYMBOL_SIZE }, () => Math.floor(rng() * 256));
  return buildFrame({ version: FRAME_VERSION, codec, flags: 0, token: 9, block: 0, k: 40, symbolCount: 4, seed }, payload);
}

const CHANNEL = { rotationDegrees: 4, scale: 0.92, gains: [1.2, 0.85, 1.1] as const, noise: 5 };

describe("large mosaics: located and decoded in bounded time", () => {
  // Measured alone on an i5-13600K (P subframe, the hardest one: dozens of
  // false patterns): 4×4 ≈ 90 ms, 5×5 ≈ 150 ms, 6×6 ≈ 230 ms, 7×7 ≈ 330 ms —
  // against 3.5 s, 22 s and "never" with the former exhaustive choice. Bounds
  // with a wide margin (parallel test workers), still far below the O(n³).
  for (const [columns, bound] of [[4, 800], [5, 1000], [6, 1500], [7, 2000]] as const) {
    it(`${columns}×${columns}: every grid found and decoded, locateAll(P) < ${bound} ms`, () => {
      const n = columns * columns;
      const frames = Array.from({ length: n }, (_, i) => frame(CODEC.COLOR_8, 100 + i));
      const options = { moduleSize: 7, quietZone: 2 };
      const r = renderMosaic(frames.map((t) => referenceSubframe(t, CODEC.COLOR_8)), TM_PALETTE, columns, options);
      const p = renderMosaic(frames.map((t) => payloadSubframe(t, CODEC.COLOR_8)), TM_PALETTE, columns, options);
      const imgR = degradeImage(r, { ...CHANNEL, seed: 1 });
      const imgP = degradeImage(p, { ...CHANNEL, seed: 2 });
      const locsR = locateAll(imgR, TM_ALIGNMENT);
      expect(locsR.length).toBe(n);
      const t0 = performance.now();
      const locsP = locateAll(imgP, TM_ALIGNMENT);
      const elapsed = performance.now() - t0;
      expect(locsP.length).toBe(n);
      expect(elapsed).toBeLessThan(bound);
      const receiver = new TmMosaicReceiver();
      receiver.process(imgR, locsR, 0);
      const decoded = receiver.process(imgP, locsP, 250).map((x) => x.frame?.bytes).filter((o): o is Uint8Array => !!o);
      expect(decoded.length).toBe(n);
      frames.forEach((t, i) => expect(Array.from(decoded[i]!.subarray(0, t.length))).toEqual(Array.from(t)));
    }, 60000);
  }
});
