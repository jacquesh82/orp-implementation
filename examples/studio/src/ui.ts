/** Small DOM and formatting helpers shared by the three views. */
import type { ImageRGBA } from "@optirelay/optical";
import { locale } from "./i18n";

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Élément introuvable : ${selector}`);
  return el as T;
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(selector)] as T[];
}

/** Draws an RGBA buffer of @optirelay/optical onto a canvas (resized to the image). */
export function paint(canvas: HTMLCanvasElement, img: ImageRGBA): CanvasRenderingContext2D {
  if (canvas.width !== img.width) canvas.width = img.width;
  if (canvas.height !== img.height) canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return ctx;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Unambiguous alphabet (no 0/O, 1/I/L): 31 symbols, 12 characters ≈ 59 bits. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 12;

/** Uniform random code (rejection sampling). */
export function randomCode(): string {
  let code = "";
  const limit = 256 - (256 % ALPHABET.length);
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && code.length < CODE_LENGTH) code += ALPHABET[b % ALPHABET.length];
    }
  }
  return code;
}

export const shownCode = (code: string) => code.match(/.{1,4}/g)!.join("-");
export const normalizedCode = (typed: string) => typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const sasText = (sas: string) => `${sas.slice(0, 3)} ${sas.slice(3)}`;

export const fmt = (n: number, digits = 0) =>
  n.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function hex(bytes: Uint8Array, max = 8): string {
  return [...bytes.subarray(0, max)].map((b) => b.toString(16).padStart(2, "0")).join(" ") + (bytes.length > max ? " …" : "");
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Small deterministic PRNG for the simulated channel (reproducible runs). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generated test image (PNG) — shows the receiver's preview at the end of a transfer. */
export async function sampleImage(): Promise<{ name: string; type: string; data: Uint8Array }> {
  const c = document.createElement("canvas");
  c.width = c.height = 120;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 120, 120);
  g.addColorStop(0, "#00e5d4");
  g.addColorStop(0.5, "#ff3d9a");
  g.addColorStop(1, "#ffd23f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 120, 120);
  ctx.fillStyle = "rgba(10,12,18,.85)";
  for (const [x, y] of [[8, 8], [84, 8], [8, 84]]) {
    ctx.fillRect(x, y, 28, 28);
    ctx.clearRect(x + 4, y + 4, 20, 20);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + 4, y + 4, 20, 20);
    ctx.fillStyle = "rgba(10,12,18,.85)";
    ctx.fillRect(x + 8, y + 8, 12, 12);
  }
  ctx.font = "bold 22px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("ORP", 60, 68);
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(new Date().toLocaleTimeString(locale()), 60, 104);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
  return { name: "optirelay-test.png", type: "image/png", data: new Uint8Array(await blob.arrayBuffer()) };
}
