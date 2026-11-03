/**
 * OptiRelay test bench — differential temporal modulation TM4 / TM8
 * (REC-05), in two tabs:
 *
 *   DIAGNOSTIC    — frozen frame known on both sides: each R/P pair is
 *                   located, classified, decoded, compared byte by byte,
 *                   accumulated; report over 16 pairs.
 *   TRANSFER TEST — a real file: sending in a centered popup (init code
 *                   interleaved every 10 frames), reception with progress,
 *                   throughput, remaining time, lost frames; on arrival, a
 *                   PREVIEW in place (image, text or bytes), then saving —
 *                   nothing automatic.
 *
 * A single camera: its block moves from one tab to the other, the decoding
 * runs continuously and feeds both.
 *
 * HTML ids, CSS classes and data-* attributes are hooks shared with
 * index.html and style.css.
 */

import {
  CODEC,
  Codec,
  buildFrame,
  CryptoWebCrypto,
  readInitCode,
  readFrame,
  readMetaByMajority,
  mulberry32,
  OrpUnknownSession,
  SenderSession,
  ReceiverSession,
  INIT_CODE_SIZE,
  SYMBOL_SIZE,
  SYMBOL_CAPACITY,
  FRAME_VERSION,
  type InitCodeInfo,
} from "@optirelay/core";
import {
  TM_ALIGNMENT,
  analyzeSubframe,
  applyH,
  RetainedGeometry,
  locateAll,
  TmMosaicReceiver,
  framingAdvice,
  decideTm,
  locateTm,
  measureTmPair,
  TM_DATA_MODULES,
  tmName,
  TM_PALETTE,
  render,
  payloadSubframe,
  referenceSubframe,
  type ImageRGBA,
  type Location,
  type TmMeasurement,
  type TmSubframe,
} from "@optirelay/optical";
import {
  FramingSmoother,
  FilmingGauge,
  filmStream,
  filmSlowMotion,
  readTmVideo,
  nativeSlowMotionAvailable,
  type VideoProgress,
  type Recording,
  type EncodedVideo,
  TmDisplay,
  applyCameraConstraints,
  sensorCapabilities,
  pairingPayload,
  SendThroughput,
  unpack,
  readableThroughput,
  unlockSensor,
  readableDuration,
  pack,
  saveFile,
  isPairingFrame,
  closeCamera,
  listCameras,
  openCamera,
  TransferTracker,
  readableSize,
  pairingFrame,
  lockSensor,
  BENCH_PASSPHRASE,
  createPreview,
  clock,
  type Preview,
  type TransferredFile,
  calibrationCode,
  CALIBRATION_SERIES_DURATION,
  sendCalibrationSeries,
  readCalibrationCode,
  loadCalibration,
  saveCalibration,
  CalibrationMeasurement,
  type TrialResult,
  measureRefreshRate,
  AdaptiveWidth,
  moduleDiagnostic,
} from "@optirelay/browser";

// ── Tools ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const overlay = $<HTMLCanvasElement>("overlay");
const output = $("output");
const loopCell = $<HTMLInputElement>("loop");
if (location.host === "appassets.androidplatform.net") {
  $("app-link").hidden = false;
} else if (location.pathname.includes("/lab/")) {
  // Served by the showcase (/lab/): the site menu stays at the top of the page.
  $("site-nav").hidden = false;
}

// GitHub menu of the header: closes on a click elsewhere or Escape.
for (const menu of document.querySelectorAll<HTMLDetailsElement>(".nav-menu")) {
  document.addEventListener("click", (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menu.open) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
  });
}

function log(line: string): void {
  output.textContent += `\n${line}`;
  output.scrollTop = output.scrollHeight;
  // Also in the console → logcat (tag OptiRelayLab): the workshop reads the bench remotely.
  console.log(`[LAB] ${line}`);
}
const pct = (v: number) => `${(v * 100).toFixed(1)} %`;
const total = (v: number, d = 2) => v.toFixed(d);

/** Group of radio buttons (segments): current value + change callback. */
function segments(id: string, onChange?: (value: string) => void) {
  const group = $(id);
  const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
  const choose = (value: string) => {
    for (const b of buttons) b.setAttribute("aria-checked", String(b.dataset.value === value));
  };
  const wire = (b: HTMLButtonElement) =>
    b.addEventListener("click", () => {
      choose(b.dataset.value!);
      onChange?.(b.dataset.value!);
    });
  buttons.forEach(wire);
  return {
    get value(): string {
      return buttons.find((b) => b.getAttribute("aria-checked") === "true")!.dataset.value!;
    },
    /** A value without a button (calibration code "17-6") gets one. */
    set value(v: string) {
      if (!buttons.some((b) => b.dataset.value === v)) {
        const template = buttons[buttons.length - 1]!;
        const b = template.cloneNode(false) as HTMLButtonElement;
        b.dataset.value = v;
        b.hidden = false;
        const n = Number(v);
        b.textContent = group.id === "mosaics" ? `${n} × ${n}` : v;
        group.append(b);
        buttons.push(b);
        wire(b);
      }
      choose(v);
    },
  };
}

// ── Secure context: WebCrypto and the camera depend on it ─────────────────

const SECURE_CONTEXT = globalThis.isSecureContext !== false && !!globalThis.crypto?.subtle;
if (!SECURE_CONTEXT) {
  const alert = $("alert-context");
  alert.innerHTML =
    "Insecure page: the browser disables encryption and the camera. Only the fixed frame can be shown. " +
    "Open the bench over <code>https://</code> (dev server: accept the local certificate) or via <code>localhost</code> on this machine.";
  alert.hidden = false;
}

function visibleError(id: string, message: string): void {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
  log(message);
}

// ── Tabs ──────────────────────────────────────────────────────────────────

type Tab = "diag" | "transfer";
let activeTab: Tab = "diag";

function chooseTab(tab: Tab, focus = false): void {
  activeTab = tab;
  for (const o of ["diag", "transfer"] as const) {
    const button = $(`tab-${o}`);
    button.setAttribute("aria-selected", String(o === tab));
    button.tabIndex = o === tab ? 0 : -1;
    $(`panel-${o}`).hidden = o !== tab;
  }
  // The camera block follows the active tab.
  $(tab === "diag" ? "slot-diag" : "slot-transfer").appendChild($("camera"));
  if (tab === "transfer") $("arrival-dot").hidden = true;
  if (focus) $(`tab-${tab}`).focus();
}
$("tab-diag").addEventListener("click", () => chooseTab("diag"));
$("tab-transfer").addEventListener("click", () => chooseTab("transfer"));
document.querySelector('[role="tablist"]')!.addEventListener("keydown", (e) => {
  const key = (e as KeyboardEvent).key;
  if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
    e.preventDefault();
    const next: Tab = key === "Home" ? "diag" : key === "End" ? "transfer" : activeTab === "diag" ? "transfer" : "diag";
    chooseTab(next, true);
  }
});
chooseTab("diag");

// ── Frozen frames (content known on both sides) ───────────────────────────

function frozenFrame(codec: Codec): Uint8Array {
  const symbolCount = codec === CODEC.COLOR_8 ? 4 : 2;
  const rng = mulberry32(20261031);
  const payload = Uint8Array.from({ length: symbolCount * SYMBOL_SIZE }, () => Math.floor(rng() * 256));
  return buildFrame(
    { version: FRAME_VERSION, codec, flags: 0, token: 0x4f525031, block: 0, k: 4, symbolCount, seed: 1 },
    payload,
  );
}
const FRAMES: Record<number, Uint8Array> = {
  [CODEC.COLOR_8]: frozenFrame(CODEC.COLOR_8),
  [CODEC.COLOR_4]: frozenFrame(CODEC.COLOR_4),
};

// ── Sending: centered popup (shared by both tabs) ─────────────────────────

const full = $<HTMLDialogElement>("fullscreen");
let display: TmDisplay | null = null;
let benchSending: SenderSession | null = null;

// ── Sending in a separate window (option "New window, full screen") ───────

/**
 * Separate window of the sending in progress, or null (sending in the popup
 * of this page). It shows the grid; this page keeps the "Stop" popup.
 */
let sendWindow: Window | null = null;

/** Document and window the sending is shown in. */
function sendView(): { doc: Document; win: Window } {
  return sendWindow && !sendWindow.closed ? { doc: sendWindow.document, win: sendWindow } : { doc: document, win: window };
}

