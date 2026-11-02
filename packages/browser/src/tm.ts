/**
 * TM optical transport in the browser (BROW):
 *
 *   TmDisplay — displays an ORP frame alternating R / P on a canvas, driven
 *               by requestAnimationFrame; in a loop (pairing codes) or for a
 *               number of cycles (data).
 *   TmReader  — reads a <video> frame by frame (requestVideoFrameCallback),
 *               hands it to the pure TmReceiver of @optirelay/optical,
 *               returns the valid frames and the framing state; locks the
 *               white balance + exposure as soon as the grid is stable in view.
 *
 * Plus the pairing frames (init and response codes): a COLOR_4 ORP frame →
 * always displayed in TM4, the most robust mode, for the first contact
 * between two unknown devices.
 */

import { CODEC, Codec, buildFrame, FLAG, readFrame, majorityMeta, INIT_CODE_SIZE, SYMBOL_SIZE, FRAME_VERSION } from "@optirelay/core";
import {
  tmCapacity,
  GRID_SIZE,
  TM_PALETTE,
  TmMosaicReceiver,
  TmReceiver,
  renderMosaic,
  payloadSubframe,
  referenceSubframe,
  type ImageRGBA,
  type TmReceiverOptions,
  type TmImageResult,
} from "@optirelay/optical";
import { lockSensor, type LockState } from "./camera.ts";
import { TmPipeline } from "./tm-pipeline.ts";
import { AdaptiveWidth } from "./adaptive-width.ts";
import type { MessageFromWorker, MessageToWorker } from "./reader-worker.ts";

/**
 * Shared passphrase of the TEST BENCH (pairing §7.2). Public: it proves that
 * we are reading the same transfer, not who is sending. The app tries it on
 * its own against a sender in passphrase mode, so that only one code needs
 * comparing. Its value is a frozen literal.
 */
export const BENCH_PASSPHRASE = "optirelay-banc";

// ── Pairing frames ────────────────────────────────────────────────────────

/**
 * SEND STATE slipped into the frame of the init code: the code (129 bytes)
 * leaves 63 free bytes in its 2-symbol payload. The sender writes its clock,
 * the symbols sent and its "to film" target there; the phone, reading these
 * states in the video, syncs to the SENDER'S TIME — the same clock on both
 * sides (native: orp-transfer, state.rs).
 * Format after the code: "ET" · version 1 · flags · t (i32 ms, negative
 * during the countdown) · symbols sent (u32) · suggested (u32).
 */
export interface SendState {
  /** Sender clock (ms since the first data). */
  t: number;
  sentSymbols: number;
  /** Sender's "to film" target (perfect reading from the start). */
  suggestedSymbols: number;
}

const STATE_SIZE = 16;

/** ORP pairing frame (COLOR_4 → TM4) carrying an init or response code. */
export function pairingFrame(payload: Uint8Array, state?: SendState): Uint8Array {
  const symbolCount = Math.max(1, Math.ceil(payload.length / SYMBOL_SIZE));
  const framePayload = new Uint8Array(symbolCount * SYMBOL_SIZE);
  framePayload.set(payload);
  if (state && payload.length === INIT_CODE_SIZE && framePayload.length >= INIT_CODE_SIZE + STATE_SIZE) {
    const v = new DataView(framePayload.buffer, INIT_CODE_SIZE, STATE_SIZE);
    framePayload.set([0x45, 0x54, 1, state.t < 0 ? 1 : 0], INIT_CODE_SIZE);
    v.setInt32(4, Math.round(state.t));
    v.setUint32(8, state.sentSymbols >>> 0);
    v.setUint32(12, state.suggestedSymbols >>> 0);
  }
  const raw = buildFrame(
    { version: FRAME_VERSION, codec: CODEC.COLOR_4, flags: FLAG.PAIRING, token: 0, block: 0, k: 1, symbolCount, seed: 0 },
    framePayload,
  );
  if (raw.length > tmCapacity(CODEC.COLOR_4)) throw new Error("pairing: code too long for a TM4 frame");
  return raw;
}

