/**
 * OptiRelay reference PWA (F-17, D-009) — built ONLY on the public packages:
 * @optirelay/core (session, crypto), @optirelay/optical (TM4/TM8) and
 * @optirelay/browser (camera, TM transport). No engine here: the screen
 * orchestration and nothing else.
 *
 * Sending  : file → init code (TM4, in a loop) → the webcam reads the
 *            phone's response → SAS code compared → TM8/TM4 frames.
 * Receiving: camera → init code → response displayed for the sender's
 *            webcam → SAS compared → frames → digest checked → NO automatic
 *            import (F-20): the user decides.
 *
 * HTML ids, CSS classes and data-* attributes are hooks shared with
 * index.html and style.css.
 */

import {
  CODEC,
  Codec,
  CryptoWebCrypto,
  SenderSession,
  ReceiverSession,
  INIT_CODE_SIZE,
  RESPONSE_CODE_SIZE,
  REVEAL_CODE_SIZE,
  pairingCodeKind,
  readInitCode,
  readMetaByMajority,
  type InitCodeInfo,
} from "@optirelay/core";
import { tmName, type ImageRGBA, type TmImageResult } from "@optirelay/optical";
import {
  TmDisplay,
  moduleDiagnostic,
  autoModuleSize,
  calibrationCode,
  readCalibrationCode,
  loadCalibration,
  saveCalibration,
  measureRefreshRate,
  pairingPayload,
  isPairingFrame,
  closeCamera,
  TmReader,
  readTmVideo,
  filmStream,
  filmSlowMotion,
  releaseCamera,
  nativeSlowMotionAvailable,
  type Recording,
  type EncodedVideo,
  openCamera,
  pairingFrame,
  readSendState,
  clock,
  type SendState,
  BENCH_PASSPHRASE,
  unpack,
  pack,
  readableSize,
  readableThroughput,
  readableDuration,
  saveFile,
  createPreview,
  type Preview,
  TransferTracker,
  SendThroughput,
  FilmingGauge,
  type LockState,
  type TransferredFile,
} from "@optirelay/browser";
import { drawOverlay } from "./overlay.ts";


const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const IN_ANDROID = location.host === "appassets.androidplatform.net";

// ── Views ─────────────────────────────────────────────────────────────────

const VIEWS = ["home-screen", "pairing-screen", "received-screen", "send-screen", "capture-screen", "response-screen", "phrase-screen"] as const;
type View = (typeof VIEWS)[number];
const DARK_VIEWS: View[] = ["send-screen", "capture-screen", "response-screen", "phrase-screen"];

function showView(view: View): void {
  for (const id of VIEWS) $(id).hidden = id !== view;
  // Bottom bar: only on the main destinations (home).
  $("bottom-nav").hidden = !(IN_ANDROID && view === "home-screen");
  document.body.classList.toggle("dark", DARK_VIEWS.includes(view));
  window.scrollTo(0, 0);
  const title = $(view).querySelector("h1, h2") as HTMLElement | null;
  title?.setAttribute("tabindex", "-1");
  title?.focus({ preventScroll: true });
}

function note(message: string): void {
  const line = document.createElement("p");
  line.textContent = `${new Date().toLocaleTimeString("en-US")} · ${message}`;
  $("log").prepend(line);
  console.log(`[OptiRelay] ${message}`);
}

$("log-button").addEventListener("click", () => {
  const logView = $("log");
  logView.hidden = !logView.hidden;
  $("log-button").setAttribute("aria-expanded", String(!logView.hidden));
});

// ── Android: native navigation (bottom bar + side menu) ───────────────────
// Home becomes two destinations, Receive (the phone use case, by default)
// and Send; the test bench is a third page.

type Tab = "receive" | "send";
const drawer = $<HTMLDialogElement>("drawer");

function chooseTab(tab: Tab): void {
  $("home-screen").dataset.tab = tab;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("[data-tab]:not(section)"))) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
}

function closeDrawer(): void {
  if (drawer.open) drawer.close();
}

if (IN_ANDROID) {
  document.documentElement.classList.add("android");
  chooseTab("receive");
  $("bottom-nav").hidden = false;
}
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-tab]"))) {
  b.addEventListener("click", () => {
    closeDrawer();
    showView("home-screen");
    chooseTab(b.dataset.tab as Tab);
  });
}
$("open-drawer").addEventListener("click", () => drawer.showModal());
drawer.addEventListener("close", () => $("open-drawer").setAttribute("aria-expanded", "false"));
drawer.addEventListener("click", (e) => {
  if (e.target === drawer) closeDrawer(); // touching the backdrop closes the menu
});
new MutationObserver(() => $("open-drawer").setAttribute("aria-expanded", String(drawer.open))).observe(drawer, { attributes: true, attributeFilter: ["open"] });
$("drawer-log").addEventListener("click", () => {
  closeDrawer();
  const logView = $("log");
  if (logView.hidden) $("log-button").click();
  logView.scrollIntoView({ block: "end" });
});

const sas = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
const crypto = () => new CryptoWebCrypto();

// ── Home: file and mode ───────────────────────────────────────────────────

type Mode = "auto" | "tm8" | "tm4";
let mode: Mode = "auto";
let columns = 2; // grids per row on screen (square mosaic)
let period = 250; // duration of a subframe (ms)
let refreshRate = 60; // Hz, measured at load time

/** Checks, in a group of segments, the button whose `data-<key>` equals `value`. */
function check(group: string, key: string, value: number): void {
  for (const b of $(group).querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-checked", String(Number(b.dataset[key]) === value));
  }
}

function periodHelp(): string {
  if (period >= 100) return `${period} ms: can be read live by any phone.`;
  if (period >= 33) return `${period} ms: slow-mo recommended (at least 120 fps).`;
  if (period >= 17) return `${period} ms: film in slow-mo (240 fps), or live with a steady 60 fps camera.`;
  return `${period} ms: sending screen at ${Math.round(refreshRate)} Hz, film in slow-mo at 240 fps.`;
}

/** Shows (or hides) a module size alert. */
function moduleAlert(id: string, px: number, k: number): void {
  const d = moduleDiagnostic(px, k, globalThis.devicePixelRatio || 1);
  const el = $(id);
  el.hidden = d.level === "ok";
  el.dataset.level = d.level;
  el.textContent = d.message;
}

/**
 * Module size expected on THIS screen, before sending: full screen, minus the
 * room taken by the banners (≈ 200 CSS px) around the grid.
 */
function planModule(): void {
  const density = globalThis.devicePixelRatio || 1;
  const px = autoModuleSize(screen.width, Math.max(200, screen.height - 200), columns, density);
  moduleAlert("grids-alert", px, columns);
}

function applySettings(r: { period?: number; columns?: number }): void {
  if (r.period !== undefined) period = r.period;
  if (r.columns !== undefined) columns = r.columns;
  check("grids", "columns", columns);
  check("periods", "period", period);
  $("period-help").textContent = periodHelp();
  planModule();
}
planModule();

for (const button of $("grids").querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => applySettings({ columns: Number(button.dataset.columns) }));
}
for (const button of $("periods").querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => applySettings({ period: Number(button.dataset.period) }));
}

// 8 ms per subframe only makes sense on a screen at 120 Hz or more.
void measureRefreshRate().then((hz) => {
  refreshRate = hz;
  $("periods").querySelector<HTMLButtonElement>('[data-period="8"]')!.hidden = hz < 110;
});