function toggleWindowFullScreen(doc: Document): void {
  if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => undefined);
  else void doc.documentElement.requestFullscreen?.().catch(() => undefined);
}

/**
 * Opens the sending window over the whole available screen, with the bench
 * style sheets. Called in the click (a browser opens a window only on a
 * gesture). Full screen is asked right away; most browsers refuse it outside
 * a gesture IN that window: then the first click (or F) there grants it.
 * Null if the browser blocks the window.
 */
function openSendWindow(title: string): Window | null {
  const s = screen as Screen & { availLeft?: number; availTop?: number };
  const w = window.open("", "_blank", `popup,left=${s.availLeft ?? 0},top=${s.availTop ?? 0},width=${s.availWidth},height=${s.availHeight}`);
  if (!w) return null;
  const doc = w.document;
  doc.title = `OptiRelay — ${title}`;
  doc.documentElement.lang = "en";
  // Same look as the bench. Absolute URLs: the window is about:blank.
  for (const node of document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')) {
    if (node instanceof HTMLLinkElement) {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = node.href;
      doc.head.append(link);
    } else {
      const style = doc.createElement("style");
      style.textContent = node.textContent;
      doc.head.append(style);
    }
  }
  doc.body.className = "send-window";
  const bar = doc.createElement("div");
  bar.className = "send-window-bar";
  const heading = doc.createElement("h2");
  heading.id = "send-title";
  heading.textContent = title;
  const hint = doc.createElement("span");
  hint.className = "hint";
  hint.textContent = "Click anywhere (or F) for full screen";
  const fullScreenButton = doc.createElement("button");
  fullScreenButton.type = "button";
  fullScreenButton.className = "button";
  fullScreenButton.textContent = "Full screen";
  fullScreenButton.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWindowFullScreen(doc);
  });
  const stop = doc.createElement("button");
  stop.type = "button";
  stop.className = "button stop";
  stop.textContent = "Stop";
  stop.addEventListener("click", (e) => {
    e.stopPropagation();
    full.close();
  });
  bar.append(heading, hint, fullScreenButton, stop);
  const body = doc.createElement("div");
  body.className = "send-body";
  body.id = "send-body";
  doc.body.replaceChildren(bar, body);
  // A click only ENTERS full screen: a stray click must not leave it.
  doc.addEventListener("click", () => {
    if (!doc.fullscreenElement) toggleWindowFullScreen(doc);
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") toggleWindowFullScreen(doc);
  });
  void doc.documentElement.requestFullscreen?.().catch(() => undefined);
  // Window closed by hand: the sending stops, as with "Stop".
  const closed = () => {
    if (sendWindow !== w) return;
    sendWindow = null;
    clearInterval(watch);
    if (full.open) full.close();
  };
  w.addEventListener("pagehide", closed);
  const watch = setInterval(() => w.closed && closed(), 500);
  return w;
}

function closeSendWindow(): void {
  const w = sendWindow;
  sendWindow = null;
  if (w && !w.closed) w.close();
}

/**
 * Room for the grid in the popup, in CSS pixels — the same rule as the style
 * sheet (.send-body canvas): the parent takes the size of its content,
 * it cannot serve as a measure.
 */
function fullScreenBox(): { width: number; height: number } {
  if (sendWindow && !sendWindow.closed) {
    // Separate window: as large as it allows, minus the bar (hidden in full
    // screen) and room for the countdown, the gauge and the status line.
    const bar = sendWindow.document.querySelector(".send-window-bar")?.getBoundingClientRect().height ?? 0;
    const edge = Math.max(120, Math.min(sendWindow.innerWidth * 0.96, sendWindow.innerHeight - bar - 180));
    return { width: edge, height: edge };
  }
  const edge = Math.max(120, Math.min(innerWidth * 0.92, innerHeight * 0.96 - 250, 1060));
  return { width: edge, height: edge };
}

/** Popup alert when the module rendering no longer guarantees quality or speed. */
function fullScreenModuleAlert(px: number, columns: number): void {
  const { doc, win } = sendView();
  const el = doc.getElementById("fullscreen-alert");
  if (!el) return;
  const d = moduleDiagnostic(px, columns, win.devicePixelRatio || 1);
  el.hidden = d.level === "ok";
  el.dataset.level = d.level;
  el.textContent = d.message;
  if (d.level === "critical" || d.level === "warning") log(`sending: ${d.message}`);
}

/** Shared options of the bench displays: auto size, module alert. */
const FULL_SCREEN_OPTIONS = { moduleSize: "auto" as const, box: fullScreenBox, onModule: fullScreenModuleAlert };

function openFullScreen(title: string): { canvas: HTMLCanvasElement; hud: HTMLElement; count: HTMLElement; gauge: HTMLElement } {
  $("send-title").textContent = title;
  // Elements created in the document that shows them: the display follows
  // the clock and pixel density of ITS window.
  const { doc } = sendView();
  if (doc !== document) {
    doc.getElementById("send-title")!.textContent = title;
    const note = document.createElement("p");
    note.className = "send-elsewhere";
    note.textContent =
      "Sending in the separate window. Move it to the screen to film if needed; a click in it (or F) switches it to full screen. Closing it stops the sending.";
    $("send-body").replaceChildren(note);
  }
  const canvas = doc.createElement("canvas");
  const alert = doc.createElement("p");
  alert.id = "fullscreen-alert";
  alert.setAttribute("role", "status");
  alert.hidden = true;
  const hud = doc.createElement("p");
  hud.id = "fullscreen-hud";
  // The countdown, LARGE, under the grid: readable at two meters, phone in
  // hand, without hiding the code.
  const count = doc.createElement("p");
  count.id = "fullscreen-count";
  count.setAttribute("aria-live", "assertive");
  count.hidden = true;
  // A mark for whoever FILMS the sending in slow motion: when to stop.
  const gauge = doc.createElement("div");
  gauge.id = "fullscreen-gauge";
  gauge.hidden = true;
  doc.getElementById("send-body")!.replaceChildren(alert, canvas, count, gauge, hud);
  if (!full.open) full.showModal();
  return { canvas, hud, count, gauge };
}

// "Stop", Escape or closing the popup: everything stops.
$("stop-send").addEventListener("click", () => full.close());
full.addEventListener("close", () => {
  if (benchSending) {
    try {
      benchSending.finish();
    } catch {
      // already finished
    }
    log(`sending stopped after ${benchSending.sentFrames} frames.`);
    benchSending = null;
  }
  display?.stop();
  display = null;
  $("send-body").replaceChildren();
  closeSendWindow();
});

// ── Diagnostic: frozen-frame sender ───────────────────────────────────────

const sendMode = segments("sender-modes", () => updatePreviews());
const period = segments("periods");

function draw(canvas: HTMLCanvasElement, image: ImageRGBA): void {
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
}

function updatePreviews(): void {
  const codec = Number(sendMode.value) as Codec;
  const raw = FRAMES[codec]!;
  draw($<HTMLCanvasElement>("preview-r"), render(referenceSubframe(raw, codec), TM_PALETTE, { moduleSize: 4, quietZone: 2 }));
  draw($<HTMLCanvasElement>("preview-p"), render(payloadSubframe(raw, codec), TM_PALETTE, { moduleSize: 4, quietZone: 2 }));
  $("frame-help").textContent = `ORP frame of ${raw.length} bytes in ${tmName(codec)}. Maximum brightness; tap the image to exit.`;
}
updatePreviews();

$("show").addEventListener("click", () => {
  const codec = Number(sendMode.value) as Codec;
  const ms = Number(period.value);
  const { canvas, hud } = openFullScreen(`Fixed frame ${tmName(codec)}`);
  hud.textContent = `${FRAMES[codec]!.length} bytes · ${ms} ms / subframe`;
  display = new TmDisplay(canvas, { ...FULL_SCREEN_OPTIONS, period: ms });
  display.loop(FRAMES[codec]!, codec);
  log(`screen: fixed frame ${tmName(codec)} (${FRAMES[codec]!.length} bytes), R/P alternating every ${ms} ms.`);
});

// ── Transfer test: file sender ────────────────────────────────────────────

/**
 * Bench: pairing by SHARED PASSPHRASE (degraded path of the protocol, §7) —
 * no round trip, the sender needs no camera. The bench measures the channel;
 * the real security is the app's (pairing codes + SAS).
 */
const CODE_REPEAT = 10; // single grid: the init code comes back every 10 frames
const BATCH_REPEAT = 3; // mosaic: it takes one cell every third batch