/** Send state of an init-code frame, if there is one. */
export function readSendState(bytes: Uint8Array): SendState | null {
  const c = pairingPayload(bytes, INIT_CODE_SIZE + STATE_SIZE);
  if (!c || c.length < INIT_CODE_SIZE + STATE_SIZE) return null;
  if (c[INIT_CODE_SIZE] !== 0x45 || c[INIT_CODE_SIZE + 1] !== 0x54 || c[INIT_CODE_SIZE + 2] !== 1) return null;
  const v = new DataView(c.buffer, c.byteOffset + INIT_CODE_SIZE, STATE_SIZE);
  return { t: v.getInt32(4), sentSymbols: v.getUint32(8), suggestedSymbols: v.getUint32(12) };
}

/** "1:07": a readable clock, like the one the sender shows. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Payload of a decoded pairing frame (truncated to `size`), or null if it is not one. */
export function pairingPayload(bytes: Uint8Array, size: number): Uint8Array | null {
  try {
    const decoded = readFrame(bytes);
    if ((decoded.header.flags & FLAG.PAIRING) === 0) return null;
    return decoded.payload.slice(0, size);
  } catch {
    return null;
  }
}

/** True if the bytes are a valid pairing frame. */
export function isPairingFrame(bytes: Uint8Array): boolean {
  try {
    return (readFrame(bytes).header.flags & FLAG.PAIRING) !== 0;
  } catch {
    return false;
  }
}

/** Mode of a sent frame, read from its meta (byte 4) — never from the session. */
export function frameCodec(raw: Uint8Array): Codec {
  return majorityMeta(raw)[4] as Codec;
}

// ── Display ───────────────────────────────────────────────────────────────

export interface TmDisplayOptions {
  /** Duration of a subframe in ms (default 250). */
  period?: number;
  /**
   * Pixels per module of the rendering (default 12) — the canvas is then
   * scaled in CSS. "auto": the largest WHOLE number of physical pixels per
   * module that fits the mosaic in the canvas container, displayed at scale 1
   * (no resampling: sharp edges, all modules the same width).
   */
  moduleSize?: number | "auto";
  /**
   * Space available for the mosaic, in CSS pixels ("auto" mode). Default:
   * the content box of the canvas parent — to provide when this parent takes
   * the size of its content (the grid would grow with every batch).
   */
  box?: () => { width: number; height: number };
  /** Called when the rendered module size changes (quality alert). */
  onModule?: (pixelsPerModule: number, columns: number) => void;
}

/** Quiet zone around each grid (modules). */
const QUIET_ZONE = 2;

/**
 * Physical pixels per module so that a `columns` × `columns` mosaic fits in
 * `width` × `height` CSS pixels (at least 2).
 */
export function autoModuleSize(width: number, height: number, columns: number, density = 1): number {
  const side = GRID_SIZE + 2 * QUIET_ZONE;
  return Math.max(2, Math.floor((Math.min(width, height) * density) / (side * columns)));
}

interface DisplayedFrame {
  images: [ImageData, ImageData];
  /** Subframes left to display before handing back (Infinity: loop). */
  switches: number;
  end?: () => void;
}

export class TmDisplay {
  private readonly context: CanvasRenderingContext2D;
  private period: number;
  private readonly moduleSize: number | "auto";
  private current: DisplayedFrame | null = null;
  private animation: number | undefined = undefined;
  private phase = -1;
  private phaseStart = 0;

  constructor(readonly canvas: HTMLCanvasElement, private readonly options: TmDisplayOptions = {}) {
    this.context = canvas.getContext("2d")!;
    this.period = options.period ?? 250;
    this.moduleSize = options.moduleSize ?? 12;
  }

  set subframeDuration(ms: number) {
    this.period = ms;
  }

  /**
   * The window the canvas is shown in — not always this script's: the bench
   * can send in a separate window (another screen). Its clock (rAF, at ITS
   * refresh rate) and its pixel density are the ones that count.
   */
  private get view(): Window & typeof globalThis {
    return (this.canvas.ownerDocument?.defaultView ?? globalThis) as Window & typeof globalThis;
  }

  private prepare(raw: Uint8Array, codec: Codec): [ImageData, ImageData] {
    return this.prepareBatch([raw], [codec], 1);
  }

