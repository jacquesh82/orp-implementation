/**
 * CALIBRATION of a screen → phone pair: the bench (sending screen) plays a
 * series of short TRIALS — each subframe duration, each mosaic — that the
 * phone films in one go in slow motion. Each frame is a service frame
 * (MIRE / test-pattern flag) carrying its trial (`block`) and its index in the
 * trial (`seed`): the phone counts, trial by trial, the frames read, derives
 * the useful throughput and recommends the best setting. The way back to the
 * bench is a SHORT CODE ("33-2": 33 ms, 2 × 2 mosaic) typed by hand.
 *
 * Order of the trials: from the slowest to the fastest. The slow trials show
 * the gray R reference for a long time, which the averaging receiver learns
 * and keeps for the fast trials where the screen no longer stabilizes it.
 */

import { CODEC, buildFrame, FLAG, readFrame, mulberry32, SYMBOL_SIZE, FRAME_VERSION } from "@optirelay/core";
import type { TmDisplay } from "./tm.ts";

export interface CalibrationTrial {
  /** Trial number, carried by the `block` field of the frames. */
  id: number;
  /** Duration of a subframe (ms). */
  period: number;
  /** Grids per row: 1 to 4 in the series (square mosaic). */
  columns: number;
  /** Sending duration of the trial (ms). */
  duration: number;
}

const TRIAL_DURATION = 2500;

export const CALIBRATION_TRIALS: readonly CalibrationTrial[] = [
  { id: 1, period: 67, columns: 1, duration: TRIAL_DURATION },
  { id: 2, period: 33, columns: 1, duration: TRIAL_DURATION },
  { id: 3, period: 17, columns: 1, duration: TRIAL_DURATION },
  { id: 4, period: 33, columns: 2, duration: TRIAL_DURATION },
  { id: 5, period: 17, columns: 2, duration: TRIAL_DURATION },
  { id: 6, period: 33, columns: 3, duration: TRIAL_DURATION },
  { id: 7, period: 17, columns: 3, duration: TRIAL_DURATION },
  // 4 × 4: only useful if the receiver decodes more finely than 1,920 px
  // (4K camera) — otherwise these trials read nothing and are never retained.
  { id: 8, period: 33, columns: 4, duration: TRIAL_DURATION },
  { id: 9, period: 17, columns: 4, duration: TRIAL_DURATION },
];

/** Preamble (countdown): one frame in a loop, ignored by the measurement. */
export const CALIBRATION_PREAMBLE = 0;
/** Pause between two trials (ms): the mosaic changes, the receiver re-syncs. */
export const CALIBRATION_PAUSE = 500;
/** Total duration of the series, preamble excluded (ms). */
export const CALIBRATION_SERIES_DURATION =
  CALIBRATION_TRIALS.reduce((s, e) => s + e.duration, 0) + CALIBRATION_PAUSE * (CALIBRATION_TRIALS.length - 1);

/** Token of the calibration frames: "CALI". */
export const CALIBRATION_TOKEN = 0x43414c49;
/** Symbols per frame: the capacity of a TM8 grid. */
const SYMBOLS = 4;
/** Useful bytes a transfer frame carries at equal capacity. */
export const FRAME_PAYLOAD_SIZE = SYMBOLS * SYMBOL_SIZE;

/** Calibration frame number `index` of trial `trial` (deterministic pseudo-random content). */
export function calibrationFrame(trial: number, index: number): Uint8Array {
  const prng = mulberry32(((trial & 0xff) << 24) ^ (index * 2654435761) ^ CALIBRATION_TOKEN);
  const payload = Uint8Array.from({ length: FRAME_PAYLOAD_SIZE }, () => Math.floor(prng() * 256));
  return buildFrame(
    { version: FRAME_VERSION, codec: CODEC.COLOR_8, flags: FLAG.TEST_PATTERN, token: CALIBRATION_TOKEN, block: trial, k: 1, symbolCount: SYMBOLS, seed: index },
    payload,
  );
}

