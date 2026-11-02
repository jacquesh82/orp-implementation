import { describe, expect, it } from "vitest";

import {
  buildFrame,
  readFrame,
  frameSize,
  META_SIZE,
  CODEC,
  SYMBOL_CAPACITY,
  FLAG,
  FrameHeader,
  SYMBOL_SIZE,
  FRAME_VERSION,
  crc32,
  rsParity,
  rsCorrect,
  OrpCorruptedFrame,
  OrpInvalidFrame,
} from "../src/index.ts";

function makeHeader(partial: Partial<FrameHeader> = {}): FrameHeader {
  return {
    version: FRAME_VERSION,
    codec: CODEC.COLOR_4,
    flags: 0,
    token: 0x12345678,
    block: 3,
    k: 100,
    symbolCount: 2,
    seed: 42,
    ...partial,
  };
}

describe("CRC-32", () => {
  it("reproduces the IEEE reference vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("full frame (tripled meta + RS segments)", () => {
  it("builds and reads back, with and without encryption", () => {
    for (const encrypted of [false, true]) {
      const payload = new Uint8Array(2 * SYMBOL_SIZE).map((_, i) => (i * 7) & 0xff);
      const tag = encrypted ? new Uint8Array(16).fill(0xaa) : undefined;
      const raw = buildFrame(makeHeader({ flags: encrypted ? FLAG.ENCRYPTED : 0 }), payload, tag);
      expect(raw.length).toBe(frameSize(2, encrypted));
      const decoded = readFrame(raw);
      expect(decoded.header.token).toBe(0x12345678);
      expect(decoded.header.block).toBe(3);
      expect(decoded.header.k).toBe(100);
      expect(decoded.header.seed).toBe(42);
      expect(decoded.payload).toEqual(payload);
      if (encrypted) expect(decoded.tag).toEqual(tag);
      else expect(decoded.tag).toBeUndefined();
    }
  });

  it("tolerates the grid padding: bytes beyond the frame are ignored", () => {
    const payload = new Uint8Array(SYMBOL_SIZE);
    const raw = buildFrame(makeHeader({ symbolCount: 1 }), payload);
    const padded = new Uint8Array(raw.length + 20); // zeros
    padded.set(raw, 0);
    const decoded = readFrame(padded);
    expect(decoded.header.token).toBe(0x12345678);
  });

  it("survives the corruption of ONE meta copy (majority vote)", () => {
    const payload = new Uint8Array(SYMBOL_SIZE);
    const raw = buildFrame(makeHeader({ symbolCount: 1 }), payload);
    for (const copy of [0, 1, 2]) {
      const damaged = raw.slice();
      damaged[copy * META_SIZE + 1] = 0xff; // a single damaged copy
      expect(readFrame(damaged).header.token).toBe(0x12345678);
    }
  });

  it("rejects an undecidable meta (3 diverging copies)", () => {
    const payload = new Uint8Array(SYMBOL_SIZE);
    const raw = buildFrame(makeHeader({ symbolCount: 1 }), payload);
    const broken = raw.slice();
    broken[1] = 0x11;
    broken[META_SIZE + 1] = 0x22;
    broken[2 * META_SIZE + 1] = 0x33;
    expect(() => readFrame(broken)).toThrow(OrpInvalidFrame);
  });

  it("corrects up to 4 errors PER SEGMENT and detects beyond", () => {
    const payload = new Uint8Array(4 * SYMBOL_SIZE).map((_, i) => (i * 11) & 0xff);
    const raw = buildFrame(makeHeader({ symbolCount: 4, flags: FLAG.ENCRYPTED }), payload, new Uint8Array(16));
    // 4 errors in the first segment: corrected.
    const damaged = raw.slice();
    for (let i = 0; i < 4; i++) damaged[24 + i] = damaged[24 + i]! ^ 0x5a;
    expect(readFrame(damaged).payload).toEqual(payload);
    // 5 errors in the first segment: frame lost, never corrupted.
    const broken = raw.slice();
    for (let i = 0; i < 5; i++) broken[24 + i * 30] = broken[24 + i * 30]! ^ 0x5a;
    expect(() => readFrame(broken)).toThrow(OrpCorruptedFrame);
  });

  it("rejects out-of-range magic, codec and flags", () => {
    const payload = new Uint8Array(SYMBOL_SIZE);
    const magic = buildFrame(makeHeader({ symbolCount: 1 }), payload);
    magic[0] = 0;
    magic[META_SIZE] = 0;
    magic[2 * META_SIZE] = 0;
    expect(() => readFrame(magic)).toThrow(/magic/);
    const codec = buildFrame(makeHeader({ symbolCount: 1, codec: 0x07 as never }), payload);
    expect(() => readFrame(codec)).toThrow(/codec/);
    expect(() => buildFrame(makeHeader({ symbolCount: 1, flags: 0x80 }), payload)).toThrow(/flag/);
  });

  it("rejects a truncated frame", () => {
    const payload = new Uint8Array(SYMBOL_SIZE);
    const raw = buildFrame(makeHeader({ symbolCount: 1 }), payload);
    expect(() => readFrame(raw.subarray(0, raw.length - 1))).toThrow();
  });

  it("rejects an ENCRYPTED flag without a tag", () => {
    const payload = new Uint8Array(SYMBOL_SIZE);
    expect(() => buildFrame(makeHeader({ flags: FLAG.ENCRYPTED }), payload)).toThrow(/tag/);
  });

  it("covers the frozen capacity table (N = 41)", () => {
    expect(SYMBOL_CAPACITY[CODEC.MONO_2]).toBe(1);
    expect(SYMBOL_CAPACITY[CODEC.COLOR_4]).toBe(2);
    expect(SYMBOL_CAPACITY[CODEC.COLOR_8]).toBe(4);
  });

  it("fits each (encrypted) capacity in the v0.1 optical grid (1423 data modules)", () => {
    // Capacity in BITS of the N=41 grid: 1423 modules × bits/module of the codec.
    const BITS_PER_CODEC: Record<number, number> = {
      [CODEC.MONO_2]: 1423,
      [CODEC.COLOR_4]: 2 * 1423,
      [CODEC.COLOR_8]: 3 * 1423,
    };
    for (const [codec, max] of Object.entries(SYMBOL_CAPACITY)) {
      expect(frameSize(max, true) * 8).toBeLessThanOrEqual(BITS_PER_CODEC[Number(codec)]!);
    }
  });
});

describe("Reed-Solomon (segment ≤ 255 B)", () => {
  it("corrects up to 4 byte errors, detects beyond", () => {
    const message = new Uint8Array(247).map((_, i) => (i * 31 + 5) & 0xff);
    const encoded = new Uint8Array(message.length + 8);
    encoded.set(message, 0);
    encoded.set(rsParity(message), message.length);

    for (const errorCount of [1, 2, 3, 4]) {
      const damaged = encoded.slice();
      const positions = new Set<number>();
      while (positions.size < errorCount) positions.add(Math.floor(Math.random() * damaged.length));
      for (const p of positions) damaged[p] = (damaged[p]! ^ 0x5a) & 0xff;
      rsCorrect(damaged);
      expect(Array.from(damaged)).toEqual(Array.from(encoded));
    }

    const broken = encoded.slice();
    for (let i = 0; i < 6; i++) broken[i * 40] = (broken[i * 40]! ^ 0x5a) & 0xff;
    expect(() => rsCorrect(broken)).toThrow();
  });

  it("returns a deterministic parity", () => {
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    expect(rsParity(message)).toEqual(rsParity(message));
  });
});
