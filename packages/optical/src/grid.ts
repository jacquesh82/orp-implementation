/**
 * Geometry of the ORP v0.1 grid — frozen by docs/orp-protocol-v0.1.md §9.
 *
 * N=41 modules per side. The structure is PURE BLACK AND WHITE (§5.1: the
 * structural data stay robust in luminance even when the chrominance
 * degrades): three 7×7 finder patterns in the top-left, top-right and
 * bottom-left corners, white separators, alternating timing lines (row 6,
 * column 6), and a ring of color pilots — the 8 palette colors in a fixed
 * order, twice — which anchors the calibration and makes it possible to
 * estimate the channel drift frame by frame.
 */

import { CODEC, Codec } from "@optirelay/core";
import { paletteOf } from "./palettes.ts";

export const GRID_SIZE = 41;
export const FINDER_SIZE = 7;
/** Centers of the three finder patterns (module coordinates). */
export const FINDERS: readonly (readonly [number, number])[] = [
  [3, 3],
  [GRID_SIZE - 4, 3],
  [3, GRID_SIZE - 4],
];

export type ModuleRole = "finder" | "separator" | "timing" | "pilot" | "data";

const roles: ModuleRole[] = (() => {
  const r = new Array<ModuleRole>(GRID_SIZE * GRID_SIZE).fill("data");
  const mark = (x: number, y: number, role: ModuleRole) => {
    r[y * GRID_SIZE + x] = role;
  };
  // Finder patterns + white separators (9×9 ring around each 7×7).
  for (const [cx, cy] of FINDERS) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) continue;
        const inFinder = Math.abs(dx) <= 3 && Math.abs(dy) <= 3;
        mark(x, y, inFinder ? "finder" : "separator");
      }
    }
  }
  // Timing lines (row 6 and column 6), outside the structural zones.
  for (let i = 8; i < GRID_SIZE - 8; i++) {
    if (r[6 * GRID_SIZE + i] === "data") mark(i, 6, "timing");
    if (r[i * GRID_SIZE + 6] === "data") mark(6, i, "timing");
  }
  // Pilot ring: 8 modules at the bottom (y = N−1, x = 8..15) and 8 on the right
  // (x = N−1, y = 8..15), one per palette color, in index order.
  for (let i = 0; i < 8; i++) {
    mark(8 + i, GRID_SIZE - 1, "pilot");
    mark(GRID_SIZE - 1, 8 + i, "pilot");
  }
  return r;
})();

export function roleOf(x: number, y: number): ModuleRole {
  return roles[y * GRID_SIZE + x]!;
}

/** Filling order of the data modules: row by row, top → bottom. */
export const DATA_MODULES: readonly (readonly [number, number])[] = (() => {
  const list: [number, number][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (roles[y * GRID_SIZE + x] === "data") list.push([x, y]);
    }
  }
  return list;
})();

/** Number of data modules of the v0.1 grid. */
export const DATA_MODULE_COUNT = DATA_MODULES.length;
/** Raw bits available per codec — the protocol capacity table derives from it. */
export function availableBits(codec: Codec): number {
  return DATA_MODULE_COUNT * localBitsPerModule(codec);
}
function localBitsPerModule(codec: Codec): number {
  switch (codec) {
    case CODEC.MONO_2:
      return 1;
    case CODEC.COLOR_4:
      return 2;
    case CODEC.COLOR_8:
      return 3;
  }
}

/**
 * Palette indices of the STRUCTURAL modules of the grid (finders,
 * separators, timing, pilots) — identical for every codec. The pilots carry
 * the palette colors in index order (alternating black/white for MONO_2).
 */
export function structuralGrid(codec: Codec): Uint8Array {
  const g = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const palette = paletteOf(codec);
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const role = roleOf(x, y);
      const i = y * GRID_SIZE + x;
      switch (role) {
        case "finder": {
          const [cx, cy] = FINDERS.find(([mx, my]) => Math.abs(mx - x) <= 3 && Math.abs(my - y) <= 3)!;
          const dx = Math.abs(cx - x);
          const dy = Math.abs(cy - y);
          const ring = Math.max(dx, dy);
          g[i] = ring === 3 || ring <= 1 ? 0 : 1; // black ring, black 3×3 core, white gap
          break;
        }
        case "separator":
          g[i] = 1; // white
          break;
        case "timing":
          g[i] = (x + y) % 2 === 0 ? 0 : 1; // alternating black/white
          break;
        case "pilot": {
          // Rank of the pilot in the ring (0..7) → color of index rank % palette size.
          const rank = x === GRID_SIZE - 1 ? y - 8 : x - 8;
          g[i] = rank % palette.length;
          break;
        }
        default:
          g[i] = 0;
      }
    }
  }
  return g;
}