/** Trial and index of a decoded calibration frame, or null if it is not one. */
export function readCalibration(bytes: Uint8Array): { trial: number; index: number } | null {
  try {
    const { header } = readFrame(bytes);
    if (!(header.flags & FLAG.TEST_PATTERN) || header.token >>> 0 !== CALIBRATION_TOKEN) return null;
    return { trial: header.block, index: header.seed };
  } catch {
    return null;
  }
}

export interface TrialResult extends CalibrationTrial {
  /** Distinct frames read. */
  readCount: number;
  /** Frames sent (estimate: highest index read + 1). */
  sentCount: number;
  /** Share of the sent frames read without error (0..1). */
  share: number;
  /** Useful throughput: file bytes per filmed second. */
  throughput: number;
}

/** Counts, trial by trial, the calibration frames read. */
export class CalibrationMeasurement {
  private readonly seenIndices = new Map<number, Set<number>>();

  /** True if the frame is a NEW calibration frame. */
  add(bytes: Uint8Array): boolean {
    const t = readCalibration(bytes);
    if (!t || t.trial === CALIBRATION_PREAMBLE) return false;
    if (!CALIBRATION_TRIALS.some((e) => e.id === t.trial)) return false;
    let seen = this.seenIndices.get(t.trial);
    if (!seen) this.seenIndices.set(t.trial, (seen = new Set()));
    if (seen.has(t.index)) return false;
    seen.add(t.index);
    return true;
  }

  get total(): number {
    let n = 0;
    for (const v of this.seenIndices.values()) n += v.size;
    return n;
  }

  results(): TrialResult[] {
    return CALIBRATION_TRIALS.map((e) => {
      const seen = this.seenIndices.get(e.id);
      const readCount = seen?.size ?? 0;
      const sentCount = seen && seen.size ? Math.max(...seen) + 1 : 0;
      return { ...e, readCount, sentCount, share: sentCount ? readCount / sentCount : 0, throughput: (readCount * FRAME_PAYLOAD_SIZE) / (e.duration / 1000) };
    });
  }

  /**
   * The best setting: the highest useful throughput among the trials read at
   * least at 50 % (margin for a real transfer); failing that, the highest
   * throughput overall; null if nothing was read.
   */
  recommendation(): TrialResult | null {
    const r = this.results().filter((e) => e.readCount > 0);
    if (!r.length) return null;
    const safe = r.filter((e) => e.share >= 0.5);
    return (safe.length ? safe : r).reduce((a, b) => (b.throughput > a.throughput ? b : a));
  }
}

/** Short code of a setting: "33-2" = 33 ms per subframe, 2 × 2 mosaic. */
export function calibrationCode(e: Pick<CalibrationTrial, "period" | "columns">): string {
  return `${e.period}-${e.columns}`;
}

/**
 * Recognized subframe durations (ms). 8 ms assumes a sending screen at
 * 120 Hz at least; at 60 Hz, each subframe would actually last 17 ms.
 */
export const SUBFRAME_PERIODS: readonly number[] = [8, 17, 33, 67, 100, 150, 250];
/** Maximum grids per row (7 × 7 mosaic: limit of a 4K camera). */
export const MAX_COLUMNS = 7;

/** Setting of a typed short code, or null if it is not valid. */
export function readCalibrationCode(code: string): { period: number; columns: number } | null {
  const m = /^\s*(\d{1,3})\s*[-–·x×/ ]\s*(\d)\s*$/i.exec(code);
  if (!m) return null;
  const period = Number(m[1]);
  const columns = Number(m[2]);
  if (!SUBFRAME_PERIODS.includes(period)) return null;
  if (columns < 1 || columns > MAX_COLUMNS) return null;
  return { period, columns };
}

/**
 * Calibration remembered by the browser (localStorage, key
 * `optirelay.calibration`), shared by the app and the bench — same origin.
 * `side` tells which screen it was entered on: the sender applies only a
 * calibration saved on the sending side.
 */
export interface StoredCalibration {
  period: number;
  columns: number;
  code: string;
  date: number;
  side: "sender" | "receiver";
}