  /** Pixels per module of the next rendering: fixed, or derived from the container. */
  private currentModule(columns: number): number {
    if (this.moduleSize !== "auto") return this.moduleSize;
    const { width, height } = this.options.box?.() ?? this.parentBox();
    return autoModuleSize(width, height, columns, this.view.devicePixelRatio || 1);
  }

  /** CONTENT box of the canvas parent (padding subtracted). */
  private parentBox(): { width: number; height: number } {
    const container = this.canvas.parentElement;
    if (!container) return { width: this.view.innerWidth || 1080, height: this.view.innerHeight || 1080 };
    const style = this.view.getComputedStyle(container);
    const px = (v: string) => Number.parseFloat(v) || 0;
    return {
      width: container.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
      height: container.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
    };
  }

  /** Pixels per module of the last rendering. */
  get pixelsPerModule(): number {
    return this.lastModule;
  }
  private lastModule = 0;
  private lastColumns = 0;

  /** R and P of a batch of frames as a mosaic (`columns` grids per row). */
  private prepareBatch(frames: readonly Uint8Array[], codecs: readonly Codec[], columns: number): [ImageData, ImageData] {
    const module = this.currentModule(columns);
    const changed = module !== this.lastModule || columns !== this.lastColumns;
    this.lastModule = module;
    this.lastColumns = columns;
    if (changed) this.options.onModule?.(module, columns);
    const options = { moduleSize: module, quietZone: QUIET_ZONE };
    const r = renderMosaic(frames.map((t, i) => referenceSubframe(t, codecs[i]!)), TM_PALETTE, columns, options);
    const p = renderMosaic(frames.map((t, i) => payloadSubframe(t, codecs[i]!)), TM_PALETTE, columns, options);
    if (this.canvas.width !== r.width || this.canvas.height !== r.height) {
      this.canvas.width = r.width;
      this.canvas.height = r.height;
    }
    if (this.moduleSize === "auto") {
      // Scale 1: one canvas pixel = one physical screen pixel.
      const density = this.view.devicePixelRatio || 1;
      this.canvas.style.width = `${r.width / density}px`;
      this.canvas.style.height = `${r.height / density}px`;
    }
    return [new ImageData(r.data, r.width, r.height), new ImageData(p.data, p.width, p.height)];
  }

  /**
   * Displays a BATCH of frames as a mosaic for `cycles` R/P pairs: every cell
   * switches together, each one carries its own frame. The extra cells of an
   * incomplete batch repeat its first frames (never an empty cell, which
   * would be read as a lost frame).
   */
  showBatch(frames: readonly Uint8Array[], columns: number, cycles = 1): Promise<void> {
    const cells = columns * columns;
    const filled = Array.from({ length: cells }, (_, i) => frames[i % frames.length]!);
    this.finishCurrent();
    return new Promise((end) => {
      this.current = { images: this.prepareBatch(filled, filled.map(frameCodec), columns), switches: 2 * cycles, end };
      this.phase = -1;
      this.run();
    });
  }

  /** Displays a frame in a loop until the next one or stop(). */
  loop(raw: Uint8Array, codec: Codec = frameCodec(raw)): void {
    this.finishCurrent();
    this.current = { images: this.prepare(raw, codec), switches: Infinity };
    this.phase = -1;
    this.run();
  }

  /** Displays a frame for `cycles` R/P pairs, then hands back. */
  show(raw: Uint8Array, codec: Codec = frameCodec(raw), cycles = 2): Promise<void> {
    this.finishCurrent();
    return new Promise((end) => {
      this.current = { images: this.prepare(raw, codec), switches: 2 * cycles, end };
      this.phase = -1;
      this.run();
    });
  }

  stop(): void {
    this.finishCurrent();
    if (this.animation !== undefined) this.view.cancelAnimationFrame(this.animation);
    this.animation = undefined;
    this.current = null;
  }

  private finishCurrent(): void {
    const end = this.current?.end;
    this.current = null;
    end?.();
  }

