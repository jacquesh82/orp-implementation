/**
 * Nominal palettes of the ORP-C8 codecs (§5.1, D-008) — starting sRGB
 * values, never decoding classes: the calibration (OPTI-04) estimates the
 * TRUE classes from the test pattern captured by the camera.
 *
 * Design principles: well separated luminances for the structure
 * (black/white of the finder patterns), maximal chrominances for the 8 data
 * classes. The exact values will be validated on real hardware (REC-04) —
 * the specification only freezes the SEMANTICS of the indices here.
 */

import { CODEC, Codec } from "@optirelay/core";

export type RgbColor = readonly [number, number, number];

export const BLACK: RgbColor = [0, 0, 0];
export const WHITE: RgbColor = [255, 255, 255];

/** Nominal palettes per codec — the index IS the value of the module bits. */
export const NOMINAL_PALETTES: Record<number, readonly RgbColor[]> = {
  [CODEC.MONO_2]: [BLACK, WHITE],
  [CODEC.COLOR_4]: [
    [0, 0, 0], // 00 — noir
    [255, 255, 255], // 01 — blanc
    [229, 57, 53], // 10 — rouge
    [30, 136, 229], // 11 — bleu
  ],
  [CODEC.COLOR_8]: [
    [0, 0, 0], // 000 — noir
    [255, 255, 255], // 001 — blanc
    [229, 57, 53], // 010 — rouge
    [30, 136, 229], // 011 — bleu
    [253, 216, 53], // 100 — jaune
    [67, 160, 71], // 101 — vert
    [142, 36, 170], // 110 — magenta
    [0, 172, 193], // 111 — cyan
  ],
};

export function paletteOf(codec: Codec): readonly RgbColor[] {
  const p = NOMINAL_PALETTES[codec];
  if (!p) throw new Error(`optical: unknown codec 0x${codec.toString(16)}`);
  return p;
}

/** Bits per data module (§5.5): 1, 2 or 3. */
export function bitsPerModule(codec: Codec): 1 | 2 | 3 {
  switch (codec) {
    case CODEC.MONO_2:
      return 1;
    case CODEC.COLOR_4:
      return 2;
    case CODEC.COLOR_8:
      return 3;
  }
}