export const CALIBRATION_KEY = "optirelay.calibration";

/**
 * Reads the stored calibration, or null. A calibration saved by an earlier
 * version (French keys: periode, colonnes, cote "emetteur" / "recepteur") is
 * converted and written back in the current format.
 */
export function loadCalibration(storage?: Storage): StoredCalibration | null {
  let raw: Record<string, unknown> | null;
  let store: Storage;
  try {
    // The localStorage getter itself throws where storage is blocked.
    store = storage ?? localStorage;
    raw = JSON.parse(store.getItem(CALIBRATION_KEY) ?? "null") as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const legacy = "periode" in raw || "colonnes" in raw || "cote" in raw;
  const side = raw[legacy ? "cote" : "side"];
  const r = readCalibrationCode(`${String(raw[legacy ? "periode" : "period"])}-${String(raw[legacy ? "colonnes" : "columns"])}`);
  if (!r) return null;
  const stored: StoredCalibration = {
    ...r,
    code: calibrationCode(r),
    date: typeof raw.date === "number" ? raw.date : Date.now(),
    side: side === "sender" || side === "emetteur" ? "sender" : "receiver",
  };
  if (legacy) {
    try {
      store.setItem(CALIBRATION_KEY, JSON.stringify(stored));
    } catch {
      // read-only storage: converted again at the next reading
    }
  }
  return stored;
}

/** Remembers a calibration; false when the storage is unavailable. */
export function saveCalibration(r: { period: number; columns: number }, side: StoredCalibration["side"], storage?: Storage): boolean {
  const stored: StoredCalibration = { period: r.period, columns: r.columns, code: calibrationCode(r), date: Date.now(), side };
  try {
    (storage ?? localStorage).setItem(CALIBRATION_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export interface SeriesOptions {
  /** Countdown before the first trial (s); the preamble runs meanwhile. */
  countdown?: number;
  /** Called at each step, for the bench display. */
  onStep?: (step: { phase: "countdown"; remaining: number } | { phase: "trial"; trial: CalibrationTrial; index: number; sentCount: number } | { phase: "pause"; next: CalibrationTrial } | { phase: "end" }) => void;
  /** Stop requested (popup closed). */
  stopped?: () => boolean;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plays the calibration series on the bench display. Returns, per trial, the
 * number of frames actually sent (the phone estimates it on its side).
 */
export async function sendCalibrationSeries(display: TmDisplay, options: SeriesOptions = {}): Promise<Map<number, number>> {
  const sentCount = new Map<number, number>();
  const stopped = options.stopped ?? (() => false);
  display.subframeDuration = 100;
  display.loop(calibrationFrame(CALIBRATION_PREAMBLE, 0), CODEC.COLOR_8);
  for (let remaining = options.countdown ?? 4; remaining > 0; remaining--) {
    if (stopped()) return sentCount;
    options.onStep?.({ phase: "countdown", remaining });
    await wait(1000);
  }
  for (const [i, trial] of CALIBRATION_TRIALS.entries()) {
    if (stopped()) return sentCount;
    if (i > 0) {
      options.onStep?.({ phase: "pause", next: trial });
      display.stop();
      const c = display.canvas.getContext("2d")!;
      c.fillStyle = "#808080";
      c.fillRect(0, 0, display.canvas.width, display.canvas.height);
      await wait(CALIBRATION_PAUSE);
    }
    display.subframeDuration = trial.period;
    const cells = trial.columns * trial.columns;
    const startTime = performance.now();
    let index = 0;
    while (performance.now() - startTime < trial.duration && !stopped()) {
      const batch = Array.from({ length: cells }, (_, k) => calibrationFrame(trial.id, index + k));
      index += cells;
      options.onStep?.({ phase: "trial", trial, index, sentCount: index });
      if (cells === 1) await display.show(batch[0]!, CODEC.COLOR_8, 1);
      else await display.showBatch(batch, trial.columns, 1);
    }
    sentCount.set(trial.id, index);
  }
  display.stop();
  options.onStep?.({ phase: "end" });
  return sentCount;
}