const sendModeSelector = segments("send-modes", () => updateEstimate());
const sendPeriodSelector = segments("send-periods", () => updateEstimate());
// 8 ms per subframe: only offered on a screen at 120 Hz or more.
void measureRefreshRate().then((hz) => {
  const b = $("send-periods").querySelector<HTMLButtonElement>('[data-value="8"]');
  if (b) b.hidden = hz < 110;
});
const sendMosaicSelector = segments("mosaics", () => updateEstimate());
const sendCountdown = segments("delays");
const sendWindowSelector = segments("send-windows");
let benchFile: File | null = null;

$<HTMLInputElement>("bench-file").addEventListener("change", (e) => {
  benchFile = (e.target as HTMLInputElement).files?.[0] ?? null;
  $("file-zone").classList.toggle("selected", !!benchFile);
  $("file-name").textContent = benchFile ? benchFile.name : "Choose a file";
  $("file-help").textContent = benchFile ? `${readableSize(benchFile.size)} · change` : "an image, some text, a small document";
  ($("send-file") as HTMLButtonElement).disabled = !benchFile;
  updateEstimate();
});

/** Expected useful throughput: payload of an R/P pair × mosaic cells, minus ~10 % (init codes, fountain). */
function expectedThroughput(codec: Codec, ms: number, cells = 1): number {
  const perPair = (SYMBOL_CAPACITY[codec] ?? 1) * SYMBOL_SIZE * cells;
  return (perPair / ((2 * ms) / 1000)) * 0.9;
}

function updateEstimate(): void {
  if (!benchFile) {
    $("estimate").textContent = "choose a file";
    return;
  }
  const columns = Number(sendMosaicSelector.value);
  const throughput = expectedThroughput(Number(sendModeSelector.value) as Codec, Number(sendPeriodSelector.value), columns * columns);
  $("estimate").textContent = `≈ ${readableDuration(benchFile.size / throughput)} · ${readableThroughput(throughput)} (before compression)`;
}

$("send-file").addEventListener("click", () => {
  if (!benchFile) return;
  $("send-error").hidden = true;
  if (!SECURE_CONTEXT) {
    visibleError("send-error", "Cannot send: insecure page (http://). Open the bench over https:// or via localhost.");
    return;
  }
  const settings = {
    codec: Number(sendModeSelector.value) as Codec,
    period: Number(sendPeriodSelector.value),
    columns: Number(sendMosaicSelector.value),
    countdownSeconds: Number(sendCountdown.value),
  };
  // The window opens HERE, in the click: after the await of sendFile, the
  // browser would block it.
  if (sendWindowSelector.value === "window") {
    sendWindow = openSendWindow(`Sending: ${benchFile.name}`);
    if (!sendWindow) log("sending: the browser blocked the new window — sending in this page.");
  }
  void sendFile(benchFile, settings).catch((e) => {
    // Close the popup again if the error arrives after it opened.
    if (full.open) full.close();
    closeSendWindow();
    visibleError("send-error", `Cannot send: ${(e as Error).message}`);
  });
});

interface SendSettings {
  codec: Codec;
  period: number;
  /** Grids per row of the mosaic: 1 to 7. */
  columns: number;
  /** Countdown before the data (s). */
  countdownSeconds: number;
}

async function sendFile(f: File, { codec, period: ms, columns, countdownSeconds }: SendSettings): Promise<void> {
  // Pairing by PASSPHRASE announced in the init code: the receiving app then
  // asks for the passphrase instead of showing a response code the bench
  // would never read (§7.2) — the same code on both sides.
  const session = new SenderSession(new CryptoWebCrypto(), { codecs: [codec], pairing: "passphrase" });
  await session.prepare(pack({ name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) }));
  await session.receivePassphrase(BENCH_PASSPHRASE);
  // Session code, displayed on both sides: it proves we read the SAME
  // transfer. On the bench the passphrase is fixed — this is not a security
  // guarantee, unlike the SAS code of the application.
  const code = `${session.sas().slice(0, 3)} ${session.sas().slice(3)}`;
  session.confirmSas();
  benchSending = session;
  const init = pairingFrame(session.initCode());
  const { canvas, hud, count, gauge } = openFullScreen(`Sending: ${f.name}`);
  const initInfo = readInitCode(session.initCode());
  const toFilm = new FilmingGauge(initInfo.kTotal, initInfo.blockCount);
  display = new TmDisplay(canvas, { ...FULL_SCREEN_OPTIONS, period: ms });
  const view = display;
  const throughput = new SendThroughput();
  const cells = columns * columns;
  // SENDER CLOCK, shared with the phone: each repetition of the init code
  // carries the clock, the symbols sent and the "to film" target (send
  // state). The phone syncs its video on it and tells how much to film from
  // what it actually reads.
  let dataStart: number | null = null;
  const initWithState = (t?: number) =>
    pairingFrame(session.initCode(), {
      t: t ?? (dataStart === null ? 0 : performance.now() - dataStart),
      sentSymbols: toFilm.sentSymbols,
      suggestedSymbols: toFilm.suggested,
    });
  const counter = () => clock(dataStart === null ? 0 : (performance.now() - dataStart) / 1000);
  log(`screen: transfer of ${f.name} (${readableSize(f.size)}) in ${tmName(codec)}, ${ms} ms / subframe, mosaic ${columns}×${columns}, starting in ${countdownSeconds} s.`);

  // Preparation: the init code runs during the countdown — the phone frames,
  // locks white balance and exposure and already reads the code. Missing the
  // start would cost nothing (fountain code), but it is more comfortable than
  // aiming in a rush.
  view.loop(init, CODEC.COLOR_4);
  // SLOW countdown (≥ 100 ms) whatever the chosen period: the phone reads the
  // init code there and learns the gray reference. At 17 ms, an LCD screen
  // never shows the R long enough for that.
  view.subframeDuration = Math.max(ms, 100);
  count.hidden = countdownSeconds === 0;
  for (let remaining = countdownSeconds; remaining > 0; remaining--) {
    if (benchSending !== session) return; // stopped during the countdown
    view.loop(initWithState(-remaining * 1000), CODEC.COLOR_4);
    count.innerHTML = `<span>${remaining}</span><small>aim at the screen · code <b>${code}</b></small>`;
    hud.textContent = `Starting in ${remaining} s — the phone is already reading the initialization code`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  count.hidden = true;
  if (benchSending !== session) return;
  if (countdownSeconds === 0) await view.show(init, CODEC.COLOR_4, 4);
  view.subframeDuration = ms;

  let n = 0;
  let batches = 0;
  let batch: Uint8Array[] = [];
  const updateHud = () => {
    gauge.hidden = false;
    const pct = Math.round(toFilm.share * 100);
    gauge.classList.toggle("enough", toFilm.enough);
    // Guidance: as long as the phone has not received everything, this sending
    // must GO ON — stopping or restarting it changes the code, everything
    // starts over.
    const callback = `<span>Phone asking for “more”? Keep this transmission running (code ${code}) — don't stop it, don't restart it.</span>`;
    // The ⏱ clock is the one the phone reads in the frames: it says "your video
    // covers 0:12 → 0:42" in the same unit.
    gauge.innerHTML = toFilm.enough
      ? `<div class="bar"><i style="width:100%"></i></div><b>✓ Enough sent · ⏱ ${counter()}</b><span>for a perfect read; the phone will say if it needs more</span>${callback}`
      : `<div class="bar"><i style="width:${pct}%"></i></div><b>To film ${pct} % · ⏱ ${counter()}</b><span>minimum, if everything is read from the start</span>${callback}`;
    hud.textContent =
      `code ${code} · ${f.name} · ${tmName(codec)} · ${cells > 1 ? `mosaic ${columns}×${columns} · ` : ""}${n} frames · ` +
      `${readableThroughput(throughput.throughput)} sent`;
  };
  await session.start(async (frame) => {
    dataStart ??= performance.now();
    n++;
    throughput.frame(frame);
    toFilm.frame(readMetaByMajority(frame).symbolCount);
    if (cells === 1) {
      if (n > 1 && (n - 1) % CODE_REPEAT === 0) await view.show(initWithState(), CODEC.COLOR_4, 1);
      updateHud();
      await view.show(frame, codec, 1);
      return;
    }
    // Mosaic: the session produces the frames one by one; they are held until a
    // batch is full (one cell kept for the init code every third batch), then
    // the whole batch is displayed at once.
    batch.push(frame);
    const withCode = batches % BATCH_REPEAT === 0;
    if (batch.length < cells - (withCode ? 1 : 0)) return;
    const shown = withCode ? [initWithState(), ...batch] : batch;
    batch = [];
    batches++;
    updateHud();
    await view.showBatch(shown, columns, 1);
  });
}