// Same storage as the lab (loadCalibration / saveCalibration): a calibration
// entered on this screen sets it right away.

$("calibration-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const r = readCalibrationCode($<HTMLInputElement>("calibration-code").value);
  const help = $("calibration-help");
  if (!r) {
    help.textContent = "Code not recognized: two numbers like “33-3” (duration in ms, then grids per row, from 1 to 7).";
    return;
  }
  if (r.period < 17 && refreshRate < 110) {
    help.textContent = `This code asks for ${r.period} ms per subframe: this screen runs at ${Math.round(refreshRate)} Hz and can't keep up.`;
    return;
  }
  applySettings(r);
  help.textContent = `Code ${calibrationCode(r)} applied: ${r.period} ms per subframe, ${r.columns === 1 ? "a single grid" : `${r.columns} × ${r.columns} mosaic`}.`;
  saveCalibration(r, "sender"); // false: applied for this session only
});

// A calibration already entered on this screen sets the sending as soon as it opens.
try {
  const r = loadCalibration();
  if (r?.side === "sender") {
    applySettings(r);
    $<HTMLInputElement>("calibration-code").value = calibrationCode(r);
    $("calibration-help").textContent = `Saved calibration: ${calibrationCode(r)}.`;
  }
} catch {
  // nothing saved
}
let file: File | null = null;

const HELP_TEXTS: Record<Mode, string> = {
  auto: "TM8 first; while sending, a button switches to TM4 if the phone struggles.",
  tm8: "3 bits per module: the fastest, needs good framing.",
  tm4: "2 bits per module: slower, tolerates noise and glare.",
};

for (const button of $("modes").querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => {
    mode = button.dataset.mode as Mode;
    for (const b of $("modes").querySelectorAll("button")) b.setAttribute("aria-checked", String(b === button));
    $("mode-help").textContent = HELP_TEXTS[mode];
  });
}

function chooseFile(f: File | null | undefined): void {
  file = f ?? null;
  const dropZone = $("drop");
  dropZone.classList.toggle("selected", !!file);
  $("drop-title").textContent = file ? file.name : "Drop a file here";
  $("drop-help").innerHTML = file
    ? `${readableSize(file.size)} · <u>change</u>`
    : "or <u>browse</u>: a text, a key, a small document";
  ($("start") as HTMLButtonElement).disabled = !file;
}

$<HTMLInputElement>("file").addEventListener("change", (e) => chooseFile((e.target as HTMLInputElement).files?.[0]));
const dropZone = $("drop");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("hover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("hover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("hover");
  chooseFile(e.dataTransfer?.files?.[0]);
});

// ── Sending ───────────────────────────────────────────────────────────────

let sending: {
  session: SenderSession;
  initPayload: TmDisplay;
  stream?: MediaStream | undefined;
  reader?: TmReader;
  view?: TmDisplay;
} | null = null;

function modeCodecs(): Codec[] {
  if (mode === "tm4") return [CODEC.COLOR_4];
  return [CODEC.COLOR_8, CODEC.COLOR_4]; // TM4 always available as a manual fallback
}

function pairingStep(n: number): void {
  for (const li of $("pairing-screen").querySelectorAll<HTMLElement>(".steps li")) {
    const e = Number(li.dataset.step);
    li.classList.toggle("done", e < n);
    if (e === n) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  }
}

$("start").addEventListener("click", () => void beginSending().catch((e) => reportError(e)));

async function beginSending(): Promise<void> {
  if (!file) return;
  const data = pack({ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) });
  const session = new SenderSession(crypto(), { codecs: modeCodecs() });
  await session.prepare(data);
  const initPayload = new TmDisplay($<HTMLCanvasElement>("canvas-code-init"), { moduleSize: 10 });
  initPayload.loop(pairingFrame(session.initCode()), CODEC.COLOR_4);
  sending = { session, initPayload };

  $("pairing-name").textContent = file.name;
  $("pairing-size").textContent = `${readableSize(file.size)} · ${mode === "tm4" ? "TM4" : "TM8"}`;
  $("sas-card").hidden = true;
  $("webcam-status").textContent = "Show the phone's screen to the webcam";
  $("webcam-title").classList.remove("ok");
  pairingStep(2);
  showView("pairing-screen");
  note(`sending prepared: ${file.name}, ${readableSize(file.size)}`);

  // Webcam: reads the response code displayed by the phone.
  try {
    const stream = await openCamera({ rearFacing: false });
    sending.stream = stream;
    const video = $<HTMLVideoElement>("video-webcam");
    video.srcObject = stream;
    await video.play();
    const reader = new TmReader(video, {
      codecs: [CODEC.COLOR_4],
      onImage: (r, image) => {
        const advice = drawOverlay($<HTMLCanvasElement>("webcam-overlay"), video, r, image);
        if (r.location) $("webcam-help").textContent = advice || "Phone's code in view — reading…";
      },
      onFrame: (bytes) => void responseRead(bytes),
    });
    sending.reader = reader;
    reader.start();
  } catch (e) {
    $("webcam-help").textContent = `Webcam unavailable: ${(e as Error).message}`;
  }
}

async function responseRead(bytes: Uint8Array): Promise<void> {
  const e = sending;
  const payload = pairingPayload(bytes, RESPONSE_CODE_SIZE);
  if (!e || !payload || e.session.state !== "appairage") return;
  try {
    await e.session.receiveResponseCode(payload);
  } catch (err) {
    note(`reply ignored: ${(err as Error).message}`);
    return;
  }
  e.reader?.close();
  if (e.stream) closeCamera(e.stream);
  e.stream = undefined;
  // ORP v0.2: the code alongside becomes the REVEAL code (this computer's key,
  // committed in the init code). The phone reads it to compute its own
  // verification code — before that, it has none to show.
  e.initPayload.loop(pairingFrame(e.session.revealCode()), CODEC.COLOR_4);
  $("webcam-status").textContent = "Phone's reply read";
  $("webcam-title").classList.add("ok");
  $("webcam-help").textContent = "Now aim the phone at the code alongside again: it then shows its verification code.";
  $("sender-sas").textContent = sas(e.session.sas());
  // Kept for the sending view: in full screen, the SAS card is no longer
  // visible, and this code is what guarantees we talk to the right device.
  $("send-sas").textContent = sas(e.session.sas());
  $("sas-card").hidden = false;
  pairingStep(3);
  $("confirm-sas").focus();
  note("reply read — verification code shown.");
}

$("confirm-sas").addEventListener("click", () => void launchSending().catch((e) => reportError(e)));
$("decline-sas").addEventListener("click", () => {
  note("verification codes differ: session cancelled.");
  stopSending();
});
$("cancel-pairing").addEventListener("click", () => stopSending());

/**
 * Sending in the SAME conditions as the test bench (apps/lab, sendFile),
 * which serves as the reading reference:
 *   - countdown with the init code in a loop, at 100 ms per subframe at
 *     least: the phone locks white balance and exposure there and learns the
 *     gray reference (at 17 ms, an LCD never shows the R long enough for it);
 *   - one R/P pair per frame (the throughput the calibration measured);
 *   - the init code repeated within the stream, with the SEND STATE (clock,
 *     symbols sent, "to film" target): the phone filming in slow motion syncs
 *     to the sender's clock to tell how long to film.
 */
