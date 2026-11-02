/**
 * LT fountain code — recovery of lost frames (F-08, §5.4).
 *
 * The seeds, the degree distribution (robust soliton, c = 0.1, δ = 0.5) and
 * the neighbor draw (partial shuffle) are FROZEN by
 * docs/orp-protocol-v0.1.md: sender and receiver must draw the same
 * neighbors from the same seed.
 */

import { K_MAX, SYMBOL_SIZE } from "./frames.ts";

/** mulberry32 pseudo-random generator — frozen, deterministic, 32 bits. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C_PARAM = 0.1;
const DELTA_PARAM = 0.5;

const CDF_CACHE = new Map<number, Float64Array>();

/** Cumulative distribution function of the robust soliton distribution for K. */
function solitonCdf(k: number): Float64Array {
  const cached = CDF_CACHE.get(k);
  if (cached) return cached;
  const r = Math.max(1, Math.round(C_PARAM * Math.sqrt(k) * Math.log(k / DELTA_PARAM)));
  const mu = new Float64Array(k + 1);
  let z = 0;
  for (let i = 1; i <= k; i++) {
    const rho = i === 1 ? 1 / k : 1 / (i * (i - 1));
    const tau = i < r ? r / (i * k) : i === r ? (r * Math.log(r / DELTA_PARAM)) / k : 0;
    mu[i] = rho + tau;
    z += mu[i]!;
  }
  const cdf = new Float64Array(k + 1);
  let cumulative = 0;
  for (let i = 1; i <= k; i++) {
    cumulative += mu[i]! / z;
    cdf[i] = cumulative;
  }
  cdf[k] = 1;
  CDF_CACHE.set(k, cdf);
  return cdf;
}

function drawDegree(rng: () => number, cdf: Float64Array): number {
  const u = rng();
  for (let i = 1; i < cdf.length; i++) if (u <= cdf[i]!) return i;
  return cdf.length - 1;
}

/**
 * LT neighbors of a seed — frozen partial Fisher-Yates shuffle:
 * d = draw from the robust soliton, then d distinct indices among 0..K−1.
 */
export function ltNeighbors(k: number, seed: number): Uint32Array {
  const rng = mulberry32(seed);
  const d = Math.min(k, drawDegree(rng, solitonCdf(k)));
  const tab = new Uint32Array(k);
  for (let i = 0; i < k; i++) tab[i] = i;
  for (let j = 0; j < d; j++) {
    const r = j + Math.floor(rng() * (k - j));
    const tmp = tab[j]!;
    tab[j] = tab[r]!;
    tab[r] = tmp;
  }
  return tab.subarray(0, d);
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] = target[i]! ^ source[i]!;
}

/** Fountain symbol of a seed: XOR of the selected source symbols. */
export function fountainSymbol(sources: Uint8Array[], k: number, seed: number): Uint8Array {
  if (sources.length !== k) throw new Error(`fountain: ${sources.length} symbols provided, K = ${k}`);
  const neighbors = ltNeighbors(k, seed);
  const s = new Uint8Array(SYMBOL_SIZE);
  for (const i of neighbors) xorInto(s, sources[i]!); // XOR of the neighbors — the very essence of the fountain code
  return s;
}

interface PendingSymbol {
  neighbors: Set<number>;
  data: Uint8Array;
}

/**
 * Fountain decoder of a block of K symbols. Frames arrive in any order,
 * duplicated or lost: only the received combinations count. Reconstruction
 * proceeds by elimination (peeling), kept up to date by an inverted index
 * neighbor → pending symbols: each resolution only visits the symbols it
 * concerns, in cascade.
 *
 * When peeling stalls while there are already at least as many pending
 * equations as unknowns, a Gaussian elimination over GF(2) takes over.
 * For a small K, peeling alone needs ~70 % more symbols; elimination brings
 * this overhead down to a few symbols. Nothing changes on the wire: seeds,
 * degrees and neighbors remain those of the protocol.
 */
export class FountainDecoder {
  readonly k: number;
  private readonly solved: (Uint8Array | undefined)[];
  private readonly seenSeeds = new Set<number>();
  private readonly neighborIndex = new Map<number, Set<PendingSymbol>>();
  /** Equations with at least two unknowns, waiting for peeling or Gauss. */
  private readonly pending = new Set<PendingSymbol>();
  private solvedCount = 0;

  constructor(k: number) {
    if (k < 1 || k > K_MAX) throw new Error(`fountain: K out of range (${k})`);
    this.k = k;
    this.solved = new Array<Uint8Array | undefined>(k);
  }

