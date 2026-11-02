import { describe, expect, it } from "vitest";

import { planBlocks, blockCount, kTotal, blockSymbols, assemble } from "../src/index.ts";
import { SYMBOL_SIZE, K_MAX } from "../src/index.ts";

describe("block planning", () => {
  it("handles the edges: empty stream, less than one symbol, exactly one symbol, exactly K_MAX", () => {
    expect(planBlocks(new Uint8Array(0)).symbols).toHaveLength(0);

    const one = planBlocks(new Uint8Array(1));
    expect(blockCount(one)).toBe(1);
    expect(one.kPerBlock).toEqual([1]);
    expect(one.symbols[0]).toHaveLength(SYMBOL_SIZE);
    expect(assemble(one.symbols, 1)).toEqual(new Uint8Array(1));

    const exact = planBlocks(new Uint8Array(SYMBOL_SIZE));
    expect(exact.kPerBlock).toEqual([1]);

    const justUnder = planBlocks(new Uint8Array(SYMBOL_SIZE - 1));
    expect(justUnder.kPerBlock).toEqual([1]);

    const full = planBlocks(new Uint8Array(K_MAX * SYMBOL_SIZE));
    expect(blockCount(full)).toBe(1);
    expect(full.kPerBlock).toEqual([K_MAX]);

    const fullPlusOne = planBlocks(new Uint8Array(K_MAX * SYMBOL_SIZE + 1));
    expect(blockCount(fullPlusOne)).toBe(2);
    expect(fullPlusOne.kPerBlock).toEqual([K_MAX, 1]);
  });

  it("splits 100 KB into two blocks and reassembles it identically", () => {
    const stream = new Uint8Array(100_000).map((_, i) => (i * 13 + 7) & 0xff);
    const plan = planBlocks(stream);
    expect(blockCount(plan)).toBe(2);
    expect(kTotal(plan)).toBe(Math.ceil(100_000 / SYMBOL_SIZE));
    // Symbols of block 0: the first SYMBOL_SIZE bytes of the stream.
    expect(blockSymbols(plan, 0)[0]!.subarray(0, 8)).toEqual(stream.subarray(0, 8));
    const reassembled = assemble(plan.symbols, plan.streamSize);
    expect(reassembled).toEqual(stream);
  });

  it("preserves the real size against the padding of the last symbol", () => {
    const stream = new Uint8Array(SYMBOL_SIZE + 10).fill(0xab);
    const plan = planBlocks(stream);
    const reassembled = assemble(plan.symbols, plan.streamSize);
    expect(reassembled).toHaveLength(SYMBOL_SIZE + 10);
    expect(reassembled).toEqual(stream);
  });

  it("rejects an out-of-range block", () => {
    const plan = planBlocks(new Uint8Array(10));
    expect(() => blockSymbols(plan, 5)).toThrow();
  });
});