const SENDING_COUNTDOWN = 5; // s
const CODE_REPEAT = 10; // single grid: the init code comes back every 10 frames
const BATCH_REPEAT = 3; // mosaic: it takes one cell every third batch

/**
 * Room for the grid, in CSS pixels: the scene, minus the column (landscape) or
 * the strip (portrait) of the countdown. Reserved PERMANENTLY, so that the
 * modules keep the same size from the countdown to the data.
 */
function sceneBox(): { width: number; height: number } {
  const scene = $("send-canvas").parentElement!;
  const s = getComputedStyle(scene);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const l = scene.clientWidth - px(s.paddingLeft) - px(s.paddingRight);
  const h = scene.clientHeight - px(s.paddingTop) - px(s.paddingBottom);
  const portrait = l < h;
  scene.classList.toggle("portrait", portrait);
  return portrait ? { width: l, height: Math.max(120, h - 190) } : { width: Math.max(120, l - 300), height: h };
}

async function launchSending(): Promise<void> {
  const e = sending;
  if (!e) return;
  e.session.confirmSas();
  e.initPayload.stop();
  // "auto" module size: whole physical pixels, mosaic at scale 1.
  const view = new TmDisplay($<HTMLCanvasElement>("send-canvas"), {
    moduleSize: "auto",
    period,
    box: sceneBox,
    onModule: (px, k) => updateSendingMode(px, k),
  });
  e.view = view;
  $("send-file").textContent = `${file?.name ?? ""} · ${readableSize(file?.size ?? 0)} · encrypted`;
  updateSendingMode();
  updateGauge(null);
  showView("send-screen");
  void document.documentElement.requestFullscreen?.().catch(() => undefined);
  void (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen").catch(() => undefined);

  const initInfo = readInitCode(e.session.initCode());
  const toFilm = new FilmingGauge(initInfo.kTotal, initInfo.blockCount);
  // SENDER CLOCK, read by the phone in each repetition of the code.
  let dataStart: number | null = null;
  const initWithState = (t?: number) =>
    pairingFrame(e.session.initCode(), {
      t: t ?? (dataStart === null ? 0 : performance.now() - dataStart),
      sentSymbols: toFilm.sentSymbols,
      suggestedSymbols: toFilm.suggested,
    });
  // The reveal code also comes back within the stream, every other code
  // repetition: a phone that missed it before the confirmation (slow motion,
  // imported video) still gets the key it needs to compute its SAS.
  const reveal = pairingFrame(e.session.revealCode());
  let codeRepeats = 0;
  const codeFrame = (t?: number) => (codeRepeats++ % 2 === 1 ? reveal : initWithState(t));

  // Time to pick the phone up again after confirming the SAS code. Nothing is
  // lost when aiming late: each frame is a new combination (fountain code),
  // the next ones replace those that were missed.
  view.subframeDuration = Math.max(period, 100);
  $("send-count").hidden = false;
  for (let remaining = SENDING_COUNTDOWN; remaining > 0; remaining--) {
    view.loop(codeFrame(-remaining * 1000), CODEC.COLOR_4);
    $("send-count-digit").textContent = String(remaining);
    $("send-frames").textContent = `Starting in ${remaining} s`;
    await new Promise((r) => setTimeout(r, 1000));
    if (sending !== e) return;
  }
  $("send-count").hidden = true;
  view.subframeDuration = period;

  const throughput = new SendThroughput();
  const cells = columns * columns;
  const perRow = columns;
  note(`transmission started${cells > 1 ? ` in ${perRow}×${perRow} mosaic` : ""}.`);
  let n = 0;
  let batches = 0;
  let batch: Uint8Array[] = [];
  const updateHud = () => {
    updateGauge(toFilm, dataStart);
    $("send-frames").textContent =
      `${n} frame${n === 1 ? "" : "s"}${cells > 1 ? ` · ${perRow}×${perRow}` : ""} · ${readableThroughput(throughput.throughput)} sent`;
  };
  await e.session.start(async (frame) => {
    dataStart ??= performance.now();
    n++;
    throughput.frame(frame);
    toFilm.frame(readMetaByMajority(frame).symbolCount);
    if (cells === 1) {
      if (n > 1 && (n - 1) % CODE_REPEAT === 0) await view.show(codeFrame(), CODEC.COLOR_4, 1);
      updateHud();
      await view.show(frame, undefined, 1);
      return;
    }
    // Mosaic: the session produces the frames one by one; they are held until a
    // batch is full (one cell kept for the init code every third batch), then
    // the whole batch is displayed at once.
    batch.push(frame);
    const withCode = batches % BATCH_REPEAT === 0;
    if (batch.length < cells - (withCode ? 1 : 0)) return;
    const shown = withCode ? [codeFrame(), ...batch] : batch;
    batch = [];
    batches++;
    updateHud();
    await view.showBatch(shown, perRow, 1);
  });
}

/**
 * "To film" gauge (a mark for whoever films in slow motion): symbols sent /
 * symbols suggested for a perfect reading. `null`: no data yet.
 */
function updateGauge(toFilm: FilmingGauge | null, start: number | null = null): void {
  const bar = $("send-gauge");
  const text = $("send-gauge-text");
  const progressBar = $("send-progress");
  if (!toFilm) {
    bar.className = "scroll";
    bar.style.width = "";
    progressBar.classList.remove("enough");
    text.textContent = "The phone tells you when it's done: there is no return channel.";
    return;
  }
  const pct = Math.round(toFilm.share * 100);
  const stopwatch = clock(start === null ? 0 : (performance.now() - start) / 1000);
  bar.className = "fill";
  bar.style.width = `${toFilm.enough ? 100 : pct}%`;
  progressBar.classList.toggle("enough", toFilm.enough);
  text.textContent = toFilm.enough
    ? `✓ Enough sent · ⏱ ${stopwatch} — for a perfect read; the phone says if more is needed. Keep it running, don't restart.`
    : `To film ${pct}% · ⏱ ${stopwatch} — minimum, if everything is read from the start. Don't stop it, don't restart it.`;
}

function updateSendingMode(module = sending?.view?.pixelsPerModule, grids = columns): void {
  const codec = sending?.session.codec ?? CODEC.COLOR_8;
  // Actual rendering of the modules: alert if too small for quality or speed.
  if (module) moduleAlert("send-alert", module, grids);
  else $("send-alert").hidden = true;
  $("send-mode").textContent = `${tmName(codec)} · ${period} ms / subframe${module ? ` · ${module} px / module` : ""}`;
  $("switch-tm4").hidden = codec === CODEC.COLOR_4;
}

$("switch-tm4").addEventListener("click", () => {
  sending?.session.setCodec(CODEC.COLOR_4);
  updateSendingMode();
  note("manual fallback to TM4.");
});
$("stop-send").addEventListener("click", () => {
  note("sending stopped.");
  stopSending();
});

function stopSending(): void {
  const e = sending;
  sending = null;
  if (e) {
    e.reader?.close();
    if (e.stream) closeCamera(e.stream);
    e.initPayload.stop();
    e.view?.stop();
    try {
      e.session.cancel();
    } catch {
      // already finished
    }
    e.session.dispose();
  }
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  showView("home-screen");
}

// ── Receiving ─────────────────────────────────────────────────────────────

let reception: {
  session: ReceiverSession;
  stream: MediaStream;
  reader: TmReader;
  /**
   * code → response (reply shown) → reveal (camera back on the sender, waiting
   * for its reveal code) → sas (codes compared) → data; or code → passphrase → data.
   */
  phase: "code" | "response" | "reveal" | "sas" | "passphrase" | "data" | "done";
  info?: InitCodeInfo;
  /** Payload of the init code: to reopen a session with another passphrase. */
  initCodePayload?: Uint8Array;
  /** Frames rejected by the session, per reason (decryption, replay…). */
  rejections: Record<string, number>;
  acceptedCount: number;
  display?: TmDisplay;
  tracker?: TransferTracker;
  lastCodec?: Codec;
  file: Promise<void>;
  /**
   * Data frames that arrived BEFORE the code confirmation (a video holds the
   * whole recording at once): replayed at the confirmation.
   */
  queued: { bytes: Uint8Array; codec: Codec }[];
  /** Video reading in progress. */
  video?: AbortController;
  /** Browser filming (MediaRecorder) in progress. */
  recording?: Recording;
  /** Direct (page camera) or slow motion (video filmed, then read). */
  mode: "live" | "slowmo";
  /** DISTINCT valid frames read for this sending, all sources combined. */
  readCount: number;
  /** Slow motion: filmed seconds of the videos already read, position in the current video. */
  filmedSeconds: number;
  videoPosition: number;
} | null = null;
let received: (TransferredFile & { frames: number; duration: number; codec: Codec }) | null = null;

$("receive").addEventListener("click", () => void openReception().catch((e) => reportError(e)));
$("close-capture").addEventListener("click", () => closeReception());

// ── SLOW-MOTION reception ─────────────────────────────────────────────────
// Two exclusive modes:
//   DIRECT — the page camera reads the screen in real time (overlay, advice);
//   SLOW   — the page camera is CLOSED; the app films the sending (APK: native
//            screen at 240 fps; browser: recorded camera stream), then reads
//            the video image by image, outside real time. The sender can then
//            go down to 17 or 33 ms per subframe.
// The chosen mode is remembered from one reception to the next.

const MODE_KEY = "optirelay.receiveMode";
/** Key and values of earlier versions ("direct" / "ralenti"), migrated once. */
const LEGACY_MODE_KEY = "optirelay.modeReception";

function savedMode(): "live" | "slowmo" {
  try {
    let mode = localStorage.getItem(MODE_KEY);
    const legacy = localStorage.getItem(LEGACY_MODE_KEY);
    if (mode === null && legacy !== null) {
      mode = legacy === "ralenti" ? "slowmo" : "live";
      localStorage.setItem(MODE_KEY, mode);
    }
    if (legacy !== null) localStorage.removeItem(LEGACY_MODE_KEY);
    return mode === "slowmo" ? "slowmo" : "live";
  } catch {
    return "live";
  }
}

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#modes-capture button"))) {
  b.addEventListener("click", () => void setMode(b.dataset.mode as "live" | "slowmo").catch((e) => reportError(e)));
}

