/**
 * Optical encoder: ORP frames (bytes) → grid of palette indices, and the
 * calibration test pattern. The bit layout is frozen (docs §9): MSB first,
 * data modules in DATA_MODULES order, bits per module according to the
 * codec. The padding beyond the frame is index 0.
 */

import { CODEC as OPTICAL_CODEC, buildFrame, Codec, FrameHeader, SYMBOL_SIZE, FLAG } from "@optirelay/core";
import { SYMBOL_CAPACITY } from "@optirelay/core";
import { mulberry32 } from "@optirelay/core";
import { structuralGrid, DATA_MODULES, GRID_SIZE, roleOf } from "./grid.ts";
import { bitsPerModule, paletteOf } from "./palettes.ts";

export type Grid = Uint8Array; // GRID_SIZE² palette indices

/** Writes a byte stream into the data modules (MSB first). */
export function writeBytesToGrid(grid: Grid, bytes: Uint8Array, codec: Codec): Grid {
  const bits = bitsPerModule(codec);
  let bitsLeft = 0;
  let currentByte = 0;
  for (const [x, y] of DATA_MODULES) {
    let index = 0;
    for (let b = 0; b < bits; b++) {
      if (bitsLeft === 0) {
        currentByte = bytes.length > 0 ? bytes[0]! : 0;
        bytes = bytes.subarray(1);
        bitsLeft = 8;
      }
      index = (index << 1) | ((currentByte >> (bitsLeft - 1)) & 1);
      bitsLeft--;
    }
    grid[y * GRID_SIZE + x] = index;
  }
  return grid;
}

/** Assembles the full grid of a data frame. */
export function encodeFrame(header: FrameHeader, payload: Uint8Array, tag?: Uint8Array): Grid {
  const grid = structuralGrid(header.codec);
  const raw = buildFrame(header, payload, tag);
  return writeBytesToGrid(grid, raw, header.codec);
}

/**
 * Encodes an ALREADY built frame (complete bytes, RS parities included —
 * this is what the session emits). The browser adapter contract: every frame
 * produced by the session goes through here, then to the screen renderer.
 */
export function encodeRawFrame(raw: Uint8Array, codec: Codec): Grid {
  const grid = structuralGrid(codec);
  return writeBytesToGrid(grid, raw, codec);
}

/**
 * Calibration test pattern (§5.3): the data zone is filled with a pseudo-
 * random sequence UNIFORM over the palette (fixed v0.1 seed), the pilots
 * carry the colors in order. This is NOT an ORP frame: it is decoded
 * directly by the calibrator, never by the session.
 */
export function encodeTestPattern(codec: Codec, seed = 0x4f525031): Grid {
  const grid = structuralGrid(codec);
  const palette = paletteOf(codec);
  const rng = mulberry32(seed);
  for (const [x, y] of DATA_MODULES) {
    grid[y * GRID_SIZE + x] = Math.floor(rng() * palette.length);
  }
  return grid;
}

/**
 * Pairing code (init or response): dedicated COLOR_4 frame — the 242-byte
 * frame does not fit in the 1423 bits of MONO_2, and both screens of an ORP
 * session can display color (§7 of the protocol). The payload is the pairing
 * serialization of @optirelay/core, padded to a whole number of symbols.
 */
export function encodePairingCode(payload: Uint8Array): Grid {
  const count = Math.max(1, Math.min(4, Math.ceil(payload.length / SYMBOL_SIZE)));
  const paddedPayload = new Uint8Array(count * SYMBOL_SIZE);
  paddedPayload.set(payload.subarray(0, Math.min(payload.length, paddedPayload.length)));
  const header: FrameHeader = {
    version: { major: 0, minor: 1 },
    codec: OPTICAL_CODEC.COLOR_4,
    flags: FLAG.PAIRING,
    token: 0,
    block: 0,
    k: 1,
    symbolCount: count,
    seed: 0,
  };
  const grid = structuralGrid(header.codec);
  const raw = buildFrame(header, paddedPayload);
  return writeBytesToGrid(grid, raw, header.codec);
}

/** Prepares a data frame ready to encode: caps nb_symboles to the codec capacity. */
export function frameForCodec(header: Omit<FrameHeader, "nbSymboles">, payload: Uint8Array, tag?: Uint8Array): { header: FrameHeader; payload: Uint8Array; tag?: Uint8Array } {
  const max = SYMBOL_CAPACITY[header.codec] ?? 1;
  const symbolCount = Math.min(max, Math.ceil(payload.length / SYMBOL_SIZE));
  const paddedPayload = new Uint8Array(symbolCount * SYMBOL_SIZE);
  paddedPayload.set(payload.subarray(0, Math.min(payload.length, paddedPayload.length)));
  return {
    header: { ...header, symbolCount },
    payload: paddedPayload,
    ...(tag ? { tag } : {}),
  };
}

export { GRID_SIZE, roleOf };