  private run(): void {
    if (this.animation !== undefined) return;
    const view = this.view;
    const tick = (t: number) => {
      this.animation = view.requestAnimationFrame(tick);
      const frame = this.current;
      if (!frame) return;
      // A quarter-frame tolerance: rAF fires within 16.6 ms, and a strict "≥ 17"
      // would double every subframe (and 67 ms would become 83).
      if (this.phase < 0 || t - this.phaseStart >= this.period - 4) {
        if (frame.switches === 0) {
          // Last subframe displayed for its whole duration: hand back. While the
          // next batch is being prepared, the screen shows the GRAY R
          // (identical for every frame) instead of extending the P: the P keeps
          // its exact duration, the R gains the preparation time — on an LCD,
          // an R lasting a single refresh is never captured clean and the
          // receiver learns no reference.
          if (this.phase === 1) this.context.putImageData(frame.images[0]!, 0, 0);
          const end = frame.end;
          this.current = null;
          end?.();
          return;
        }
        // A frame always starts with its R reference (phase −1 → 0).
        this.phase = this.phase === 0 ? 1 : 0;
        this.phaseStart = t;
        this.context.putImageData(frame.images[this.phase]!, 0, 0);
        frame.switches--;
      }
    };
    this.animation = view.requestAnimationFrame(tick);
  }
}

/** Below this (physical pixels per module on screen), reading is not guaranteed. */
export const CRITICAL_MODULE = 3;
/** Below this, reading is possible but slow: phone very close, very steady. */
export const COMFORT_MODULE = 5;
/**
 * Same thresholds in CSS pixels — a PHYSICAL SIZE (≈ 0.16 to 0.26 mm per CSS
 * pixel): on a very dense screen, 8 physical pixels may only be 0.4 mm, too
 * small for a camera held at a normal distance.
 */
export const CRITICAL_MODULE_CSS = 2;
export const COMFORT_MODULE_CSS = 3;

export interface ModuleDiagnostic {
  level: "ok" | "info" | "warning" | "critical";
  /** Sentence to display ("" if all is well). */
  message: string;
}

/**
 * Does the module rendering guarantee quality and speed? `px`: physical
 * pixels per module on screen; `columns`: grids per row; `density`: physical
 * pixels per CSS pixel (devicePixelRatio). Both criteria count: enough pixels
 * AND a sufficient physical size. Suggests the densest mosaic that keeps
 * comfortable modules. The `level` values are CSS hooks (data-level).
 */
export function moduleDiagnostic(px: number, columns: number, density = 1): ModuleDiagnostic {
  const side = px * (GRID_SIZE + 2 * QUIET_ZONE) * columns;
  // Comfortable module in physical pixels AND in size (CSS pixels).
  const comfort = Math.max(COMFORT_MODULE, COMFORT_MODULE_CSS * density);
  const suggested = Math.floor(side / ((GRID_SIZE + 2 * QUIET_ZONE) * comfort));
  const css = px / density;
  const size = density > 1 ? ` (${css.toLocaleString("en-US", { maximumFractionDigits: 1 })} CSS px on this high-density screen)` : "";
  const remedy =
    suggested >= 1 && suggested < columns
      ? ` Switch to ${suggested === 1 ? "a single grid" : `${suggested} × ${suggested}`}, or enlarge the window.`
      : " Go full screen or use a larger screen.";
  if (px < CRITICAL_MODULE || css < CRITICAL_MODULE_CSS) {
    return { level: "critical", message: `${px} px modules on screen${size}: too small, reading is not guaranteed.${remedy}` };
  }
  if (px < COMFORT_MODULE || css < COMFORT_MODULE_CSS) {
    return { level: "warning", message: `${px} px modules on screen${size}: slow reading, hold the phone very close and still.${remedy}` };
  }
  if (columns > 3) {
    return { level: "info", message: `${columns} × ${columns} mosaic: the phone must film in 4K, otherwise it will read nothing.` };
  }
  return { level: "ok", message: "" };
}

/**
 * Refresh rate of the screen (Hz), measured over `images`
 * requestAnimationFrame callbacks (median of the intervals). Used to offer
 * 8 ms subframes when the screen runs at 120 Hz or more.
 */
export function measureRefreshRate(images = 40): Promise<number> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "undefined") return resolve(60);
    const gaps: number[] = [];
    let previous = -1;
    const tick = (t: number) => {
      if (previous >= 0) gaps.push(t - previous);
      previous = t;
      if (gaps.length < images) requestAnimationFrame(tick);
      else {
        gaps.sort((a, b) => a - b);
        resolve(1000 / Math.max(1, gaps[gaps.length >> 1]!));
      }
    };
    requestAnimationFrame(tick);
  });
}