// ── Slow-motion video: filmed by the bench, then read image by image ──────

let videoReading: AbortController | null = null;
let benchRecording: Recording | null = null;

$<HTMLInputElement>("bench-video").addEventListener("change", (e) => {
  const field = e.target as HTMLInputElement;
  const file = field.files?.[0];
  field.value = "";
  if (file) void readBenchVideo(file, file.name);
});

$("bench-film").addEventListener("click", () => void filmBench().catch((e) => ($("video-state").textContent = `Cannot film: ${(e as Error).message}`)));

async function filmBench(): Promise<void> {
  const state = $("video-state");
  const button = $<HTMLButtonElement>("bench-film");
  if (nativeSlowMotionAvailable()) {
    // APK: native high-speed camera screen; the sensor must be free.
    const opened = stream;
    closeBenchCamera();
    state.textContent = "Opening the slow-motion camera…";
    try {
      const v = await filmSlowMotion(30, opened);
      log(`slow-mo filmed: ${v.width}×${v.height} at ${v.frameRate} fps`);
      await readBenchVideo(v.video, `slow-mo ${v.frameRate} fps`);
    } catch (e) {
      state.textContent = (e as Error).message;
    }
    // The live camera does not come back by itself: "Open the camera".
    return;
  }
  if (benchRecording) {
    benchRecording.stop();
    return;
  }
  if (!stream) await open();
  if (!stream) return;
  const recording = filmStream(stream, 30);
  benchRecording = recording;
  button.textContent = "Stop filming";
  const r = stream.getVideoTracks()[0]?.getSettings();
  state.textContent = `● Recording at ${r?.frameRate ? Math.round(r.frameRate) : "?"} fps: aim at the screen, then “Stop filming”.`;
  try {
    const v = await recording.result;
    await readBenchVideo(v.video, `film ${v.frameRate ? Math.round(v.frameRate) : "?"} fps`);
  } finally {
    benchRecording = null;
    button.textContent = "Film in slow motion";
  }
}

function videoText(p: VideoProgress): string {
  const pct = p.duration ? Math.min(100, Math.round((100 * p.position) / p.duration)) : 0;
  return (
    `${pct} % · ${p.images} images${p.frameRate ? ` at ${Math.round(p.frameRate)} fps` : ""}` +
    `${p.skipped ? ` (${p.skipped} skipped)` : ""} · ${p.grids} grid(s) · ` +
    `${p.valid} valid frames / ${p.pairs} pairs · ${total(p.msPerImage, 1)} ms/image`
  );
}

/** The frames of the video go to the same transfer as the live camera. */
/** Bench camera closed (video reading, or native slow motion); "Open the camera" brings it back. */
function closeBenchCamera(): void {
  if (stream) closeCamera(stream);
  stream = undefined;
  video.srcObject = null;
  $("open-cam").hidden = false;
}

async function readBenchVideo(file: Blob | EncodedVideo, name: string): Promise<void> {
  videoReading?.abort();
  closeBenchCamera(); // during the reading, the camera does not run
  const control = new AbortController();
  videoReading = control;
  const state = $("video-state");
  const loop = loopCell.checked;
  loopCell.checked = false; // the computation for the video alone
  state.textContent = `Reading the video (${name}${file instanceof Blob ? `, ${readableSize(file.size)}` : ""})…`;
  try {
    const end = await readTmVideo(file, {
      signal: control.signal,
      onFrame: (bytes) => transfer(bytes),
      onProgress: (p) => (state.textContent = videoText(p)),
    });
    state.textContent = `Video read: ${videoText(end)}`;
    log(`video ${name}: ${videoText(end)}`);
  } catch (e) {
    if ((e as Error).name !== "AbortError") state.textContent = `Cannot read: ${(e as Error).message}`;
  } finally {
    loopCell.checked = loop;
    if (videoReading === control) videoReading = null;
  }
}

// ── Camera ────────────────────────────────────────────────────────────────

let stream: MediaStream | undefined;
let lockApplied = false;

async function open(sensor?: string): Promise<void> {
  if (stream) return;
  stream = await openCamera(sensor ? { deviceId: sensor } : { rearFacing: true });
  video.srcObject = stream;
  await video.play();
  $("open-cam").hidden = true;
  lockApplied = false;
  log(`camera: ${video.videoWidth}×${video.videoHeight} — ${stream.getVideoTracks()[0]!.label.slice(0, 60)}`);
  await announceSensors();
  log("white balance + exposure lock: applied automatically once the grid is stable in view.");
  startLoop();
}

async function announceSensors(): Promise<void> {
  if (!stream) return;
  const cap = sensorCapabilities(stream);
  const chunks: string[] = [];
  if (cap.zoom) chunks.push(`zoom ${cap.zoom.min}..${cap.zoom.max}`);
  if (cap.whiteBalanceModes) chunks.push(`white balance: ${cap.whiteBalanceModes.join("/")}`);
  log(`sensor: ${chunks.length > 0 ? chunks.join(" · ") : "no advanced controls exposed"}`);
  if (cap.zoom) {
    const slider = $<HTMLInputElement>("zoom");
    slider.min = String(cap.zoom.min);
    slider.max = String(cap.zoom.max);
    slider.step = cap.zoom.step ? String(cap.zoom.step) : "0.1";
    $("zone-zoom").hidden = false;
  }
  const selector = $<HTMLSelectElement>("sensor");
  const cameras = await listCameras();
  if (cameras.length > 1) {
    selector.hidden = false;
    selector.innerHTML = '<option value="">— camera —</option>';
    cameras.forEach((c, i) => {
      const option = document.createElement("option");
      option.value = c.deviceId;
      option.textContent = c.label || `camera ${i}`;
      selector.appendChild(option);
    });
  }
}

async function applyLock(reason: string): Promise<void> {
  if (!stream) return;
  lockApplied = true;
  const state = await lockSensor(stream, { whiteBalance: true, exposure: true });
  $("lock-chip").hidden = !(state.whiteBalance || state.exposure);
  $("lock-chip").textContent = state.whiteBalance && state.exposure ? "white balance + exposure locked" : state.whiteBalance ? "white balance locked" : "exposure locked";
  log(`lock (${reason}): ${state.notes.join(" · ")}`);
}

$("open-cam").addEventListener("click", () =>
  void open().catch((e) => {
    const advice = (e as { advice?: string }).advice;
    const message = `Camera: ${(e as Error).message}${advice ? ` ${advice}` : ""}`;
    log(message);
    for (const id of ["advice", "transfer-advice"]) {
      $(id).textContent = message;
      $(id).classList.remove("ok");
    }
  }),
);
$("sensor").addEventListener("change", async (e) => {
  const id = (e.target as HTMLSelectElement).value;
  if (!id || !stream) return;
  closeCamera(stream);
  stream = undefined;
  await open(id);
});
$("zoom").addEventListener("input", (e) => {
  if (stream) void applyCameraConstraints(stream, { zoom: Number((e.target as HTMLInputElement).value) });
});
$("relock").addEventListener("click", async () => {
  if (!stream) return;
  // Give the automatic mode back, let it converge ON the target screen, then lock.
  await unlockSensor(stream);
  $("lock-chip").hidden = true;
  log("auto restored — converging for 1.5 s on the target grid…");
  await new Promise((r) => setTimeout(r, 1500));
  await applyLock("manual");
});
$("unlock").addEventListener("click", async () => {
  if (!stream) return;
  await unlockSensor(stream);
  lockApplied = true; // no automatic re-lock
  $("lock-chip").hidden = true;
  log("auto restored (white balance, exposure) — no automatic re-lock.");
});

// ── Capture and decoding ──────────────────────────────────────────────────

const canvas = document.createElement("canvas");
const canvasContext = canvas.getContext("2d", { willReadFrequently: true })!;

/**
 * Analysis width: 1,920 px (the grids of a 3×3 mosaic are too small at
 * 1,280 px to be FOUND), raised to the full camera width for a 4×4 mosaic
 * and beyond — including by probing when nothing is seen.
 */
const analysisWidth = new AdaptiveWidth();

