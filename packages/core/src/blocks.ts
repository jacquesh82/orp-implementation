/**
 * Splitting of the stream into symbols and blocks (§5 of the protocol):
 * SYMBOL_SIZE bytes per symbol, at most K_MAX symbols per block.
 * The last symbol is zero-padded — the real stream size travels in the
 * init code.
 */

import { K_MAX, SYMBOL_SIZE } from "./frames.ts";

export interface BlockPlan {
  /** Source symbols, in order — the last one is zero-padded. */
  symbols: Uint8Array[];
  /** K of block b (blocks numbered from 0). */
  kPerBlock: number[];
  /** Real stream size (the padding of the last symbol does not count). */
  streamSize: number;
}

export function planBlocks(stream: Uint8Array, symbolSize: number = SYMBOL_SIZE, kMax: number = K_MAX): BlockPlan {
  if (symbolSize < 1) throw new Error("planBlocks: zero symbol size");
  if (kMax < 1 || kMax > K_MAX) throw new Error("planBlocks: K_MAX exceeded");
  const symbolCount = Math.ceil(stream.length / symbolSize);
  const blockCount = Math.ceil(symbolCount / kMax);
  const symbols: Uint8Array[] = [];
  const kPerBlock: number[] = [];
  for (let b = 0; b < blockCount; b++) {
    const start = b * kMax * symbolSize;
    const end = Math.min(start + kMax * symbolSize, stream.length);
    const k = Math.ceil((end - start) / symbolSize);
    kPerBlock.push(k);
    for (let j = 0; j < k; j++) {
      const d = start + j * symbolSize;
      const f = Math.min(d + symbolSize, end);
      const s = new Uint8Array(symbolSize);
      s.set(stream.subarray(d, f));
      symbols.push(s);
    }
  }
  return { symbols, kPerBlock, streamSize: stream.length };
}

export function blockCount(plan: BlockPlan): number {
  return plan.kPerBlock.length;
}

export function kTotal(plan: BlockPlan): number {
  return plan.kPerBlock.reduce((a, b) => a + b, 0);
}

/** Source symbols of block b. */
export function blockSymbols(plan: BlockPlan, block: number, kMax: number = K_MAX): Uint8Array[] {
  if (block < 0 || block >= blockCount(plan)) throw new Error(`planBlocks: block ${block} out of range`);
  const start = block * kMax;
  return plan.symbols.slice(start, start + plan.kPerBlock[block]!);
}

/** Reassembles the symbols into a stream, truncated to the real size. */
export function assemble(symbols: Uint8Array[], streamSize: number): Uint8Array {
  const stream = new Uint8Array(symbols.length * SYMBOL_SIZE);
  let pos = 0;
  for (const s of symbols) {
    stream.set(s, pos);
    pos += SYMBOL_SIZE;
  }
  return stream.subarray(0, Math.min(streamSize, stream.length)).slice();
}