function showMode(mode: "live" | "slowmo"): void {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#modes-capture button"))) {
    b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  }
  $("slowmo-panel").hidden = mode !== "slowmo";
  $("capture-overlay").hidden = mode === "slowmo";
  (document.querySelector(".zone-advice") as HTMLElement).hidden = mode === "slowmo";
}

async function setMode(mode: "live" | "slowmo"): Promise<void> {
  const rec = reception;
  if (!rec || rec.mode === mode || rec.video || rec.recording) return;
  rec.mode = mode;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // storage unavailable: the mode is simply not remembered
  }
  showMode(mode);
  if (mode === "slowmo") {
    rec.reader.stop();
    // APK: the sensor will be taken by the native screen; release it right now.
    if (nativeSlowMotionAvailable()) await releaseCamera(rec.stream);
    setSlowMotionPanel("ready");
    note("slow-mo mode: page camera closed.");
  } else {
    await reopenCamera(rec);
    note("live mode: camera reopened.");
  }
}

/** State of the slow-motion panel: ready to film, or reading in progress. */
function setSlowMotionPanel(state: "ready" | "reading", message?: string): void {
  $("slowmo-ready").hidden = state !== "ready";
  $("slowmo-reading").hidden = state !== "reading";
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#modes-capture button"))) b.disabled = state === "reading";
  if (message !== undefined) $("video-state").textContent = message;
}

$<HTMLInputElement>("video-import").addEventListener("change", (e) => {
  const field = e.target as HTMLInputElement;
  const file = field.files?.[0];
  field.value = "";
  if (file) void readVideo(file, file.name);
});

$("film-video").addEventListener("click", () => void film().catch((e) => setSlowMotionPanel("ready", `Filming failed: ${(e as Error).message}`)));
$("slowmo-cancel").addEventListener("click", () => reception?.video?.abort());

/**
 * The app films ITSELF, then reads the video. APK: native camera screen in
 * slow motion (240 fps), which hands back at the end. Browser: the camera
 * stream is recorded — one tap to start, one to finish.
 */
async function film(): Promise<void> {
  const rec = reception;
  if (!rec || rec.video) return;
  const button = $<HTMLButtonElement>("film-video");
  if (nativeSlowMotionAvailable()) {
    setSlowMotionPanel("ready", "Opening the slow-mo camera…");
    let v;
    try {
      v = await filmSlowMotion(30, rec.stream);
    } catch (e) {
      setSlowMotionPanel("ready", (e as Error).message);
      return;
    }
    note(`slow-mo filmed: ${v.width}×${v.height} at ${v.frameRate} fps.`);
    if (reception === rec) await readVideo(v.video, `slow-mo ${v.frameRate} fps`);
    return;
  }
  // Browser: the page camera is needed to film.
  if (rec.recording) {
    rec.recording.stop();
    return;
  }
  if (rec.stream.getVideoTracks().every((p) => p.readyState === "ended")) await reopenCamera(rec, false);
  const recording = filmStream(rec.stream, 30);
  rec.recording = recording;
  button.textContent = "Finish filming";
  $("slowmo-panel").classList.add("transparent");
  const r = rec.stream.getVideoTracks()[0]?.getSettings();
  setSlowMotionPanel("ready", `● Recording at ${r?.frameRate ? Math.round(r.frameRate) : "?"} fps — stop when the sender shows “Enough sent”.`);
  try {
    const v = await recording.result;
    if (reception === rec) await readVideo(v.video, `recording ${v.frameRate ? Math.round(v.frameRate) : "?"} fps`);
  } finally {
    rec.recording = undefined;
    button.textContent = "Film";
  }
}

/**
 * After an incomplete video: share of the file received and duration STILL
 * to film, at the rate this video actually gave (useful symbols per filmed
 * second), with the fountain code margin (≈ 15 %).
 */
