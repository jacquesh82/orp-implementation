/**
 * Files and transfer metrics on the application side (BROW):
 *
 *   - ENVELOPE: the ORP protocol carries BYTES, not a file name. The name
 *     and MIME type are packed with the data so that the receiver offers the
 *     right file — without touching the protocol format.
 *       "ORF1" · u16 name length · UTF-8 name · u16 type length · type · data
 *   - SAVING: download link, or native bridge of the Android app (a WebView
 *     does not follow a blob: "download" link).
 *   - TRACKING: progress, useful throughput and remaining time of a reception.
 */

import { SYMBOL_SIZE } from "@optirelay/core";

const MAGIC = [0x4f, 0x52, 0x46, 0x31]; // "ORF1"

export interface TransferredFile {
  name: string;
  type: string;
  data: Uint8Array;
}

export function pack({ name, type, data }: TransferredFile): Uint8Array {
  const enc = new TextEncoder();
  const n = enc.encode(name.slice(0, 200));
  const t = enc.encode((type || "application/octet-stream").slice(0, 100));
  const output = new Uint8Array(4 + 2 + n.length + 2 + t.length + data.length);
  const view = new DataView(output.buffer);
  output.set(MAGIC, 0);
  view.setUint16(4, n.length);
  output.set(n, 6);
  view.setUint16(6 + n.length, t.length);
  output.set(t, 8 + n.length);
  output.set(data, 8 + n.length + t.length);
  return output;
}

export function unpack(bytes: Uint8Array): TransferredFile {
  const fallback = { name: "optirelay-received.bin", type: "application/octet-stream", data: bytes };
  if (bytes.length < 8 || MAGIC.some((m, i) => bytes[i] !== m)) return fallback;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dec = new TextDecoder("utf-8", { fatal: true });
    const ln = view.getUint16(4);
    const name = dec.decode(bytes.subarray(6, 6 + ln));
    const lt = view.getUint16(6 + ln);
    const type = dec.decode(bytes.subarray(8 + ln, 8 + ln + lt));
    // Name offered when saving: never a path nor a control character.
    const safeName = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || fallback.name;
    return { name: safeName, type: type || fallback.type, data: bytes.subarray(8 + ln + lt) };
  } catch {
    return fallback;
  }
}

export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}

export function readableThroughput(bytesPerSecond: number): string {
  return `${readableSize(bytesPerSecond)}/s`;
}

export function readableDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

interface AndroidBridge {
  save(name: string, type: string, base64: string): boolean;
}

export interface SaveResult {
  ok: boolean;
  /** Message to SHOW to the user (not only to log). */
  message: string;
}

/** Saves a file: native Android bridge if there is one, otherwise a browser download. */
export function saveFile(file: TransferredFile): SaveResult {
  const bridge = (globalThis as { OptiRelayAndroid?: AndroidBridge }).OptiRelayAndroid;
  if (bridge) {
    let binary = "";
    for (let i = 0; i < file.data.length; i += 0x8000) {
      binary += String.fromCharCode(...file.data.subarray(i, i + 0x8000));
    }
    const ok = bridge.save(file.name, file.type, btoa(binary));
    return ok
      ? { ok, message: `Saved to Downloads: ${file.name}` }
      : { ok, message: "The device refused to save the file." };
  }
  const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { ok: true, message: `Download started: ${file.name}` };
}

export interface TransferStatus {
  /** Progress 0..1 (capped at 0.99 until the reconstruction is done). */
  progress: number;
  /** Useful bytes already covered (estimate). */
  usefulBytes: number;
  /** Total useful size announced. */
  totalBytes: number;
  /** Mean useful throughput (bytes/s) since the first data frame. */
  throughput: number;
  /** Estimated remaining time (s), Infinity if unknown. */
  remaining: number;
  /** Elapsed time (s). */
  elapsed: number;
}

/**
 * Tracking of a reception: the fountain returns the file once ~k useful
 * symbols have arrived; progress is receivedSymbols / kTotal, the throughput
 * is relative to the useful size announced by the init code.
 */
export class TransferTracker {
  private startTime: number | null = null;

  constructor(private readonly totalBytes: number, private readonly kTotal: number) {}

  /** To call at the first accepted data frame. */
  start(t = performance.now()): void {
    if (this.startTime === null) this.startTime = t;
  }

  state(receivedSymbols: number, done = false, t = performance.now()): TransferStatus {
    const progress = done ? 1 : Math.min(0.99, receivedSymbols / Math.max(1, this.kTotal));
    const usefulBytes = progress * this.totalBytes;
    const elapsed = this.startTime === null ? 0 : (t - this.startTime) / 1000;
    const throughput = elapsed > 0.2 ? usefulBytes / elapsed : 0;
    const remaining = throughput > 0 ? (this.totalBytes - usefulBytes) / throughput : Infinity;
    return { progress, usefulBytes, totalBytes: this.totalBytes, throughput, remaining, elapsed };
  }
}

/** Sending throughput: useful payload (symbols × SYMBOL_SIZE) displayed per second. */
export class SendThroughput {
  private startTime: number | null = null;
  private bytes = 0;

  frame(raw: Uint8Array, t = performance.now()): void {
    if (this.startTime === null) this.startTime = t;
    this.bytes += (raw[6] ?? 0) * SYMBOL_SIZE; // nb_symboles: meta, byte 6
  }

  get throughput(): number {
    if (this.startTime === null) return 0;
    const elapsed = (performance.now() - this.startTime) / 1000;
    return elapsed < 0.2 ? 0 : this.bytes / elapsed;
  }
}

/**
 * Symbols a sender must have broadcast so that a receiver that loses part of
 * them (transition images, missed grid) has enough to decode: the fountain
 * code needs a little more than K, noticeably more for a small block (LT
 * overhead ≈ 3·√K), plus a 25 % loss margin. Serves as the "filmed enough"
 * mark when the receiver records a video to read it afterwards.
 */
export function suggestedSymbols(kTotal: number, blockCount: number): number {
  const blocks = Math.max(1, blockCount);
  const k = kTotal / blocks;
  return Math.ceil(blocks * (k * 1.25 + 3 * Math.sqrt(k) + 6));
}

/** "To film" progress on the sender side: symbols broadcast / suggested symbols. */
export class FilmingGauge {
  private sent = 0;
  readonly suggested: number;

  constructor(kTotal: number, blockCount: number) {
    this.suggested = suggestedSymbols(kTotal, blockCount);
  }

  /** To call for each data frame broadcast. */
  frame(symbolCount: number): void {
    this.sent += symbolCount;
  }

  /** Data symbols broadcast since the start of the sending. */
  get sentSymbols(): number {
    return this.sent;
  }

  /** 0..1 (capped). */
  get share(): number {
    return Math.min(1, this.sent / this.suggested);
  }

  get enough(): boolean {
    return this.sent >= this.suggested;
  }
}
