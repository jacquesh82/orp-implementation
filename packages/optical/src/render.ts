/**
 * Screen and digital image rendering — PURE functions, no DOM (rule 7.1-2:
 * the browser adapter projects them onto Canvas/WebGL; here we produce RGBA
 * buffers that are directly testable and reusable by the camera simulation
 * of the acceptance tests).
 */

import { RgbColor } from "./palettes.ts";
import { GRID_SIZE } from "./grid.ts";
import type { Grid } from "./encoder.ts";

export interface ImageRGBA {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  data: Uint8ClampedArray;
}

export interface RenderOptions {
  /** Pixels per module (default 8). */
  moduleSize?: number;
  /** White modules around the grid (default 2). */
  quietZone?: number;
}

/** Grid → RGBA image (what the screen must show). */
export function render(grid: Grid, palette: readonly RgbColor[], options: RenderOptions = {}): ImageRGBA {
  const moduleSize = options.moduleSize ?? 8;
  const quietZone = options.quietZone ?? 2;
  const border = quietZone * moduleSize;
  const side = GRID_SIZE * moduleSize + 2 * border;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let py = 0; py < side; py++) {
    const my = Math.floor((py - border) / moduleSize);
    for (let px = 0; px < side; px++) {
      const mx = Math.floor((px - border) / moduleSize);
      const inGrid = mx >= 0 && my >= 0 && mx < GRID_SIZE && my < GRID_SIZE;
      const color: RgbColor = inGrid ? palette[grid[my * GRID_SIZE + mx]!]! : [255, 255, 255];
      const o = (py * side + px) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }
  return { width: side, height: side, data };
}

/**
 * Mosaic: several grids side by side, `columns` per row, each with its quiet
 * zone (two neighboring grids are therefore separated by 4 white modules).
 * A cell without a grid stays white.
 */
export function renderMosaic(
  grids: readonly Grid[],
  palette: readonly RgbColor[],
  columns: number,
  options: RenderOptions = {},
): ImageRGBA {
  const tiles = grids.map((g) => render(g, palette, options));
  const side = tiles[0]?.width ?? 0;
  const rows = Math.ceil(grids.length / columns);
  const width = side * columns;
  const height = side * rows;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  tiles.forEach((t, i) => {
    const ox = (i % columns) * side;
    const oy = Math.floor(i / columns) * side;
    for (let y = 0; y < side; y++) {
      data.set(t.data.subarray(y * side * 4, (y + 1) * side * 4), ((oy + y) * width + ox) * 4);
    }
  });
  return { width, height, data };
}