function leftToFilm(
  rec: NonNullable<typeof reception>,
  symbolsBefore: number,
  duration: number,
  freshFrames: number,
  states: { t: number; e: SendState }[] = [],
  firstGrid = 0,
): string {
  const kTotal = rec.info?.kTotal ?? 0;
  const receivedList = rec.session.progress().receivedSymbols;
  if (!kTotal) return `Video read: ${freshFrames} useful frame(s). Some are still missing — film again.`;
  // REAL progress, block by block (same rule as the native app, bilan_blocs):
  // the file is only complete when ALL blocks are; the lagging block gets its
  // share like the others, so count × its shortfall is needed.
  const blockList = rec.session.blocks();
  const acquired = blockList.reduce((s, b) => s + (b.complete ? b.k : Math.min(b.received, 0.95 * b.k)), 0);
  const blockKs = blockList.reduce((s, b) => s + b.k, 0) || kTotal;
  const part = Math.min(99, Math.round((100 * acquired) / blockKs));
  const complete = blockList.filter((b) => b.complete).length;
  const blockStates = blockList.length > 1 ? ` (${complete}/${blockList.length} blocks complete)` : "";
  const worst = blockList.filter((b) => !b.complete).reduce((m, b) => Math.max(m, Math.max(1.1 * b.k - b.received, 0.05 * b.k)), 0);
  const fresh = Math.max(0, receivedList - symbolsBefore);
  let rate = duration > 0 ? fresh / duration : 0;
  // Synced to the SENDER CLOCK (send states read in the video): the share of
  // the sending covered that this phone actually read tells how much to film
  // — the sender's gauge assumes a perfect reading.
  let offset = "";
  if (states.length) {
    const first = states[0]!;
    const last = states[states.length - 1]!;
    const start = first.e.t / 1000 + (firstGrid - first.t);
    const end = last.e.t / 1000 + (duration - last.t);
    offset = `This video covers the sending from ${clock(start)} to ${clock(end)} (sender's counter)`;
    const dt = (last.e.t - first.e.t) / 1000;
    if (dt > 1 && last.e.sentSymbols > first.e.sentSymbols && end > Math.max(start, 0)) {
      const sendThroughput = (last.e.sentSymbols - first.e.sentSymbols) / dt;
      const efficiency = Math.min(1, fresh / Math.max(1, sendThroughput * (end - Math.max(start, 0))));
      rate = sendThroughput * efficiency;
      offset += `; the phone read ≈ ${Math.round(100 * efficiency)}% of the symbols sent — the sender's “To film” gauge assumes 100%`;
    }
    offset += ". ";
  }
  const missing = blockList.length ? worst * blockList.length : Math.max(0, kTotal * 1.15 - receivedList);
  if (rate <= 0) return `${offset}Received ≈ ${part}% of the file${blockStates}, but nothing new in this video: aim at the current sending.`;
  return `${offset}Received ≈ ${part}% of the file${blockStates}. Keep the sending running (same code) and film ≈ ${readableDuration(missing / rate)} more.`;
}

/** Page camera reopened (back to direct mode, or the rest of the reception). */
async function reopenCamera(rec: NonNullable<typeof reception>, read = true): Promise<void> {
  clearFraming();
  if (rec.stream.getVideoTracks().some((p) => p.readyState === "live")) {
    rec.reader.reset(); // the geometry from before the film is stale
    if (read && !rec.video) rec.reader.start();
    return;
  }
  const stream = await openCamera({ rearFacing: true });
  if (reception !== rec) return closeCamera(stream);
  rec.stream = stream;
  // New stream: its own white balance + exposure lock, geometry forgotten.
  rec.reader.setStream(stream);
  $("lock-chip").hidden = true;
  const video = $<HTMLVideoElement>("video-capture");
  video.srcObject = stream;
  await video.play();
  if (read && !rec.video && (rec.phase === "code" || rec.phase === "reveal" || rec.phase === "data")) rec.reader.start();
}

/** Reads a video (filmed or imported): its frames go to the same reception. */
/**
 * Delay (s of video, since the first grid seen) to read the init code: the
 * bench shows it in a loop during the countdown, then repeats it in the
 * stream. Past this delay, the rest will not be better — no point computing
 * minutes for nothing (same rule as the native app, orp-transfer CODE_TIMEOUT).
 */
const CODE_DELAY = 6;
const CODE_NOT_READ_MESSAGE =
  "Initialization code not read in the first seconds: reading stopped. Likely causes: the start of the sending " +
  "was not filmed, or the subframe is too short for this screen (at 17 ms, an LCD screen never settles the grey) — " +
  "try 33 ms, or bring the phone closer.";

async function readVideo(file: Blob | EncodedVideo, name: string): Promise<void> {
  const rec = reception;
  if (!rec) return;
  rec.video?.abort();
  const control = new AbortController();
  rec.video = control;
  rec.reader.stop(); // the computation for the video alone
  await releaseCamera(rec.stream); // nothing open during the reading: the computation for it alone
  $("slowmo-panel").classList.remove("transparent");
  $("slowmo-title").textContent = `Reading video (${name})`;
  $("slowmo-fill").style.width = "0%";
  $("slowmo-detail").textContent = "Decoding…";
  setSlowMotionPanel("reading", "");
  note(`video to read: ${name}${file instanceof Blob ? ` (${readableSize(file.size)})` : ""}.`);
  const before = rec.acceptedCount;
  const symbolsBefore = rec.phase === "data" ? rec.session.progress().receivedSymbols : 0;
  let firstGrid: number | null = null;
  let abandonedCode = false;
  const states: { t: number; e: SendState }[] = [];
  try {
    const end = await readTmVideo(file, {
      signal: control.signal,
      onFrame: (bytes, codec, t) => {
        const state = readSendState(bytes);
        if (state && (!states.length || states[states.length - 1]!.e.sentSymbols !== state.sentSymbols)) states.push({ t, e: state });
        rec.file = rec.file.then(() => frameReceived(bytes, codec)).catch((e) => note(`frame: ${(e as Error).message}`));
      },
      onProgress: (p) => {
        const pct = Math.min(100, Math.round((100 * p.position) / (p.duration || 1)));
        $("slowmo-fill").style.width = `${pct}%`;
        $("slowmo-bar").setAttribute("aria-valuenow", String(pct));
        $("slowmo-detail").textContent = `${pct}% · ${p.images} images analyzed · ${p.grids} grid(s) seen · ${p.valid} valid frames`;
        rec.videoPosition = p.position;
        if (p.grids > 0 && firstGrid === null) firstGrid = p.position;
        if (rec.phase === "code" && firstGrid !== null && p.position - firstGrid > CODE_DELAY) {
          abandonedCode = true;
          note(`initialization code not read after ${CODE_DELAY} s of grid: reading stopped.`);
          control.abort();
        }
      },
    });
    await rec.file;
    rec.filmedSeconds += end.duration;
    rec.videoPosition = 0;
    note(`video read: ${end.images} images, ${end.valid} valid frames, ${end.msPerImage.toFixed(1)} ms/image.`);
    if (reception !== rec || rec.phase === "done") return; // file complete: the "received" view has taken over
    const freshFrames = rec.acceptedCount - before;
    const message =
      end.images === 0 || end.valid === 0
        ? "No frames read in this video: was the sending screen in frame, sharp, at 17 or 33 ms?"
        : rec.phase === "data"
          ? leftToFilm(rec, symbolsBefore, end.duration, freshFrames, states, firstGrid ?? 0)
          : rec.phase === "code"
            ? CODE_NOT_READ_MESSAGE
            : "Video read — compare the verification code.";
    setSlowMotionPanel("ready", message);
  } catch (e) {
    setSlowMotionPanel(
      "ready",
      abandonedCode ? CODE_NOT_READ_MESSAGE : (e as Error).name === "AbortError" ? "Reading cancelled." : `Reading failed: ${(e as Error).message}`,
    );
  } finally {
    rec.videoPosition = 0;
    if (rec.video === control) rec.video = undefined;
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#modes-capture button"))) b.disabled = false;
    // In direct mode (imported video), the camera resumes.
    if (reception === rec && rec.mode === "live") await reopenCamera(rec).catch(() => undefined);
  }
}