/** After each image: adapts the analysis width, forgets the geometry if it changes. */
function adaptWidth(pxPerModule: number): void {
  if (!analysisWidth.observe(pxPerModule, video.videoWidth)) return;
  mosaicReceiver.reset();
  previous = null;
  last = { R: null, P: null };
  lastType = null;
  log(`analysing at ${analysisWidth.width(video.videoWidth)} px wide.`);
}

function capture(): ImageRGBA | null {
  if (!video.videoWidth) return null;
  const scale = Math.min(1, analysisWidth.width(video.videoWidth) / video.videoWidth);
  const l = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  if (canvas.width !== l || canvas.height !== h) {
    canvas.width = l;
    canvas.height = h;
  }
  canvasContext.drawImage(video, 0, 0, l, h);
  const d = canvasContext.getImageData(0, 0, l, h);
  return { width: d.width, height: d.height, data: d.data };
}

interface Pair {
  valid: boolean; // Reed-Solomon + CRC pass
  byteErrors: number;
  confidence: number;
  uncertain: number;
  measurement: TmMeasurement;
  saturation: number;
}

const VALIDITY_DURATION = 1200;
const captureMode = segments("modes-capture", () => resetAll());
let previous: { loc: Location; t: number } | null = null;
let last: Record<"R" | "P", { sub: TmSubframe; t: number } | null> = { R: null, P: null };
let lastType: "R" | "P" | null = null;
let lastLocation: Location | null = null;
let stableDetections = 0;
let mixedCount = 0;
let imageCount = 0;
const history: Pair[] = [];
let cumulative = new Float32Array(TM_DATA_MODULES.length * 3);
let cumulativeCount = 0;
let collector: ((p: Pair) => void) | null = null;
const mosaicReceiver = new TmMosaicReceiver();
/** Single grid: same homography as long as the phone does not move (see RetainedGeometry). */
const geometry = new RetainedGeometry();
/** Smoothed advice and frame color: no more green/orange blinking at rest. */
const smoother = new FramingSmoother();
/** Recent saturation per subframe type: the advice is about the R/P couple. */
let saturations: Record<"R" | "P", { v: number; t: number } | null> = { R: null, P: null };

const captureCodec = (): Codec => Number(captureMode.value) as Codec;

function resetAll(): void {
  cumulative = new Float32Array(TM_DATA_MODULES.length * 3);
  cumulativeCount = 0;
  history.length = 0;
  mixedCount = 0;
  imageCount = 0;
  last = { R: null, P: null };
  lastType = null;
  saturations = { R: null, P: null };
  geometry.forget();
  smoother.reset();
  for (const id of ["kpi-valid", "kpi-confidence", "kpi-uncertain", "kpi-total"]) $(id).textContent = "—";
}
$("reset").addEventListener("click", () => {
  resetAll();
  log("accumulation and statistics reset.");
});

function compare(bytes: Uint8Array, expected: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < expected.length; i++) if (bytes[i] !== expected[i]) n++;
  return n;
}

function readableFrame(bytes: Uint8Array): boolean {
  try {
    readFrame(bytes);
    return true;
  } catch {
    return false;
  }
}

function processPair(r: TmSubframe, p: TmSubframe): void {
  const codec = captureCodec();
  const measurement = measureTmPair(r, p);
  const decision = decideTm(measurement.soft, codec);
  const pair: Pair = {
    valid: readableFrame(decision.bytes),
    byteErrors: compare(decision.bytes, FRAMES[codec]!),
    confidence: decision.meanConfidence,
    uncertain: decision.uncertainShare,
    measurement,
    saturation: p.saturation,
  };
  if (pair.valid) transfer(decision.bytes);
  if (!pair.valid) {
    // The screen may be showing the OTHER mode: same soft values, other decision.
    const other = (codec === CODEC.COLOR_8 ? CODEC.COLOR_4 : CODEC.COLOR_8) as Codec;
    const otherBytes = decideTm(measurement.soft, other).bytes;
    if (readableFrame(otherBytes) && isPairingFrame(otherBytes)) {
      // Init code (always TM4) interleaved in a TM8 transfer: route it, without
      // changing the expected mode.
      transfer(otherBytes);
      return;
    }
    if (readableFrame(otherBytes)) {
      log(`the screen is sending ${tmName(other)}, not ${tmName(codec)} — switching expected mode.`);
      captureMode.value = String(other);
      resetAll();
      return;
    }
    lostFrame();
  }
  if (measurement.residual < 0.6 && measurement.gains.every((g) => g > 0.05)) {
    for (let i = 0; i < cumulative.length; i++) cumulative[i]! += measurement.soft[i]!;
    cumulativeCount++;
  }
  history.push(pair);
  if (history.length > 30) history.shift();
  collector?.(pair);
  showStats(pair);
}

function exactCumulative(): boolean | null {
  if (cumulativeCount === 0) return null;
  const codec = captureCodec();
  return compare(decideTm(cumulative.map((v) => v / cumulativeCount), codec).bytes, FRAMES[codec]!) === 0;
}

function showStats(p: Pair): void {
  const validCount = history.filter((h) => h.valid).length;
  const kpiValid = $("kpi-valid");
  kpiValid.textContent = `${validCount}/${history.length}`;
  kpiValid.className = validCount === history.length ? "ok" : validCount / history.length < 0.8 ? "ko" : "";
  $("kpi-confidence").textContent = pct(p.confidence);
  $("kpi-uncertain").textContent = pct(p.uncertain);
  const exact = tr ? null : exactCumulative();
  const kpiCumulative = $("kpi-total");
  kpiCumulative.textContent = exact === null ? "—" : exact ? "EXACT" : "inexact";
  kpiCumulative.className = exact ? "ok" : exact === false ? "ko" : "";
  const m = p.measurement;
  $("diag-gains").textContent = `${total(m.gains[0])} · ${total(m.gains[1])} · ${total(m.gains[2])}`;
  $("diag-crosstalk").textContent = `${pct(m.crosstalk)} ${m.fullMatrix ? "corrected" : "NOT corrected"}`;
  $("diag-noise").textContent = pct(m.residual);
  $("diag-saturation").textContent = pct(p.saturation);
  $("diag-mixed").textContent = imageCount > 0 ? pct(mixedCount / imageCount) : "—";
  // In a file transfer, comparing with the frozen frame makes no sense.
  $("diag-bytes").textContent = tr ? "— (file)" : String(p.byteErrors);
  console.log(
    `[LAB] pair ${p.valid ? "VALID" : "invalid"} · ${tmName(captureCodec())} · confidence ${pct(p.confidence)} · ` +
      `uncertain ${pct(p.uncertain)} · wrong bytes ${p.byteErrors} · gains ${m.gains.map((g) => total(g)).join("/")} · ` +
      `crosstalk ${pct(m.crosstalk)} · noise ${pct(m.residual)} · saturation ${pct(p.saturation)}`,
  );
}

function drawOverlay(
  loc: Location | null,
  sub: TmSubframe | null,
  image: ImageRGBA,
  advice: string,
  others: readonly Location[] = [],
): void {
  const ratio = window.devicePixelRatio || 1;
  const l = overlay.clientWidth;
  const h = overlay.clientHeight;
  if (overlay.width !== Math.round(l * ratio) || overlay.height !== Math.round(h * ratio)) {
    overlay.width = Math.round(l * ratio);
    overlay.height = Math.round(h * ratio);
  }
  const c = overlay.getContext("2d")!;
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.clearRect(0, 0, l, h);
  if (!loc || !video.videoWidth) return;
  const ev = Math.min(l / video.videoWidth, h / video.videoHeight);
  const ox = (l - video.videoWidth * ev) / 2;
  const oy = (h - video.videoHeight * ev) / 2;
  const k = ev * (video.videoWidth / image.width);
  const to = (x: number, y: number): [number, number] => [ox + x * k, oy + y * k];
  // `advice` is already smoothed: a mixed image keeps the current color.
  const color = advice === "" ? "#22c55e" : "#f59e0b";
  c.lineWidth = 3;
  c.strokeStyle = color;
  c.beginPath();
  for (const [x, y] of [[0, 0], [41, 0], [41, 41], [0, 41]] as const) c.lineTo(...to(...applyH(loc.h, x, y)));
  c.closePath();
  c.stroke();
  c.fillStyle = color;
  for (const [x, y] of loc.finders) {
    c.beginPath();
    c.arc(...to(x, y), 6, 0, 2 * Math.PI);
    c.fill();
  }
  if (loc.alignment) {
    c.fillStyle = "#06b6d4";
    c.beginPath();
    c.arc(...to(loc.alignment[0], loc.alignment[1]), 5, 0, 2 * Math.PI);
    c.fill();
  }
  // The other grids of a mosaic: outline only.
  for (const other of others) {
    c.beginPath();
    for (const [x, y] of [[0, 0], [41, 0], [41, 41], [0, 41]] as const) c.lineTo(...to(...applyH(other.h, x, y)));
    c.closePath();
    c.stroke();
  }
  c.font = "600 13px ui-monospace, monospace";
  c.fillStyle = color;
  const mosaic = others.length > 0 ? ` · mosaic ${others.length + 1} grids` : "";
  c.fillText(`${sub?.type ?? "?"} · ${total(loc.pxPerModule, 1)} px/module${mosaic}`, 10, 20);
}