// ── Reading an image stream (live camera or video) ────────────────────────

export { TmPipeline };

// ── Camera reading ────────────────────────────────────────────────────────

export interface TmReaderOptions extends TmReceiverOptions {
  /**
   * Called for each analyzed image (framing, overlay, advice). `all` carries
   * one entry per grid when the screen displays a mosaic. In Worker mode,
   * `image` only carries its dimensions (empty pixels).
   */
  onImage?: (result: TmImageResult, image: ImageRGBA, all: readonly TmImageResult[]) => void;
  /** Called for each new VALID frame (Reed-Solomon + CRC passed). */
  onFrame?: (bytes: Uint8Array, codec: Codec) => void;
  /** Camera stream: locks white balance + exposure when the grid is stable. */
  stream?: MediaStream;
  onLock?: (state: LockState) => void;
  /**
   * Decoding width in pixels, or "auto" (default): 1,920 px, raised to the
   * full camera width (3,840 px at most) as soon as the captured modules
   * become too small — 4 × 4 mosaic and beyond.
   */
  width?: number | "auto";
  /** Decoding in a Worker when the browser allows it (default: true). */
  worker?: boolean;
}

/** Decodable images in flight to the Worker; beyond that, the image is skipped. */
const MAX_IN_FLIGHT = 3;

export class TmReader {
  readonly pipeline: TmPipeline;
  private readonly canvas = document.createElement("canvas");
  private readonly context = this.canvas.getContext("2d", { willReadFrequently: true })!;
  private active = false;
  private stableCount = 0;
  private lockApplied = false;
  private readonly adaptive = new AdaptiveWidth();
  private worker: Worker | null = null;
  private inFlight = 0;
  private nextId = 0;
  private workerStats = { valid: 0, pairs: 0, mixed: 0, images: 0 };

  constructor(private readonly video: HTMLVideoElement, private readonly options: TmReaderOptions = {}) {
    this.pipeline = new TmPipeline(options);
    if (options.worker !== false) this.worker = this.createWorker();
  }

  get receiver(): TmReceiver {
    return this.pipeline.receiver;
  }

  get mosaic(): TmMosaicReceiver {
    return this.pipeline.mosaic;
  }

  /** True when decoding runs in a Worker. */
  get inWorker(): boolean {
    return this.worker !== null;
  }

  /** Width at which the images are currently decoded. */
  get decodeWidth(): number {
    const { videoWidth } = this.video;
    const requested = this.options.width ?? "auto";
    if (requested === "auto") return this.adaptive.width(videoWidth);
    return Math.min(requested, videoWidth || requested);
  }

  /** Valid frames and pairs, single grid and mosaic combined. */
  get stats(): { valid: number; pairs: number; mixed: number } {
    return this.worker ? this.workerStats : this.pipeline.stats;
  }

  /** Forgets geometry, cells and pairings (camera reopened, new sending). */
  reset(): void {
    this.pipeline.reset();
    this.adaptive.reset();
    this.post({ type: "reset" });
  }

  /** Forgets the pairings of the single grid (new phase of the transfer). */
  resetReceiver(): void {
    this.pipeline.receiver.reset();
    this.post({ type: "resetReceiver" });
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const next = () => {
      if (!this.active) return;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
      else setTimeout(tick, 16);
    };
    const tick = () => {
      if (!this.active) return;
      try {
        if (this.worker) this.postImage();
        else this.process();
      } catch (e) {
        console.warn("[optirelay] image skipped:", (e as Error).message);
      }
      next();
    };
    next();
  }

  stop(): void {
    this.active = false;
  }

  /** Releases the Worker (end of reception). */
  close(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }

  /**
   * Camera REOPENED (back from slow motion, resume): the new stream will get
   * its own white balance + exposure lock, and the old geometry is forgotten.
   */
  setStream(stream: MediaStream): void {
    this.options.stream = stream;
    this.lockApplied = false;
    this.stableCount = 0;
    this.reset();
  }