async function openReception(): Promise<void> {
  showView("capture-screen");
  resetSheet();
  clearFraming();
  const stream = await openCamera({ rearFacing: true });
  const video = $<HTMLVideoElement>("video-capture");
  video.srcObject = stream;
  await video.play();
  const session = new ReceiverSession(crypto());
  const reader = new TmReader(video, {
    stream,
    onImage: (r, image, all) => onCaptureImage(r, image, all),
    onFrame: (bytes, codec) => {
      const rec = reception;
      if (!rec) return;
      rec.file = rec.file.then(() => frameReceived(bytes, codec)).catch((e) => note(`frame: ${(e as Error).message}`));
    },
    onLock: (state) => showLock(state),
  });
  reception = { session, stream, reader, phase: "code", file: Promise.resolve(), rejections: {}, acceptedCount: 0, queued: [], mode: "live", readCount: 0, filmedSeconds: 0, videoPosition: 0 };
  trackRejections(reception);
  showMode("live");
  setSlowMotionPanel("ready", "");
  if (savedMode() === "slowmo") {
    await setMode("slowmo");
    return;
  }
  reader.start();
  note("camera open — waiting for the initialization code.");
}

function showLock(state: LockState): void {
  note(`camera lock: ${state.notes.join(" · ")}`);
  if (!state.whiteBalance && !state.exposure) return;
  $("lock-chip").hidden = false;
  $("lock-chip-text").textContent = state.whiteBalance && state.exposure ? "White balance + exposure locked" : state.whiteBalance ? "White balance locked" : "Exposure locked";
}

function onCaptureImage(r: TmImageResult, image: ImageRGBA, all: readonly TmImageResult[]): void {
  const smoothed = drawOverlay($<HTMLCanvasElement>("capture-overlay"), $<HTMLVideoElement>("video-capture"), r, image, all);
  const advice = $("advice");
  const ok = smoothed === "";
  advice.classList.toggle("ok", ok);
  advice.textContent = ok ? "Framing OK. Hold still." : smoothed;
}

const INITIAL_ADVICE = "Aim at the screen: keep the three large corner squares in the frame.";

/** Blank overlay and advice: nothing from the previous image (other camera, other film). */
function clearFraming(): void {
  const overlay = $<HTMLCanvasElement>("capture-overlay");
  overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  const advice = $("advice");
  advice.classList.remove("ok");
  advice.textContent = INITIAL_ADVICE;
}

/** Bottom sheet reset: new reception, or new sending detected. */
function resetSheet(): void {
  updateSheet("Reading the sender's code", null);
  $("capture-detail").textContent = "";
  $("capture-frames").textContent = "0";
  $("capture-throughput").textContent = "—";
  $("capture-mode").textContent = "—";
  $("capture-sas").textContent = "— —";
  $("capture-sas-line").hidden = true;
  $("capture-denied").hidden = true;
  $("capture-denied").textContent = "";
}

/**
 * Init code of ANOTHER session than `current`: different session identifier
 * (first 16 bytes), and plausible content — a response frame, which carries
 * the same identifier, does not pass.
 */
function isOtherSending(payload: Uint8Array, current: Uint8Array): boolean {
  if (pairingCodeKind(payload) !== "init") return false; // a reveal code of the same sending
  try {
    const next = readInitCode(payload);
    const now = readInitCode(current);
    return !next.sessionId.every((x, i) => x === now.sessionId[i]);
  } catch {
    return false;
  }
}

/**
 * ANOTHER init code during the reception: the sender started a new sending
 * (other file, other session). The old session would decrypt none of its
 * frames: start over from scratch on this code.
 */
async function newSending(rec: NonNullable<typeof reception>, bytes: Uint8Array, codec: Codec): Promise<void> {
  note("new sending detected (different initialization code): receiving restarts from scratch.");
  rec.session.dispose();
  rec.session = new ReceiverSession(crypto());
  Object.assign(rec, {
    phase: "code", info: undefined, initCodePayload: undefined, tracker: undefined, lastCodec: undefined,
    rejections: {}, acceptedCount: 0, readCount: 0, queued: [], filmedSeconds: 0, videoPosition: 0,
  });
  trackRejections(rec);
  rec.reader.reset();
  resetSheet();
  await frameReceived(bytes, codec);
}

async function frameReceived(bytes: Uint8Array, codec: Codec): Promise<void> {
  const rec = reception;
  if (!rec) return;
  const pairing = isPairingFrame(bytes);
  if (!pairing) {
    $("capture-mode").textContent = tmName(codec);
    rec.readCount++;
    $("capture-frames").textContent = String(rec.readCount);
  }
  if (rec.phase === "code") {
    const payload = pairingPayload(bytes, INIT_CODE_SIZE);
    if (!payload || pairingCodeKind(payload) !== "init") return;
    rec.info = rec.session.scanInitCode(payload);
    rec.tracker = new TransferTracker(rec.info.streamSize, rec.info.kTotal);
    rec.initCodePayload = payload;
    if (rec.info.byPassphrase) {
      // The sender (test bench, or device without a camera) waits for no
      // response code: answering it would give keys it does not have, hence
      // different codes and undecryptable frames (§7.2). Try the bench
      // passphrase first: only one code remains to compare.
      rec.phase = "passphrase";
      rec.reader.stop();
      await pairByPassphrase(rec, BENCH_PASSPHRASE);
      showView("phrase-screen");
      note(`initialization code read (sender without a camera): ${readableSize(rec.info.streamSize)} announced.`);
      return;
    }
    const response = await rec.session.responseCode();
    rec.phase = "response";
    rec.reader.stop();
    const display = new TmDisplay($<HTMLCanvasElement>("response-canvas"), { moduleSize: 10 });
    display.loop(pairingFrame(response), CODEC.COLOR_4);
    rec.display = display;
    responseStep("reply");
    showView("response-screen");
    note(`initialization code read: ${readableSize(rec.info.streamSize)} announced.`);
    return;
  }
  if (pairing && (rec.phase === "response" || rec.phase === "reveal")) {
    // ORP v0.2: the sender's reveal code (its key, committed in the init code)
    // gives the keys and the verification code. Another code: ignored.
    const payload = pairingPayload(bytes, REVEAL_CODE_SIZE);
    if (!payload || pairingCodeKind(payload) !== "reveal") return;
    try {
      await rec.session.receiveRevealCode(payload);
    } catch (err) {
      note(`reveal code refused: ${(err as Error).message}`);
      return;
    }
    rec.phase = "sas";
    rec.reader.stop();
    $("receiver-sas").textContent = sas(rec.session.sas());
    $("capture-sas").textContent = sas(rec.session.sas());
    responseStep("compare");
    showView("response-screen");
    $("confirm-receive").focus();
    note("sender's reveal code read — verification code shown.");
    return;
  }
  if (pairing) {
    // The init code comes back within the stream: the same one is ignored;
    // another one means a new sending.
    const payload = pairingPayload(bytes, INIT_CODE_SIZE);
    if (rec.phase === "data" && payload && rec.initCodePayload && isOtherSending(payload, rec.initCodePayload)) {
      await newSending(rec, bytes, codec);
    }
    return;
  }
  if (rec.phase === "response" || rec.phase === "reveal" || rec.phase === "sas" || rec.phase === "passphrase") {
    if (rec.queued.length < 20000) rec.queued.push({ bytes, codec });
    return;
  }
  if (rec.phase !== "data") return;
  rec.lastCodec = codec;
  try {
    const status = await rec.session.receiveFrame(bytes);
    if (!status.accepted) return; // counted by trackRejections
    rec.acceptedCount++;
    $("capture-denied").hidden = true;
  } catch (e) {
    note(`frame rejected: ${(e as Error).message}`);
    return;
  }
  const p = rec.session.progress();
  rec.tracker?.start();
  updateProgress(rec);
  if (!rec.session.done) return;

  rec.phase = "done";
  updateSheet("Verifying fingerprint…", 100);
  const result = await rec.session.result();
  if (!result.verified) {
    note("receiving rejected: the fingerprint does not match (F-09).");
    closeReception();
    return;
  }
  received = {
    ...unpack(result.data),
    frames: p.receivedFrames,
    duration: rec.tracker?.state(p.receivedSymbols, true).elapsed ?? 0,
    codec: rec.lastCodec ?? codec,
  };
  closeReception(false);
  showReceived();
}