/**
 * Mosaic: several grids in the image. Each cell has its own R/P pairing
 * (TmMosaicReceiver); the valid frames go to the transfer, the unreadable
 * pairs count as lost. The fine diagnostic (frozen frame) remains that of a
 * single grid.
 */
function processMosaic(image: ImageRGBA, locs: Location[], now: number): void {
  previous = null;
  const results = mosaicReceiver.process(image, locs, now);
  imageCount++;
  const first = results[0];
  if (!first?.location) {
    showFraming(null, null, image, framingAdvice(null, null));
    return;
  }
  const readCount = results.map((r) => r.location!);
  lastLocation = readCount[0]!;
  if (first.subframe?.type === "mixed") mixedCount++;
  showFraming(readCount[0]!, first.subframe, image, first.advice, readCount.slice(1));
  $("diag-module").textContent = `${total(readCount[0]!.pxPerModule, 1)} px · ${locs.length}/${results.length} grids seen`;
  $("diag-perspective").textContent = readCount[0]!.alignment ? `${total(readCount[0]!.perspectiveSkew, 1)} modules` : "not corrected";
  stableDetections++;
  if (!lockApplied && stableDetections >= 8) void applyLock("mosaic stable in view");
  for (const r of results) {
    if (r.frame?.isNew) transfer(r.frame.bytes);
    else if (r.invalidPair) lostFrame();
  }
}

/** Overlay + advice, through the smoother: a transition image does not count. */
function showFraming(
  loc: Location | null,
  sub: TmSubframe | null,
  image: ImageRGBA,
  advice: string,
  others: readonly Location[] = [],
): void {
  const smoothed = smoother.track(loc && sub?.type === "mixed" ? null : advice);
  drawOverlay(loc, sub, image, smoothed, others);
  showAdvice(smoothed, smoothed === "");
}

function showAdvice(text: string, good: boolean): void {
  for (const id of ["advice", "transfer-advice"]) {
    const el = $(id);
    el.textContent = good ? "Framing OK." : text;
    el.classList.toggle("ok", good);
  }
}

function processImage(): void {
  const image = capture();
  if (!image) return;
  const now = performance.now();
  const locs = locateAll(image, TM_ALIGNMENT);
  adaptWidth(locs.length ? Math.min(...locs.map((l) => l.pxPerModule)) : 0);
  // Mosaic as soon as one has been seen, even if THIS image only shows one
  // grid of it (P subframe): R and P of the same cell stay together.
  if (locs.length >= 2 || mosaicReceiver.cellCount >= 2) {
    processMosaic(image, locs, now);
    return;
  }
  const tracker = previous && now - previous.t < 500 ? previous.loc : null;
  const measured = locs[0] ?? locateTm(image, tracker);
  if (!measured) {
    previous = null;
    stableDetections = 0;
    showFraming(null, null, image, framingAdvice(null, null));
    return;
  }
  const loc = geometry.retain(measured, now);
  previous = { loc, t: now };
  lastLocation = loc;
  const sub = analyzeSubframe(image, loc);
  imageCount++;
  if (sub.type !== "mixed") saturations[sub.type] = { v: sub.saturation, t: now };
  if (sub.type === "R") geometry.refineFromR(measured);
  let saturation = 0;
  for (const x of Object.values(saturations)) if (x && now - x.t < 1000) saturation = Math.max(saturation, x.v);
  const advice = framingAdvice(loc, { saturation }, imageCount > 20 ? mixedCount / imageCount : 0);
  showFraming(loc, sub, image, advice);
  $("diag-perspective").textContent = loc.alignment ? `${total(loc.perspectiveSkew, 1)} modules` : "not corrected";
  $("diag-module").textContent = `${total(loc.pxPerModule, 1)} px`;

  stableDetections++;
  if (!lockApplied && stableDetections >= 8) void applyLock("grid stable in view");

  if (sub.type === "mixed") {
    mixedCount++;
    return;
  }
  last[sub.type] = { sub, t: now };
  if (lastType !== null && lastType !== sub.type) {
    const other = last[sub.type === "R" ? "P" : "R"];
    if (other && now - other.t < VALIDITY_DURATION) {
      const [r, p] = sub.type === "R" ? [sub, other.sub] : [other.sub, sub];
      processPair(r, p);
    }
  }
  lastType = sub.type;
}

let loopNumber = 0;
function startLoop(): void {
  const number = ++loopNumber;
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  const next = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : setTimeout(tick, 30));
  const tick = () => {
    if (number !== loopNumber || !stream) return;
    if (loopCell.checked) {
      try {
        processImage();
      } catch (e) {
        console.log(`[LAB] image skipped: ${(e as Error).message}`);
      }
    }
    next();
  };
  next();
}

// ── Transfer test: reception ──────────────────────────────────────────────

interface Second {
  bytes: number;
  lost: number;
}

let tr: {
  session: ReceiverSession;
  info: InitCodeInfo;
  tracker: TransferTracker;
  finished: boolean;
  readCount: number;
  lost: number;
  rejected: number;
  codec: Codec;
  seconds: Second[];
  timer: number;
  file?: TransferredFile;
} | null = null;
let transferQueue: Promise<void> = Promise.resolve();
let rejectedSession: Uint8Array | null = null;

/** Queue: the frames are processed one by one, in order. */
function transfer(bytes: Uint8Array): void {
  transferQueue = transferQueue.then(() => processTransfer(bytes)).catch((e) => log(`transfer: ${(e as Error).message}`));
}

function lostFrame(): void {
  if (!tr || tr.finished) return;
  tr.lost++;
  tr.seconds[tr.seconds.length - 1]!.lost++;
}

