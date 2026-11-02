/**
 * Reed-Solomon over GF(256) — primitive polynomial 0x11D, α = 2, consecutive
 * roots starting at α⁰, 8 parity bytes (corrects ≤ 4 errors per frame).
 * Systematic encoding by synthetic division: the message length is free,
 * the "shortened" code is implicit.
 *
 * This is the INTRA-frame correction of §5.4 of the requirements, on top of
 * the fountain codes that recover entirely lost frames.
 */

import { OrpUncorrectable } from "./errors.ts";

/** Parity bytes per segment — a code parameter, lives HERE to avoid the rs ↔ frames cycle. */
export const RS_PARITY = 8;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}
function div(a: number, b: number): number {
  if (a === 0) return 0;
  if (b === 0) throw new OrpUncorrectable();
  return EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!;
}
/** Evaluates Σ poly[k]·x^k — constant term first (BM locator convention). */
function evalConstantFirst(poly: number[], x: number): number {
  let y = 0;
  for (let k = poly.length - 1; k >= 0; k--) y = mul(y, x) ^ poly[k]!;
  return y;
}

/** Generator polynomial g(x) = ∏ (x − α^i), i = 0..7 — leading coefficient first. */
const GENERATOR = (() => {
  // (x + α^i)·g, as a leading-first array: x·g shifts towards the HIGHER
  // degrees (index 0), a·g keeps the indices.
  let g: number[] = [1];
  for (let i = 0; i < RS_PARITY; i++) {
    const a = EXP[i]!;
    const next = new Array<number>(g.length + 1).fill(0);
    for (let k = 0; k < next.length; k++) {
      const fromX = k < g.length ? g[k]! : 0;          // x·g — one degree up
      const fromA = k > 0 ? mul(a, g[k - 1]!) : 0;     // a·g — same degree
      next[k] = fromX ^ fromA;
    }
    g = next;
  }
  return g;
})();

/** Systematic 8-byte parity of the message (free length). */
export function rsParity(message: Uint8Array): Uint8Array {
  const parity = new Uint8Array(RS_PARITY);
  for (let i = 0; i < message.length; i++) {
    const factor = message[i]! ^ parity[0]!;
    parity.copyWithin(0, 1);
    parity[RS_PARITY - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < RS_PARITY; j++) {
        parity[j] = parity[j]! ^ mul(GENERATOR[j + 1]!, factor);
      }
    }
  }
  return parity;
}

/** Appends the parity to the message: frame ready for the optical channel. */
export function protect(message: Uint8Array): Uint8Array {
  const t = new Uint8Array(message.length + RS_PARITY);
  t.set(message, 0);
  t.set(rsParity(message), message.length);
  return t;
}

interface Syndromes {
  nonZero: boolean;
  syndromes: number[];
}

function syndromes(t: Uint8Array): Syndromes {
  const s: number[] = [];
  let nonZero = false;
  for (let j = 0; j < RS_PARITY; j++) {
    let v = 0;
    for (let i = 0; i < t.length; i++) v = mul(v, EXP[j]!) ^ t[i]!;
    s.push(v);
    if (v !== 0) nonZero = true;
  }
  return { nonZero, syndromes: s };
}

/** Error locator by Berlekamp-Massey. */
function errorLocator(synd: number[]): number[] {
  let loc: number[] = [1];
  let prev: number[] = [1];
  let l = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < synd.length; n++) {
    let delta = synd[n]!;
    for (let i = 1; i <= l; i++) delta ^= mul(loc[i] ?? 0, synd[n - i] ?? 0);
    if (delta === 0) {
      m++;
      continue;
    }
    const coef = div(delta, b);
    const shifted = new Array<number>(m).fill(0).concat(prev);
    const next = new Array<number>(Math.max(loc.length, shifted.length)).fill(0);
    for (let i = 0; i < next.length; i++) next[i] = (loc[i] ?? 0) ^ mul(coef, shifted[i] ?? 0);
    if (2 * l <= n) {
      prev = loc;
      loc = next;
      b = delta;
      l = n + 1 - l;
      m = 1;
    } else {
      loc = next;
      m++;
    }
  }
  while (loc.length > 1 && loc[loc.length - 1] === 0) loc.pop();
  return loc;
}

/**
 * Corrects the frame in place. Throws OrpUncorrectable if more than 4 bytes
 * are wrong (the frame is lost — it becomes an erasure for the fountain
 * decoder, never a silent corruption, §10.2-4).
 */
export function rsCorrect(t: Uint8Array): void {
  const s = syndromes(t);
  if (!s.nonZero) return;
  const loc = errorLocator(s.syndromes);
  const degree = loc.length - 1;
  if (degree === 0 || degree > RS_PARITY / 2) throw new OrpUncorrectable();
  // Chien search: position i (0 = first byte) carries the term x^(N-1-i),
  // its locator is X_i = α^(N-1-i); it is in error ⇔ σ(X_i^-1) = 0.
  const n = t.length;
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    const exponent = (n - 1 - i) % 255;
    if (evalConstantFirst(loc, EXP[(255 - exponent) % 255]!) === 0) positions.push(i);
  }
  if (positions.length !== degree) throw new OrpUncorrectable();
  // Error evaluator Ω(x) = (S(x)·σ(x)) mod x^8.
  const omega = new Array<number>(RS_PARITY).fill(0);
  for (let i = 0; i < loc.length; i++) {
    for (let j = 0; j < RS_PARITY; j++) {
      if (i + j < RS_PARITY) omega[i + j] = omega[i + j]! ^ mul(loc[i]!, s.syndromes[j]!);
    }
  }
  for (const i of positions) {
    const exponent = (n - 1 - i) % 255;
    const xInv = EXP[(255 - exponent) % 255]!; // X_i^-1 = α^-(N-1-i)
    // Y_i = X_i·Ω(X_i^-1) / Λ'(X_i^-1), where Λ'(x) = Σ_{k odd} Λ_k·x^(k-1).
    let num = 0;
    let p = 1;
    for (let k = 0; k < omega.length; k++) {
      num ^= mul(omega[k]!, p);
      p = mul(p, xInv);
    }
    num = mul(num, EXP[exponent]!); // factor X_i^(1-fcr), fcr = 0
    let den = 0;
    p = 1; // xInv^(k-1): 1, then xInv² at every second step
    const xInvSquared = mul(xInv, xInv);
    for (let k = 1; k < loc.length; k += 2) {
      den ^= mul(loc[k]!, p);
      p = mul(p, xInvSquared);
    }
    if (den === 0) throw new OrpUncorrectable();
    t[i] = t[i]! ^ div(num, den);
  }
  // Check: the syndromes must be back to zero, otherwise give up.
  if (syndromes(t).nonZero) throw new OrpUncorrectable();
}