/**
 * Progress, bytes received / announced, useful throughput and remaining time.
 * In slow motion, throughput and remaining time count in FILMED time: the
 * computation clock (filming, reading outside real time) says nothing about
 * the channel.
 */
function updateProgress(rec: NonNullable<typeof reception>): void {
  const tracker = rec.tracker;
  if (!tracker) return;
  const done = rec.session.done;
  const e = tracker.state(rec.session.progress().receivedSymbols, done);
  // Never 100 % while a block is missing: a total of symbols ≥ K says nothing
  // about the lagging block.
  const blockList = rec.session.blocks();
  const complete = blockList.filter((b) => b.complete).length;
  const progress = done ? 1 : Math.min(0.99, e.progress);
  updateSheet(blockList.length > 1 && !done ? `Receiving · ${complete}/${blockList.length} blocks` : "Receiving", Math.floor(progress * 100));
  let throughput = e.throughput;
  let remaining = ` · ≈ ${readableDuration(e.remaining)} left`;
  if (rec.mode === "slowmo" || rec.video) {
    const filmed = rec.filmedSeconds + rec.videoPosition;
    throughput = filmed > 0.2 ? e.usefulBytes / filmed : 0;
    remaining = throughput > 0 ? ` · ≈ ${readableDuration((e.totalBytes - e.usefulBytes) / throughput)} more to film` : "";
  }
  $("capture-detail").textContent = `${readableSize(e.usefulBytes)} / ${readableSize(e.totalBytes)}` + (done ? "" : remaining);
  $("capture-throughput").textContent = throughput > 0 ? readableThroughput(throughput) : "—";
}

function updateSheet(title: string, percent: number | null): void {
  $("capture-sheet-title").textContent = title;
  $("capture-percent").hidden = percent === null;
  $("capture-bar").hidden = percent === null;
  $("capture-detail").hidden = percent === null;
  if (percent !== null) {
    $("capture-percent").textContent = `${percent}%`;
    $("capture-bar").setAttribute("aria-valuenow", String(percent));
    $("capture-fill").style.width = `${percent}%`;
  }
}

/**
 * Pairing by passphrase (§7.2). A session only pairs once: for another
 * passphrase, a fresh one is reopened on the same init code.
 */
async function pairByPassphrase(rec: NonNullable<typeof reception>, passphrase: string): Promise<void> {
  if (rec.session.state !== "appairage") {
    rec.session.dispose();
    rec.session = new ReceiverSession(crypto());
    trackRejections(rec);
    rec.session.scanInitCode(rec.initCodePayload!);
  }
  await rec.session.pairWithPassphrase(passphrase);
  $("sas-phrase").textContent = sas(rec.session.sas());
  $("capture-sas").textContent = sas(rec.session.sas());
  $("phrase-sas").hidden = false;
  $("form-phrase").hidden = true;
  $("phrase-error").hidden = true;
  $("confirm-phrase").focus();
}

/**
 * OptiRelay Studio and the Secure Hello world example show a 12-character
 * code, grouped for the eyes ("K7QF-M2XP-9CHR"); their passphrase is the code
 * itself, upper case, without separators. Typed with dashes, spaces or in
 * lower case, such a code is brought back to that form — any other
 * passphrase is taken exactly as typed.
 */
const SHOWN_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/;
function typedPassphrase(typed: string): string {
  const passphrase = typed.trim();
  const code = passphrase.toUpperCase().replace(/[\s-]/g, "");
  return SHOWN_CODE.test(code) ? code : passphrase;
}

$("form-phrase").addEventListener("submit", (e) => {
  e.preventDefault();
  const rec = reception;
  if (!rec || rec.phase !== "passphrase") return;
  void pairByPassphrase(rec, typedPassphrase($<HTMLInputElement>("phrase").value)).catch((err) => {
    $("phrase-error").textContent = (err as Error).message;
    $("phrase-error").hidden = false;
  });
});
$("confirm-phrase").addEventListener("click", () => receiveData());
$("decline-phrase").addEventListener("click", () => {
  // Different codes: the sender is not the bench, it has its own passphrase.
  $("phrase-sas").hidden = true;
  $("form-phrase").hidden = false;
  $<HTMLInputElement>("phrase").value = "";
  $("phrase").focus();
});
$("cancel-phrase").addEventListener("click", () => {
  note("passphrase pairing cancelled.");
  closeReception();
});

/** Displayed labels of the session rejection reasons (core, "rejection" event); the keys are frozen values. */
const REJECTION_LABELS: Record<string, string> = {
  corrompue: "corrupted",
  invalide: "invalid",
  version: "wrong version",
  falsifiee: "tampered",
};

/** Counts the frames rejected by the session: a rejection is never silent any more. */
function trackRejections(rec: NonNullable<typeof reception>): void {
  rec.session.events.on("rejection", ({ reason }) => {
    if (reason === "rejeu") return; // duplicate already counted: normal
    rec.rejections[reason] = (rec.rejections[reason] ?? 0) + 1;
    const forgedCount = rec.rejections["falsifiee"] ?? 0;
    const el = $("capture-denied");
    if (forgedCount >= 5 && rec.acceptedCount === 0) {
      el.textContent = `${forgedCount} frames read but impossible to decrypt: the two devices' keys do not match (different codes). Close and restart pairing.`;
      el.hidden = false;
      if (forgedCount === 5) note("undecryptable frames: keys differ on the two sides.");
    } else if (Object.keys(rec.rejections).length > 0) {
      el.textContent = `Rejected frames: ${Object.entries(rec.rejections).map(([m, n]) => `${n} ${REJECTION_LABELS[m] ?? m}`).join(", ")}`;
      el.hidden = false;
    }
  });
}

$("confirm-receive").addEventListener("click", () => receiveData());

/** Response screen: "reply" (code shown to the webcam) then "compare" (verification codes). */
function responseStep(step: "reply" | "compare"): void {
  $("response-reply").hidden = step !== "reply";
  $("response-compare").hidden = step !== "compare";
  $("response-title").textContent = step === "reply" ? "Show this screen to the sender's webcam" : "Compare the verification codes";
}