function sameSession(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stopTracking(): void {
  if (tr) clearInterval(tr.timer);
}

async function processTransfer(bytes: Uint8Array): Promise<void> {
  if (isPairingFrame(bytes)) {
    const payload = pairingPayload(bytes, INIT_CODE_SIZE);
    if (!payload || (tr && sameSession(tr.info.sessionId, payload))) return;
    if (rejectedSession && sameSession(rejectedSession, payload)) return;
    const session = new ReceiverSession(new CryptoWebCrypto());
    const info = session.scanInitCode(payload);
    if (!info.byPassphrase) {
      // Sender on the strong path (the application): it waits for a response
      // code scanned by its webcam, which the bench does not show. Deriving
      // keys from the bench passphrase would give another code and
      // unreadable frames.
      rejectedSession = info.sessionId;
      session.dispose();
      $("transfer-state").textContent =
        "This sender is the app (pairing by response code): receive with the app, not with the bench.";
      log("initialization code from an app (strong pairing): ignored by the bench.");
      return;
    }
    await session.pairWithPassphrase(BENCH_PASSPHRASE);
    $("transfer-sas").textContent = `${session.sas().slice(0, 3)} ${session.sas().slice(3)}`;
    session.confirmSas();
    stopTracking();
    tr?.session.dispose();
    const seconds: Second[] = [{ bytes: 0, lost: 0 }];
    tr = {
      session,
      info,
      tracker: new TransferTracker(info.streamSize, info.kTotal),
      finished: false,
      readCount: 0,
      lost: 0,
      rejected: 0,
      codec: captureCodec(),
      seconds,
      timer: window.setInterval(() => {
        seconds.push({ bytes: 0, lost: 0 });
        if (seconds.length > 30) seconds.shift();
        drawHistogram();
      }, 1000),
    };
    clearPreview();
    $("arrival").hidden = true;
    $("waiting-state").hidden = true;
    $("running-state").hidden = false;
    $("transfer-name").textContent = `File of ${readableSize(info.streamSize)} announced`;
    updateTransfer(0, false);
    drawHistogram();
    log(`transfer detected: ${readableSize(info.streamSize)}, ${info.kTotal} source symbols.`);
    return;
  }
  if (!tr || tr.finished) return;
  try {
    const status = await tr.session.receiveFrame(bytes);
    if (!status.accepted) {
      // Replay: duplicate, normal. Any other rejection is SAID — a frame read
      // optically but undecryptable signals different keys.
      if (status.rejection !== "rejeu") {
        tr.rejected++;
        if (tr.readCount === 0 && tr.rejected >= 5) {
          $("transfer-state").textContent =
            `${tr.rejected} frames read but rejected (${status.rejection}): the keys do not match. Restart the transmission.`;
        }
      }
      return;
    }
  } catch (e) {
    if (e instanceof OrpUnknownSession) return; // frame of another transfer: the next init code will decide
    throw e;
  }
  tr.tracker.start();
  tr.readCount++;
  tr.codec = (bytes[4] ?? CODEC.COLOR_8) as Codec;
  tr.seconds[tr.seconds.length - 1]!.bytes += (bytes[6] ?? 0) * SYMBOL_SIZE;
  const p = tr.session.progress();
  updateTransfer(p.receivedSymbols, tr.session.done);
  if (!tr.session.done) return;

  tr.finished = true;
  stopTracking();
  const result = await tr.session.result();
  const e = tr.tracker.state(p.receivedSymbols, true);
  tr.file = unpack(result.data);
  showArrival(tr.file, e.elapsed, e.throughput);
  log(`TRANSFER SUCCEEDED: ${tr.file.name}, ${readableSize(tr.file.data.length)}, ${readableDuration(e.elapsed)}, ${readableThroughput(e.throughput)} — SHA-256 fingerprint verified.`);
}

function updateTransfer(symbols: number, done: boolean): void {
  if (!tr) return;
  const e = tr.tracker.state(symbols, done);
  const percent = Math.floor(e.progress * 100);
  $("transfer-fill").style.width = `${percent}%`;
  $("transfer-bar").setAttribute("aria-valuenow", String(percent));
  $("transfer-percent").textContent = `${percent} %`;
  $("transfer-throughput").textContent = e.throughput > 0 ? readableThroughput(e.throughput) : "—";
  $("transfer-bytes").textContent = `${readableSize(e.usefulBytes)} / ${readableSize(e.totalBytes)}`;
  $("transfer-remaining").textContent = done ? "0 s" : readableDuration(e.remaining);
  $("transfer-frames").textContent = `${tr.readCount} / ${tr.lost}`;
}

function drawHistogram(): void {
  if (!tr) return;
  const zone = $("histogram");
  const max = Math.max(1, ...tr.seconds.map((s) => s.bytes));
  const bars: HTMLElement[] = [];
  for (let i = 0; i < 30 - tr.seconds.length; i++) {
    const b = document.createElement("div");
    b.className = "empty";
    b.style.height = "6%";
    bars.push(b);
  }
  for (const s of tr.seconds) {
    const b = document.createElement("div");
    if (s.bytes > 0) {
      b.className = "read";
      b.style.height = `${Math.max(8, (100 * s.bytes) / max)}%`;
    } else if (s.lost > 0) {
      b.className = "lost";
      b.style.height = "25%";
    } else {
      b.className = "empty";
      b.style.height = "6%";
    }
    bars.push(b);
  }
  zone.replaceChildren(...bars);
}

// ── Arrival: preview in place, then the user's decision ───────────────────

let arrivalPreview: Preview | null = null;
/** Original content of the button (icon + label), restored at each arrival. */
const SAVE_HTML = $("save").innerHTML;

function clearPreview(): void {
  arrivalPreview?.release();
  arrivalPreview = null;
  $("preview-frame").replaceChildren();
}

function showArrival(f: TransferredFile, duration: number, throughput: number): void {
  if (!tr) return;
  clearPreview();
  arrivalPreview = createPreview(f);
  $("arrival-status").hidden = true;
  $("transfer-state").textContent = "";
  const saveButton = $<HTMLButtonElement>("save");
  saveButton.disabled = false;
  saveButton.innerHTML = SAVE_HTML;
  $("preview-frame").append(arrivalPreview.element);
  $("enlarge").hidden = !arrivalPreview.enlargeable;
  $("copy").hidden = arrivalPreview.text === null || !navigator.clipboard;
  $("arrival-name").textContent = f.name;
  $("arrival-type").textContent = f.type;
  $("arrival-size").textContent = readableSize(f.data.length);
  $("arrival-duration").textContent = readableDuration(duration);
  $("arrival-throughput").textContent = readableThroughput(throughput);
  $("arrival-frames").textContent = `${tr.readCount} read · ${tr.lost} lost`;
  $("arrival-mode").textContent = tmName(tr.codec);
  const share = new File([f.data as BlobPart], f.name, { type: f.type });
  $("share").hidden = !(navigator.canShare?.({ files: [share] }) ?? false);
  $("running-state").hidden = true;
  $("waiting-state").hidden = false;
  $("waiting-state").querySelector("p")!.textContent = "Transfer complete: see the received file below.";
  $("arrival").hidden = false;
  if (activeTab !== "transfer") $("arrival-dot").hidden = false;
  else $("arrival").scrollIntoView({ behavior: "smooth", block: "start" });
}

const dialog = $<HTMLDialogElement>("preview-dialog");
$("enlarge").addEventListener("click", () => {
  const f = tr?.file;
  if (!f) return;
  $("dialog-title").textContent = f.name;
  const large = createPreview(f, true);
  $("dialog-body").replaceChildren(large.element);
  dialog.showModal();
  dialog.addEventListener("close", () => large.release(), { once: true });
});
$("close-preview").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

$("copy").addEventListener("click", () => {
  const text = arrivalPreview?.text ?? null;
  if (text === null) return;
  void navigator.clipboard.writeText(text).then(
    () => log(`text copied (${text.length} characters).`),
    () => log("copy refused by the browser."),
  );
});
$("save").addEventListener("click", () => {
  if (!tr?.file) return;
  const result = saveFile(tr.file);
  log(result.message);
  // The result is VISIBLE, and the button does not duplicate the copy.
  const status = $("arrival-status");
  status.textContent = result.message;
  status.classList.toggle("failed", !result.ok);
  status.hidden = false;
  if (result.ok) {
    const button = $<HTMLButtonElement>("save");
    button.textContent = "Saved ✓";
    button.disabled = true;
  }
});
$("share").addEventListener("click", () => {
  const f = tr?.file;
  if (!f) return;
  void navigator.share({ files: [new File([f.data as BlobPart], f.name, { type: f.type })] }).catch(() => undefined);
});

function resetTransfer(message: string): void {
  stopTracking();
  tr?.session.dispose();
  tr = null;
  clearPreview();
  $("arrival").hidden = true;
  $("running-state").hidden = true;
  $("waiting-state").hidden = false;
  $("waiting-state").querySelector("p")!.textContent = "Waiting for a transfer.";
  $("arrival-dot").hidden = true;
  log(message);
}
$("new-transfer").addEventListener("click", () => resetTransfer("ready for a new transfer."));
$("abort").addEventListener("click", () => resetTransfer("transfer aborted."));

// ── Report: 16 pairs, verdict, mode recommendation ───────────────────────

$("report").addEventListener("click", async () => {
  if (!stream) {
    log("report: open the camera first.");
    return;
  }
  const codec = captureCodec();
  resetAll();
  const verdict = $("verdict");
  verdict.className = "";
  verdict.textContent = "Report in progress…";
  const pairs: Pair[] = [];
  await new Promise<void>((end) => {
    const limit = setTimeout(end, 15000);
    collector = (p) => {
      pairs.push(p);
      if (pairs.length >= 16) {
        clearTimeout(limit);
        end();
      }
    };
  });
  collector = null;
  if (pairs.length === 0) {
    verdict.className = "verdict-ko";
    verdict.textContent = "No R/P pair: show the fixed frame, frame the grid.";
    log("report: no R/P pair.");
    return;
  }
  const validCount = pairs.filter((p) => p.valid).length;
  const rate = validCount / pairs.length;
  const confidence = pairs.reduce((a, p) => a + p.confidence, 0) / pairs.length;
  const minConfidence = Math.min(...pairs.map((p) => p.confidence));
  const ok = rate >= 0.8;
  log(
    `report ${tmName(codec)} — ${pairs.length} pairs · valid frames ${pct(rate)} · ` +
      `mean confidence ${pct(confidence)} (min ${pct(minConfidence)}) · mixed ${pct(mixedCount / Math.max(1, imageCount))} · ` +
      `soft accumulation ${exactCumulative() ? "EXACT" : "inexact"}` +
      (lastLocation ? ` · perspective ${total(lastLocation.perspectiveSkew, 1)} mod.` : ""),
  );
  verdict.className = ok ? "verdict-ok" : "verdict-ko";
  verdict.textContent = ok
    ? `${tmName(codec)} validated: ${validCount}/${pairs.length} frames read`
    : codec === CODEC.COLOR_8
      ? `${tmName(codec)} insufficient (${validCount}/${pairs.length}): try TM4`
      : `${tmName(codec)} insufficient (${validCount}/${pairs.length}): check the framing`;
});

log("TM test bench ready — screen on one device, capture on the other.");

// ── Automatic calibration (Diagnostic tab) ────────────────────────────────
// 1. The sending screen plays the series of trials (sendCalibrationSeries).
// 2. The phone films it in slow motion, counts the frames of each trial,
//    recommends the best setting and gives a short code ("33-2").
// 3. Entered on the sender, the code sets the Transfer test tab — and stays
//    remembered for the next sendings from this computer.

const CALIBRATION_COUNTDOWN = 4;

const trialName = (e: { period: number; columns: number }) =>
  `${e.period} ms · ${e.columns === 1 ? "1 grid" : `${e.columns} × ${e.columns}`}`;

$("calibrate-send").addEventListener("click", () => void sendCalibration());

async function sendCalibration(): Promise<void> {
  const { canvas, hud, count } = openFullScreen("Calibration — trial series");
  const view = new TmDisplay(canvas, { ...FULL_SCREEN_OPTIONS, period: 100 });
  display = view;
  log(`calibration: ${Math.round(CALIBRATION_SERIES_DURATION / 1000)} s series after a ${CALIBRATION_COUNTDOWN} s countdown.`);
  const sentCount = await sendCalibrationSeries(view, {
    countdown: CALIBRATION_COUNTDOWN,
    stopped: () => !full.open || display !== view,
    onStep: (e) => {
      if (e.phase === "countdown") {
        count.hidden = false;
        count.innerHTML = `<span>${e.remaining}</span><small>start filming now, screen in frame</small>`;
        hud.textContent = `Calibration: starting in ${e.remaining} s — film in slow motion now`;
      } else if (e.phase === "pause") {
        count.hidden = true;
        hud.textContent = `Next trial: ${trialName(e.next)}`;
      } else if (e.phase === "trial") {
        count.hidden = true;
        hud.textContent = `Trial ${e.trial.id}/7 · ${trialName(e.trial)} · ${e.sentCount} frames — keep filming`;
      } else {
        count.hidden = false;
        count.innerHTML = `<span>✓</span><small>series complete: stop filming</small>`;
        hud.textContent = "Series complete. The phone reads the video and gives a code to enter here (step 3).";
      }
    },
  });
  if (sentCount.size) log(`calibration sent: ${[...sentCount].map(([id, n]) => `trial ${id} ${n} frames`).join(", ")}.`);
}

$("calibrate-film").addEventListener("click", () => void filmCalibration());
$<HTMLInputElement>("calibrate-video").addEventListener("change", (e) => {
  const field = e.target as HTMLInputElement;
  const file = field.files?.[0];
  field.value = "";
  if (file) void readCalibration(file, file.name);
});

let calibrationRecording: Recording | null = null;

async function filmCalibration(): Promise<void> {
  const state = $("calibrate-state");
  const button = $<HTMLButtonElement>("calibrate-film");
  // The whole series, countdown included, with some margin.
  const seconds = Math.ceil(CALIBRATION_SERIES_DURATION / 1000) + CALIBRATION_COUNTDOWN + 8;
  try {
    if (nativeSlowMotionAvailable()) {
      const opened = stream;
      closeBenchCamera();
      state.textContent = "Opening the slow-motion camera…";
      const v = await filmSlowMotion(seconds, opened);
      await readCalibration(v.video, `slow-mo ${v.frameRate} fps`);
      return;
    }
    if (calibrationRecording) {
      calibrationRecording.stop();
      return;
    }
    if (!stream) await open();
    if (!stream) return;
    const recording = filmStream(stream, seconds);
    calibrationRecording = recording;
    button.textContent = "Stop filming";
    state.textContent = "● Recording: aim at the sending screen until “series complete”.";
    try {
      const v = await recording.result;
      await readCalibration(v.video, "film");
    } finally {
      calibrationRecording = null;
      button.textContent = "Film the series";
    }
  } catch (e) {
    state.textContent = `Cannot film: ${(e as Error).message}`;
  }
}

async function readCalibration(file: Blob | EncodedVideo, name: string): Promise<void> {
  videoReading?.abort();
  closeBenchCamera();
  const control = new AbortController();
  videoReading = control;
  const state = $("calibrate-state");
  const loop = loopCell.checked;
  loopCell.checked = false;
  const measurement = new CalibrationMeasurement();
  state.textContent = `Reading the video (${name})…`;
  try {
    const end = await readTmVideo(file, {
      signal: control.signal,
      onFrame: (bytes) => {
        measurement.add(bytes);
      },
      onProgress: (p) => {
        const pct = p.duration ? Math.min(100, Math.round((100 * p.position) / p.duration)) : 0;
        state.textContent = `Reading ${pct} % · ${p.images} images · ${measurement.total} calibration frames read`;
      },
    });
    log(`calibration read (${name}): ${videoText(end)} · ${measurement.total} calibration frames.`);
    showCalibration(measurement);
  } catch (e) {
    if ((e as Error).name !== "AbortError") state.textContent = `Cannot read: ${(e as Error).message}`;
    else state.textContent = "Reading cancelled.";
  } finally {
    loopCell.checked = loop;
    if (videoReading === control) videoReading = null;
  }
}

function showCalibration(measurement: CalibrationMeasurement): void {
  const best = measurement.recommendation();
  const lines = $("calibrate-lines");
  lines.replaceChildren(
    ...measurement.results().map((e: TrialResult) => {
      const tr = document.createElement("tr");
      if (best && e.id === best.id) tr.className = "chosen";
      const part = Math.round(e.share * 100);
      const cellList = [
        trialName(e),
        e.sentCount ? `${e.readCount} / ${e.sentCount}` : "none",
        `<span class="bar-part"><i class="${e.share < 0.5 ? "weak" : ""}" style="width:${part}%"></i></span>${part} %`,
        e.readCount ? readableThroughput(e.throughput) : "—",
      ];
      tr.innerHTML = cellList.map((c) => `<td>${c}</td>`).join("");
      return tr;
    }),
  );
  $("calibrate-results").hidden = false;
  const state = $("calibrate-state");
  const bestElement = $("calibrate-advice");
  if (!best) {
    state.textContent = "No calibration frame read: was the sending screen in frame during the series?";
    bestElement.textContent = "No recommendation: run the series again, with the phone closer or steadier.";
    return;
  }
  const code = calibrationCode(best);
  state.textContent = `${measurement.total} calibration frames read.`;
  bestElement.innerHTML = `Recommended: <b>${trialName(best)}</b> · ≈ ${readableThroughput(best.throughput)} useful. Code to enter on the sender (step 3):<b class="code">${code}</b>`;
  saveCalibration(best, "receiver"); // false: the displayed code is enough
}

function applyCalibration(r: { period: number; columns: number }, source: string): void {
  sendModeSelector.value = "3";
  sendPeriodSelector.value = String(r.period);
  sendMosaicSelector.value = String(r.columns);
  updateEstimate();
  $("calibrate-applied").textContent = `${source}: TM8 · ${trialName(r)} set in the Transfer test tab.`;
}

$("calibrate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const field = $<HTMLInputElement>("calibrate-code");
  const r = readCalibrationCode(field.value);
  if (!r) {
    $("calibrate-applied").textContent = "Code not recognized: two numbers like “33-2” (duration in ms, then 1 to 7 grids per row).";
    return;
  }
  applyCalibration(r, `Code ${calibrationCode(r)} applied`);
  saveCalibration(r, "sender"); // false: applied for this session only
  log(`calibration applied: ${calibrationCode(r)}.`);
});

// A calibration already done on this computer sets the sendings as soon as it opens.
try {
  const r = loadCalibration();
  if (r?.side === "sender") {
    applyCalibration(r, "Saved calibration");
    $<HTMLInputElement>("calibrate-code").value = calibrationCode(r);
  }
} catch {
  // nothing saved
}