  get complete(): boolean {
    return this.solvedCount === this.k;
  }

  get receivedSymbols(): number {
    return this.seenSeeds.size;
  }

  /** Receives a fountain symbol; returns true if it made the block progress. */
  receive(seed: number, symbol: Uint8Array): boolean {
    if (symbol.length !== SYMBOL_SIZE) throw new Error("fountain: symbol of unexpected size");
    if (this.seenSeeds.has(seed)) return false;
    this.seenSeeds.add(seed);
    if (this.complete) return false;
    const neighbors = new Set<number>(ltNeighbors(this.k, seed));
    const entry: PendingSymbol = { neighbors, data: symbol.slice() };
    for (const i of [...neighbors]) {
      const alreadySolved = this.solved[i];
      if (alreadySolved) {
        xorInto(entry.data, alreadySolved);
        neighbors.delete(i);
      }
    }
    if (neighbors.size === 1) {
      const i = neighbors.values().next().value as number;
      this.solve(i, entry.data);
      return true;
    }
    if (neighbors.size === 0) return false;
    for (const i of neighbors) {
      let links = this.neighborIndex.get(i);
      if (!links) {
        links = new Set<PendingSymbol>();
        this.neighborIndex.set(i, links);
      }
      links.add(entry);
    }
    this.pending.add(entry);
    // Peeling stalls: enough equations to try Gauss.
    if (this.pending.size >= this.k - this.solvedCount) return this.eliminate();
    return false;
  }

  /**
   * Gauss–Jordan elimination over GF(2) of the pending equations. Returns
   * true if it solved everything; otherwise (insufficient rank) nothing is
   * modified and we wait for more symbols.
   */
  private eliminate(): boolean {
    const unknowns: number[] = [];
    for (let i = 0; i < this.k; i++) if (!this.solved[i]) unknowns.push(i);
    const n = unknowns.length;
    const column = new Map<number, number>(unknowns.map((i, c) => [i, c]));
    const words = Math.ceil(n / 32);
    const rows = [...this.pending].map((a) => {
      const bits = new Uint32Array(words);
      for (const i of a.neighbors) {
        const c = column.get(i)!;
        bits[c >>> 5]! |= 1 << (c & 31);
      }
      return { bits, data: a.data.slice() };
    });
    for (let c = 0; c < n; c++) {
      const word = c >>> 5;
      const mask = 1 << (c & 31);
      let pivot = -1;
      for (let r = c; r < rows.length; r++) {
        if (rows[r]!.bits[word]! & mask) {
          pivot = r;
          break;
        }
      }
      if (pivot < 0) return false; // insufficient rank: more symbols are needed
      [rows[c], rows[pivot]] = [rows[pivot]!, rows[c]!];
      const p = rows[c]!;
      for (let r = 0; r < rows.length; r++) {
        if (r === c) continue;
        const l = rows[r]!;
        if (!(l.bits[word]! & mask)) continue;
        for (let w = 0; w < words; w++) l.bits[w]! ^= p.bits[w]!;
        xorInto(l.data, p.data);
      }
    }
    // Reduced form: row c only contains unknown c.
    for (const a of this.pending) for (const i of a.neighbors) this.neighborIndex.get(i)?.delete(a);
    this.pending.clear();
    for (let c = 0; c < n; c++) this.solve(unknowns[c]!, rows[c]!.data);
    return true;
  }

  /** Solves symbol i, then propagates the elimination in cascade. */
  private solve(i: number, data: Uint8Array): void {
    // Another branch of the cascade may have solved i in the meantime: the
    // redundant combinations are then simply dropped.
    if (this.solved[i]) return;
    this.solved[i] = data;
    this.solvedCount++;
    const links = this.neighborIndex.get(i);
    this.neighborIndex.delete(i);
    if (!links) return;
    for (const entry of [...links]) {
      links.delete(entry);
      xorInto(entry.data, data);
      entry.neighbors.delete(i);
      if (entry.neighbors.size <= 1) this.pending.delete(entry);
      if (entry.neighbors.size === 1) {
        const j = entry.neighbors.values().next().value as number;
        // Unindex the entry BEFORE recursing: otherwise the cascade would traverse
        // the entry itself again and XOR its own buffer down to zero.
        this.neighborIndex.get(j)?.delete(entry);
        entry.neighbors.delete(j);
        this.solve(j, entry.data);
      }
    }
  }

  /** The K source symbols, once the block is complete. */
  reconstruct(): Uint8Array[] {
    if (!this.complete) throw new Error("fountain: incomplete block");
    return this.solved.map((s) => s!);
  }
}