$("read-reveal").addEventListener("click", () => {
  const rec = reception;
  if (!rec || rec.phase !== "response") return;
  rec.display?.stop();
  rec.phase = "reveal";
  updateSheet("Aim at the sender's screen: reading its verification code", null);
  showView("capture-screen");
  if (rec.mode === "live") void reopenCamera(rec).catch((e) => note(`camera: ${(e as Error).message}`));
  note("reply shown — reading the sender's reveal code.");
});

/** After the SAS code is confirmed (strong path or passphrase): data reception. */
function receiveData(): void {
  const rec = reception;
  if (!rec) return;
  rec.session.confirmSas();
  rec.display?.stop();
  rec.phase = "data";
  $("capture-sas-line").hidden = false;
  rec.reader.resetReceiver();
  updateSheet(rec.mode === "slowmo" ? "Film the sending" : "Aim at the sender's screen", 0);
  $("capture-detail").textContent = "";
  showView("capture-screen");
  // Frames read before the confirmation (imported video): replayed in order.
  const pending = rec.queued.splice(0);
  for (const t of pending) rec.file = rec.file.then(() => frameReceived(t.bytes, t.codec)).catch((e) => note(`frame: ${(e as Error).message}`));
  if (pending.length) note(`${pending.length} frame(s) read before confirmation, replayed.`);
  // Direct mode: the camera (re)starts reading. Slow-motion mode: nothing
  // opens — the rest is filmed, or the video being read goes on.
  if (rec.mode === "live") void reopenCamera(rec).catch((e) => note(`camera: ${(e as Error).message}`));
  note("verification code confirmed — receiving data.");
}
$("decline-receive").addEventListener("click", () => {
  note("verification codes differ: receiving cancelled.");
  closeReception();
});

function closeReception(backToHome = true): void {
  const rec = reception;
  reception = null;
  if (rec) {
    rec.video?.abort();
    rec.recording?.stop();
    rec.reader.close();
    rec.display?.stop();
    closeCamera(rec.stream);
    rec.session.dispose();
  }
  $("lock-chip").hidden = true;
  resetSheet();
  clearFraming();
  if (backToHome) showView("home-screen");
}

// ── File received: no opening, no automatic import ────────────────────────

let preview: Preview | null = null;

function releasePreview(): void {
  preview?.release();
  preview = null;
}

function showReceived(): void {
  if (!received) return;
  // Preview IN PLACE: nothing is opened in another application.
  releasePreview();
  preview = createPreview(received);
  $("received-preview-frame").replaceChildren(preview.element);
  ($("enlarge") as HTMLButtonElement).hidden = !preview.enlargeable;
  $("copy").hidden = preview.text === null || !navigator.clipboard;
  const button = $<HTMLButtonElement>("save");
  button.disabled = false;
  button.textContent = "Save";
  $("received-status").hidden = true;
  $("received-name").textContent = received.name;
  $("received-detail").textContent = `${readableSize(received.data.length)} · ${received.type}`;
  $("received-frames").textContent = String(received.frames);
  $("received-duration").textContent = readableDuration(received.duration);
  $("received-throughput").textContent = received.duration > 0 ? readableThroughput(received.data.length / received.duration) : "—";
  $("received-mode").textContent = tmName(received.codec);
  const sharedFile = new File([received.data as BlobPart], received.name, { type: received.type });
  $("share").hidden = !(navigator.canShare?.({ files: [sharedFile] }) ?? false);
  showView("received-screen");
  note(`received and verified: ${received.name}, ${readableSize(received.data.length)}.`);
}

$("save").addEventListener("click", () => {
  if (!received) return;
  const result = saveFile(received);
  note(result.message);
  // The result is VISIBLE: without it, people clicked again and the file went
  // into Downloads several times.
  const status = $("received-status");
  status.textContent = result.message;
  status.classList.toggle("failed", !result.ok);
  status.hidden = false;
  if (result.ok) {
    const button = $<HTMLButtonElement>("save");
    button.textContent = "Saved ✓";
    button.disabled = true;
  }
});

const dialog = $<HTMLDialogElement>("preview-dialog");
$("enlarge").addEventListener("click", () => {
  if (!received) return;
  const large = createPreview(received, true);
  $("dialog-title").textContent = received.name;
  $("dialog-body").replaceChildren(large.element);
  dialog.showModal();
  dialog.addEventListener("close", () => large.release(), { once: true });
});
$("close-preview").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
$("copy").addEventListener("click", () => {
  const text = preview?.text;
  if (!text) return;
  void navigator.clipboard.writeText(text).then(
    () => {
      $("received-status").textContent = `Text copied (${text.length} characters).`;
      $("received-status").classList.remove("failed");
      $("received-status").hidden = false;
    },
    () => undefined,
  );
});

$("share").addEventListener("click", () => {
  if (!received) return;
  void navigator.share({ files: [new File([received.data as BlobPart], received.name, { type: received.type })] }).catch(() => undefined);
});

// ── Android BACK key ──────────────────────────────────────────────────────
// MainActivity hands it to the page first: each view closes as through its
// own button (Cancel, Stop, Close). True if the page handled it; false at
// home — Android then quits normally.

declare global {
  interface Window {
    __optirelayBack?: () => boolean;
  }
}

const BACK_BY_BUTTON: Partial<Record<View, string>> = {
  "pairing-screen": "cancel-pairing",
  "send-screen": "stop-send",
  "phrase-screen": "cancel-phrase",
  "response-screen": "decline-receive",
};

window.__optirelayBack = (): boolean => {
  if (drawer.open) {
    closeDrawer();
    return true;
  }
  const dialog = $<HTMLDialogElement>("preview-dialog");
  if (dialog.open) {
    dialog.close();
    return true;
  }
  if (!$("log").hidden) {
    $("log-button").click();
    return true;
  }
  const view = VIEWS.find((id) => !$(id).hidden);
  // Secondary destination of the bottom bar: back to the first one (Receive).
  if (view === "home-screen" && $("home-screen").dataset.tab === "send") {
    chooseTab("receive");
    return true;
  }
  if (view === "capture-screen") {
    if (reception?.video) reception.video.abort(); // the reading in progress first
    else if (reception?.recording) reception.recording.stop();
    else closeReception();
    return true;
  }
  if (view === "received-screen") {
    showView("home-screen"); // the received file stays in memory until the next one
    return true;
  }
  const button = view && BACK_BY_BUTTON[view];
  if (button) {
    $(button).click();
    return true;
  }
  return false;
};

$("delete").addEventListener("click", () => {
  received = null;
  releasePreview();
  $("received-preview-frame").replaceChildren();
  note("received file deleted from memory.");
  showView("home-screen");
});

// ── Errors and service worker ─────────────────────────────────────────────

function reportError(e: unknown): void {
  const message = (e as { advice?: string; message?: string }).advice
    ? `${(e as Error).message} ${(e as { advice: string }).advice}`
    : (e as Error).message ?? String(e);
  note(`error: ${message}`);
  $("alert-text").textContent = message;
  $("alert").hidden = false;
}
$("alert-close").addEventListener("click", () => ($("alert").hidden = true));

// Service worker: offline preloading (F-26, D-011) — useless in the Android
// app, which already embeds everything.
if ("serviceWorker" in navigator && import.meta.env.PROD && !IN_ANDROID) {
  void navigator.serviceWorker.register("./sw.js");
}