  /** Allows a new automatic lock (after a "give back the automatic mode"). */
  relockLater(): void {
    this.lockApplied = false;
    this.stableCount = 0;
  }

  private createWorker(): Worker | null {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
    try {
      const w = new Worker(new URL("./reader-worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<MessageFromWorker>) => this.receive(ev.data);
      w.onerror = (ev) => {
        // Worker not found (offline before it was cached) or broken: fall back to
        // decoding on the main thread.
        ev.preventDefault();
        console.warn("[optirelay] Worker decoding unavailable, falling back to the main thread.");
        w.terminate();
        if (this.worker === w) this.worker = null;
        this.inFlight = 0;
      };
      const { onImage: _a, onFrame: _b, stream: _c, onLock: _d, width: _e, worker: _f, ...receiver } = this.options;
      w.postMessage({ type: "init", options: receiver } satisfies MessageToWorker);
      return w;
    } catch {
      return null;
    }
  }

  private post(message: MessageToWorker): void {
    this.worker?.postMessage(message);
  }

  /** Decoding dimensions of the current image, or null if the video has no image. */
  private dimensions(): { l: number; h: number } | null {
    const { videoWidth, videoHeight } = this.video;
    if (!videoWidth) return null;
    const scale = Math.min(1, this.decodeWidth / videoWidth);
    return { l: Math.round(videoWidth * scale), h: Math.round(videoHeight * scale) };
  }

  private postImage(): void {
    const dim = this.dimensions();
    if (!dim || !this.worker) return;
    // Overloaded Worker: skip this image rather than accumulating delay (a
    // missed R/P pair is caught up at the next one).
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    this.inFlight++;
    const id = this.nextId++;
    const t = performance.now();
    const worker = this.worker;
    createImageBitmap(this.video, { resizeWidth: dim.l, resizeHeight: dim.h, resizeQuality: "high" }).then(
      (bitmap) => {
        if (this.worker !== worker) {
          bitmap.close();
          return;
        }
        worker.postMessage({ type: "image", id, bitmap, t } satisfies MessageToWorker, [bitmap]);
      },
      () => {
        this.inFlight = Math.max(0, this.inFlight - 1);
      },
    );
  }

  private receive(m: MessageFromWorker): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (m.type === "error") {
      console.warn("[optirelay] image skipped:", m.message);
      return;
    }
    this.workerStats = m.stats;
    // The Worker does not send the pixels back: the overlay only needs the dimensions.
    this.afterDecode(m.all, { width: m.width, height: m.height, data: new Uint8ClampedArray(0) });
  }

  private process(): void {
    const dim = this.dimensions();
    if (!dim) return;
    const { l, h } = dim;
    if (this.canvas.width !== l || this.canvas.height !== h) {
      this.canvas.width = l;
      this.canvas.height = h;
    }
    this.context.drawImage(this.video, 0, 0, l, h);
    const d = this.context.getImageData(0, 0, l, h);
    const image: ImageRGBA = { width: d.width, height: d.height, data: d.data };
    this.afterDecode(this.pipeline.process(image, performance.now()), image);
  }

  /** Sensor lock, decoding width, callbacks: shared by both modes. */
  private afterDecode(all: readonly TmImageResult[], image: ImageRGBA): void {
    const result = all[0]!;
    this.stableCount = result.location ? this.stableCount + 1 : 0;
    // Decoding width: full camera width for a dense mosaic (fine modules, or no
    // grid found at 1,920 px), otherwise 1,920 px.
    const seen = all.map((r) => r.location?.pxPerModule ?? 0).filter((p) => p > 0);
    if ((this.options.width ?? "auto") === "auto" && this.adaptive.observe(seen.length ? Math.min(...seen) : 0, this.video.videoWidth)) {
      this.pipeline.reset(); // geometry at the old scale
      this.post({ type: "reset" });
    }
    if (this.options.stream && !this.lockApplied && this.stableCount >= 8) {
      this.lockApplied = true;
      void lockSensor(this.options.stream, { whiteBalance: true, exposure: true }).then((e) => this.options.onLock?.(e));
    }
    this.options.onImage?.(result, image, all);
    for (const r of all) if (r.frame?.isNew) this.options.onFrame?.(r.frame.bytes, r.frame.codec);
  }
}
