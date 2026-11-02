import { describe, expect, it } from "vitest";

import { FountainDecoder, fountainSymbol, ltNeighbors, mulberry32 } from "../src/index.ts";
import { SYMBOL_SIZE } from "../src/index.ts";

function randomSources(k: number): Uint8Array[] {
  const rng = mulberry32(1234);
  return Array.from({ length: k }, () => Uint8Array.from({ length: SYMBOL_SIZE }, () => Math.floor(rng() * 256)));
}

describe("LT neighbors", () => {
  it("are deterministic and distinct", () => {
    const a = ltNeighbors(64, 777);
    const b = ltNeighbors(64, 777);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(new Set(a).size).toBe(a.length);
    for (const v of a) expect(v).toBeLessThan(64);
  });
});

describe("fountain code", () => {
  it("rebuilds K symbols with a moderate overhead and losses", () => {
    const k = 128;
    const sources = randomSources(k);
    const decoder = new FountainDecoder(k);
    // 1.7 × K symbols sent, 15 % lost, shuffled order — seeded RNG: deterministic test.
    const sort = mulberry32(99);
    const sent: { seed: number; symbol: Uint8Array }[] = [];
    for (let i = 0; i < Math.ceil(k * 1.7); i++) sent.push({ seed: i + 1, symbol: fountainSymbol(sources, k, i + 1) });
    const kept = sent.filter(() => sort() > 0.15);
    for (let i = kept.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [kept[i], kept[j]] = [kept[j]!, kept[i]!];
    }
    for (const { seed, symbol } of kept) decoder.receive(seed, symbol);
    expect(decoder.complete).toBe(true);
    const reconstructed = decoder.reconstruct();
    expect(reconstructed.map((s) => Array.from(s))).toEqual(sources.map((s) => Array.from(s)));
  });

  it("ignores replayed seeds", () => {
    const k = 8;
    const sources = randomSources(k);
    const decoder = new FountainDecoder(k);
    const s = fountainSymbol(sources, k, 1);
    decoder.receive(1, s);
    expect(decoder.receivedSymbols).toBe(1);
    expect(decoder.receive(1, s)).toBe(false); // replay ignored
    expect(decoder.receivedSymbols).toBe(1);
  });

  it("rejects a symbol of unexpected size", () => {
    const decoder = new FountainDecoder(8);
    expect(() => decoder.receive(1, new Uint8Array(10))).toThrow();
  });
});
