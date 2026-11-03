/**
 * OPTICAL LAB — the whole ORP stack on ONE device, through a simulated camera.
 *
 *   SenderSession ──frames──▶ renderTmPair (R / P subframes, what a screen shows)
 *        ▲                          │
 *        │                    degradeImage  (blur, noise, perspective, tint, haze,
 *        │                          │        crosstalk, shake, rolling shutter, losses)
 *        │                          ▼
 *   finish() ◀── ReceiverSession ◀── TmReceiver.process (locate, photometry, decide, RS + CRC)
 *
 * Nothing is faked above the pixel level: the receiver only gets what the
 * optical decoder manages to read out of degraded RGBA images.
 */
import {
  CODEC,
  CryptoWebCrypto,
  INIT_CODE_SIZE,
  REVEAL_CODE_SIZE,
  RESPONSE_CODE_SIZE,
  ReceiverSession,
  SenderSession,
  pairingCodeKind,
  type Codec,
  type InitCodeInfo,
} from "@optirelay/core";
import {
  TmReceiver,
  applyH,
  degradeImage,
  renderTmPair,
  type ImageRGBA,
  type SimulationOptions,
  type TmImageResult,
} from "@optirelay/optical";
import {
  createPreview,
  isPairingFrame,
  pack,
  pairingFrame,
  pairingPayload,
  readableSize,
  saveFile,
  unpack,
  type Preview,
  type TransferredFile,
} from "@optirelay/browser";
import { $, $$, clamp, fmt, hex, paint, randomCode, rng, sampleImage, sasText, shownCode, sleep } from "./ui";
import { onLangChange, t, type Key } from "./i18n";

// ── Channel parameters ────────────────────────────────────────────────────

interface Params {
  loss: number;
  shutter: number;
  blur: number;
  noise: number;
  rotation: number;
  shake: number;
  perspective: number;
  distance: number;
  tint: number;
  crosstalk: number;
  haze: number;
}
interface Param {
  key: keyof Params;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

const PARAMS: Param[] = [
  { key: "loss", min: 0, max: 60, step: 1, unit: "%" },
  { key: "shutter", min: 0, max: 50, step: 1, unit: "%" },
  { key: "blur", min: 0, max: 3, step: 1, unit: "px" },
  { key: "noise", min: 0, max: 30, step: 1, unit: "σ" },
  { key: "rotation", min: -20, max: 20, step: 1, unit: "°" },
  { key: "shake", min: 0, max: 6, step: 0.5 },
  { key: "perspective", min: 0, max: 0.2, step: 0.01 },
  { key: "distance", min: 0.55, max: 1, step: 0.01, unit: "×" },
  { key: "tint", min: -1, max: 1, step: 0.05 },
  { key: "crosstalk", min: 0, max: 0.3, step: 0.01 },
  { key: "haze", min: 0, max: 80, step: 1 },
];

const PRESETS: Record<string, Params> = {
  ideal: { loss: 0, shutter: 0, blur: 0, noise: 0, rotation: 0, shake: 0, perspective: 0, distance: 1, tint: 0, crosstalk: 0, haze: 0 },
  hand: { loss: 12, shutter: 10, blur: 1, noise: 6, rotation: 4, shake: 1.5, perspective: 0.06, distance: 0.88, tint: 0.2, crosstalk: 0.05, haze: 6 },
  bright: { loss: 8, shutter: 8, blur: 1, noise: 10, rotation: -3, shake: 1, perspective: 0.04, distance: 0.85, tint: 0.45, crosstalk: 0.1, haze: 45 },
  hell: { loss: 40, shutter: 25, blur: 2, noise: 16, rotation: 11, shake: 3, perspective: 0.12, distance: 0.72, tint: -0.6, crosstalk: 0.16, haze: 30 },
};

const params: Params = { ...PRESETS.hand };

// ── State of a run ────────────────────────────────────────────────────────

type Source = "text" | "image" | "file";
let source: Source = "text";
let chosenFile: TransferredFile | null = null;
let running = false;
let abort = false;
let current: { sender: SenderSession; receiver: ReceiverSession; spy: ReceiverSession | null } | null = null;
let receivedFile: TransferredFile | null = null;
let preview: Preview | null = null;

const stats = { images: 0, located: 0, mixed: 0, valid: 0, lost: 0 };
let simClock = 0; // simulated time (ms) — what the TmReceiver sees
let random = rng(1);
let seed = 1;

const crypto = new CryptoWebCrypto();

// ── Log ───────────────────────────────────────────────────────────────────

type LogKind = "tx" | "rx" | "ch" | "sec" | "ok" | "bad";
function log(kind: LogKind, text: string): void {
  const list = $("#log");
  const li = document.createElement("li");
  li.dataset.kind = kind;
  const time = document.createElement("time");
  time.textContent = `${(simClock / 1000).toFixed(2)} s`;
  const k = document.createElement("span");
  k.className = "k";
  k.dataset.i18n = `log.k.${kind}`; // the badge follows the language; the message keeps the one it was written in
  k.textContent = t(`log.k.${kind}` as Key);
  const m = document.createElement("span");
  m.textContent = text;
  li.append(time, k, m);
  list.prepend(li);
  while (list.children.length > 220) list.lastElementChild!.remove();
}

// ── Simulated camera ──────────────────────────────────────────────────────

function simOptions(): SimulationOptions {
  const p = params;
  const r = () => random() * 2 - 1;
  const c = p.crosstalk;
  const o: SimulationOptions = {
    scale: p.distance,
    rotationDegrees: p.rotation + r() * p.shake * 0.5,
    translation: [r() * p.shake * 3, r() * p.shake * 3],
    perspective: [p.perspective, p.perspective * 0.45],
    gains: [clamp(1 + 0.22 * p.tint, 0.4, 1.6), 1, clamp(1 - 0.32 * p.tint, 0.4, 1.6)],
    blur: p.blur,
    noise: p.noise,
    seed: seed++,
    moduleSize: 8,
  };
  if (c > 0) o.matrix = [[1 - c, c * 0.7, c * 0.3], [c * 0.5, 1 - c, c * 0.5], [c * 0.3, c * 0.7, 1 - c]];
  if (p.haze > 0) o.haze = [p.haze, p.haze * 0.95, p.haze * 0.85];
  return o;
}

/** Rolling shutter: the top of the image still shows the previous subframe. */
function mixed(prev: ImageRGBA, next: ImageRGBA): ImageRGBA {
  const data = new Uint8ClampedArray(next.data);
  const cut = Math.floor(next.height * (0.3 + random() * 0.4)) * next.width * 4;
  data.set(prev.data.subarray(0, cut), 0);
  return { width: next.width, height: next.height, data };
}

const period = () => Number($<HTMLSelectElement>("#speed").value);

/** Turbo yields to the event loop only — requestAnimationFrame is throttled in occluded windows. */
const pace = () => sleep(period());

let lastScreen: ImageRGBA | null = null;

/**
 * Shows one subframe on a "screen" and lets a simulated camera capture it.
 * Returns the TmReceiver result, or null if the camera missed the image.
 */
async function showAndCapture(img: ImageRGBA, kind: "R" | "P", cam: TmReceiver, screen: HTMLCanvasElement): Promise<TmImageResult | null> {
  paint(screen, img);
  const pill = $("#tx-phase");
  pill.dataset.i18n = kind === "R" ? "lab.pill.R" : "lab.pill.P";
  pill.textContent = t(pill.dataset.i18n as Key);
  pill.className = `pill ${kind}`;
  simClock += Math.max(period(), 33);
  const prev = lastScreen;
  lastScreen = img;

  if (random() * 100 < params.loss) {
    stats.lost++;
    showCaptured(null, "lost");
    await pace();
    return null;
  }
  const source = prev && prev !== img && random() * 100 < params.shutter ? mixed(prev, img) : img;
  const captured = degradeImage(source, simOptions());
  const res = cam.process(captured, simClock);
  stats.images++;
  if (res.location) stats.located++;
  if (res.subframe?.type === "mixed") stats.mixed++;
  showCaptured(captured, res);
  await pace();
  return res;
}

function showCaptured(img: ImageRGBA | null, res: TmImageResult | "lost"): void {
  const cam = $<HTMLCanvasElement>("#ch-cam");
  const overlay = $<HTMLCanvasElement>("#ch-overlay");
  const kind = $("#ch-kind");
  const advice = $("#ch-advice");
  const o = overlay.getContext("2d")!;
  o.clearRect(0, 0, overlay.width, overlay.height);
  delete advice.dataset.i18n;
  if (res === "lost" || !img) {
    const c = cam.getContext("2d")!;
    c.fillStyle = "rgba(8,10,14,.82)";
    c.fillRect(0, 0, cam.width, cam.height);
    kind.textContent = t("lab.ch.lost");
    kind.className = "pill lost";
    advice.textContent = t("lab.ch.lostAdvice");
    updateStats();
    return;
  }
  paint(cam, img);
  overlay.width = img.width;
  overlay.height = img.height;
  const type = res.subframe?.type;
  kind.textContent = !res.location
    ? t("lab.ch.notLocated")
    : type === "mixed"
      ? t("lab.ch.mixed")
      : res.frame
        ? t("lab.ch.valid", { type: type ?? "?" })
        : (type ?? "?");
  kind.className = `pill ${!res.location ? "lost" : type === "mixed" ? "mixed" : res.frame ? "ok" : (type ?? "")}`;
  // `res.advice` comes from @optirelay/optical, which only speaks English.
  advice.textContent = res.advice || (res.invalidPair ? t("lab.ch.invalidPair") : t("lab.ch.located"));
  const loc = res.location;
  if (!loc) {
    updateStats();
    return;
  }
  const lw = Math.max(1.5, img.width / 220);
  o.lineWidth = lw;
  o.strokeStyle = type === "mixed" ? "#ff6363" : "#00e5d4";
  o.beginPath();
  const corners: [number, number][] = [[-0.5, -0.5], [40.5, -0.5], [40.5, 40.5], [-0.5, 40.5]];
  corners.forEach(([x, y], i) => {
    const [px, py] = applyH(loc.h, x, y);
    if (i === 0) o.moveTo(px, py);
    else o.lineTo(px, py);
  });
  o.closePath();
  o.stroke();
  o.fillStyle = "#ffd23f";
  for (const [x, y] of loc.finders) {
    o.beginPath();
    o.arc(x, y, lw * 3, 0, Math.PI * 2);
    o.fill();
  }
  if (loc.alignment) {
    o.fillStyle = "#ff3d9a";
    o.beginPath();
    o.arc(loc.alignment[0], loc.alignment[1], lw * 3, 0, Math.PI * 2);
    o.fill();
  }
  if (res.frame) {
    const g = res.frame.measurement.gains;
    const max = Math.max(...g, 1e-6);
    (["r", "g", "b"] as const).forEach((c, i) => ($(`#g-${c}`).style.height = `${clamp((g[i] / max) * 100, 4, 100)}%`));
    $("#g-text").textContent = t("lab.rx.gainsText", {
      r: g[0].toFixed(2),
      g: g[1].toFixed(2),
      b: g[2].toFixed(2),
      x: (res.frame.measurement.crosstalk * 100).toFixed(0),
    });
    $("#st-conf").textContent = `${(res.frame.confidence * 100).toFixed(0)} %`;
  }
  updateStats();
}

/** Sends a pairing code through the channel until the other side decodes it. */
async function transmitCode(payload: Uint8Array, size: number, kind: "init" | "response" | "reveal", cam: TmReceiver, screen: HTMLCanvasElement): Promise<Uint8Array> {
  const { reference, payload: p } = renderTmPair(pairingFrame(payload), CODEC.COLOR_4, { moduleSize: 8, quietZone: 5 });
  setCaption(kind === "response" ? "lab.tx.receiverScreen" : "lab.tx.screen");
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const [img, k] of [[reference, "R"], [p, "P"]] as const) {
      if (abort) throw new Aborted();
      const res = await showAndCapture(img, k, cam, screen);
      if (res?.frame && isPairingFrame(res.frame.bytes)) {
        const code = pairingPayload(res.frame.bytes, size);
        if (code && pairingCodeKind(code) === kind) {
          stats.valid++;
          return code;
        }
      }
    }
  }
  throw new Error(t("lab.ch.tooDegraded", { kind }));
}

class Aborted extends Error {}

function setCaption(key: Key): void {
  const el = $("#tx-caption");
  el.dataset.i18n = key; // re-translated on language change
  el.textContent = t(key);
}

// ── Run ───────────────────────────────────────────────────────────────────

async function payloadToSend(): Promise<TransferredFile> {
  if (source === "image") return sampleImage();
  if (source === "file") {
    if (!chosenFile) throw new Error(t("lab.tx.pickFile"));
    return chosenFile;
  }
  return { name: "message.txt", type: "text/plain;charset=utf-8", data: new TextEncoder().encode($<HTMLTextAreaElement>("#tx-text").value || "Hello world") };
}

/** The verdict is kept as a key so a language switch re-renders it. */
let spyMsg: { key: Key; vars?: Record<string, string | number> } = { key: "lab.spy.waiting" };

function setSpyVerdict(key: Key, vars?: Record<string, string | number>): void {
  spyMsg = { key, vars };
  const v = $("#spy-verdict");
  v.textContent = t(key, vars);
  v.className = key === "lab.spy.waiting" ? "verdict" : "verdict safe";
}

function resetUi(): void {
  Object.assign(stats, { images: 0, located: 0, mixed: 0, valid: 0, lost: 0 });
  simClock = 0;
  random = rng((Math.random() * 2 ** 32) >>> 0);
  lastScreen = null;
  for (const id of ["tx-frames", "tx-symbols", "spy-seen", "spy-forged", "st-replays", "st-corrupt"]) $(`#${id}`).textContent = "0";
  for (const id of ["tx-sas", "spy-sas", "spy-guess", "st-conf", "g-text"]) $(`#${id}`).textContent = "—";
  $$("#rx-steps li").forEach((li) => li.removeAttribute("data-state"));
  $("#rx-result").hidden = true;
  $("#rx-sas-box").hidden = true;
  $("#rx-typing").hidden = true;
  $("#tx-secret").hidden = true;
  $("#rx-blocks").replaceChildren();
  $("#rx-sym").textContent = "0 / K";
  $("#rx-bar").style.width = "0";
  $("#rx-kmark").style.left = "100%";
  setSpyVerdict("lab.spy.waiting");
  preview?.release();
  preview = null;
  receivedFile = null;
  updateStats();
}

function step(name: string, state: "active" | "done" | "bad"): void {
  $(`#rx-steps li[data-step="${name}"]`).dataset.state = state;
}

function updateStats(): void {
  $("#st-images").textContent = fmt(stats.images);
  $("#st-located").textContent = fmt(stats.located);
  $("#st-mixed").textContent = fmt(stats.mixed);
  $("#st-valid").textContent = fmt(stats.valid);
  $("#st-lost").textContent = fmt(stats.lost);
}

async function typeCode(code: string): Promise<void> {
  $("#rx-typing").hidden = false;
  const field = $("#rx-typed");
  field.textContent = "";
  for (const ch of shownCode(code)) {
    if (abort) throw new Aborted();
    field.textContent += ch;
    await sleep(period() === 0 ? 8 : 45);
  }
}

async function showSas(tx: string, rx: string): Promise<void> {
  $("#rx-sas-box").hidden = false;
  $("#cmp-tx").textContent = sasText(tx);
  $("#cmp-rx").textContent = sasText(rx);
  const eq = $("#cmp-eq");
  eq.textContent = tx === rx ? "=" : "≠";
  eq.className = `eq ${tx === rx ? "ok" : "bad"}`;
  await sleep(period() === 0 ? 150 : 700);
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  abort = false;
  resetUi();
  $<HTMLButtonElement>("#run").disabled = true;
  $<HTMLButtonElement>("#stop").disabled = false;

  const codec = Number($<HTMLSelectElement>("#tx-codec").value) as Codec;
  const pairing = $<HTMLSelectElement>("#tx-pairing").value as "passphrase" | "codes";
  const txScreen = $<HTMLCanvasElement>("#tx-screen");

  const sender = new SenderSession(crypto, { pairing, codecs: [codec] });
  const receiver = new ReceiverSession(crypto);
  const spy = pairing === "passphrase" ? new ReceiverSession(crypto) : null;
  current = { sender, receiver, spy };
  const rxCam = new TmReceiver(); // the receiver's camera
  const spyCam = { seen: 0, forged: 0 };
  const t0 = performance.now();

  let code = "";
  let txSas = "";
  let finished = false;
  let info = null as InitCodeInfo | null;

  const showInfo = (i: InitCodeInfo) => {
    info = i;
    step("init", "done");
    log(
      "rx",
      t("log.init", {
        sid: hex(i.sessionId, 4),
        size: readableSize(i.streamSize),
        compressed: i.compressed ? t("log.compressed") : "",
        blocks: i.blockCount,
        k: i.kTotal,
        mode: t(i.byPassphrase ? "log.modePass" : "log.modeEcdh"),
      }),
    );
    $("#rx-kmark").style.left = "100%";
    $("#rx-sym").textContent = `0 / ${i.kTotal}`;
  };

  try {
    const file = await payloadToSend();
    const bytes = pack(file);
    $("#tx-size").textContent = readableSize(file.data.length);

    log("tx", t("log.prepare", { size: readableSize(bytes.length), name: file.name }));
    await sender.prepare(bytes);

    let symbolsSent = 0;
    sender.events.on("frame", ({ symbolCount }) => {
      symbolsSent += symbolCount;
      $("#tx-symbols").textContent = fmt(symbolsSent);
    });
    sender.events.on("progress", ({ sentFrames }) => ($("#tx-frames").textContent = fmt(sentFrames)));
    receiver.events.on("rejection", ({ reason }) => {
      if (reason === "rejeu") $("#st-replays").textContent = fmt(receiver.progress().replays);
      else if (reason === "corrompue") $("#st-corrupt").textContent = fmt(receiver.progress().corrupted);
      if (reason === "falsifiee") log("bad", t("log.forged"));
    });
    receiver.events.on("block", ({ block }) => log("rx", t("log.block", { i: block })));

    // ── Pairing ──────────────────────────────────────────────────────────
    if (pairing === "passphrase") {
      code = randomCode();
      $("#tx-secret").hidden = false;
      $("#tx-code").textContent = shownCode(code);
      log("sec", t("log.codeDrawn", { code: shownCode(code) }));
      await sender.receivePassphrase(code);
      txSas = sender.sas(); // only readable before confirmSas()
      $("#tx-sas").textContent = sasText(txSas);
      sender.confirmSas();
      log("sec", t("log.senderKdf"));
    } else {
      step("init", "active");
      log("tx", t("log.showInit"));
      const initCode = await transmitCode(sender.initCode(), INIT_CODE_SIZE, "init", rxCam, txScreen);
      showInfo(receiver.scanInitCode(initCode));
      step("pair", "active");
      log("rx", t("log.showResponse"));
      const txCam = new TmReceiver(); // the sender's camera, filming the receiver screen
      const response = await transmitCode(await receiver.responseCode(), RESPONSE_CODE_SIZE, "response", txCam, txScreen);
      await sender.receiveResponseCode(response);
      log("tx", t("log.responseRead"));
      const reveal = await transmitCode(sender.revealCode(), REVEAL_CODE_SIZE, "reveal", rxCam, txScreen);
      await receiver.receiveRevealCode(reveal);
      log("sec", t("log.reveal"));
      step("pair", "done");
      step("sas", "active");
      const s1 = sender.sas();
      const s2 = receiver.sas();
      $("#tx-sas").textContent = sasText(s1);
      await showSas(s1, s2);
      sender.confirmSas();
      receiver.confirmSas();
      step("sas", "done");
      log("ok", t("log.sasEcdh", { sas: sasText(s1) }));
      $("#spy-guess").textContent = t("lab.spy.none");
      setSpyVerdict("lab.spy.ecdh");
    }

    // ── Transmission ─────────────────────────────────────────────────────
    setCaption("lab.tx.screen");
    const init = pairingFrame(sender.initCode());
    const initPair = renderTmPair(init, CODEC.COLOR_4, { moduleSize: 8, quietZone: 5 });
    let paired = pairing === "codes";
    let spyPaired = false;

    const onFrame = async (frame: Uint8Array) => {
      stats.valid++;
      if (isPairingFrame(frame)) {
        if (info) return;
        const c = pairingPayload(frame, INIT_CODE_SIZE);
        if (!c || pairingCodeKind(c) !== "init") return;
        showInfo(receiver.scanInitCode(c));
        // The eavesdropper reads the same init code and makes a guess.
        if (spy) {
          spy.scanInitCode(c);
          const guess = randomCode();
          $("#spy-guess").textContent = shownCode(guess);
          await spy.pairWithPassphrase(guess);
          $("#spy-sas").textContent = sasText(spy.sas());
          spy.confirmSas();
          spyPaired = true;
          log("bad", t("log.spyGuess", { code: shownCode(guess) }));
        }
        step("pair", "active");
        await typeCode(code);
        log("rx", t("log.typed"));
        await receiver.pairWithPassphrase(code);
        step("pair", "done");
        step("sas", "active");
        const rxSas = receiver.sas(); // only readable before confirmSas()
        await showSas(txSas, rxSas);
        receiver.confirmSas();
        step("sas", "done");
        log("ok", t("log.sasPass", { sas: sasText(rxSas) }));
        paired = true;
        return;
      }
      if (spy && spyPaired) {
        spyCam.seen++;
        const st = await spy.receiveFrame(frame.slice());
        if (!st.accepted && st.rejection === "falsifiee") spyCam.forged++;
        $("#spy-seen").textContent = fmt(spyCam.seen);
        $("#spy-forged").textContent = fmt(spyCam.forged);
        setSpyVerdict("lab.spy.rejected", { n: fmt(spyCam.forged) });
      }
      if (!paired || finished) return;
      step("data", "active");
      const st = await receiver.receiveFrame(frame.slice());
      renderProgress(receiver, info?.kTotal ?? 0);
      if (st.accepted && receiver.done) {
        finished = true;
        sender.finish();
      }
    };

    await sender.start(async (frame) => {
      if (abort) {
        sender.cancel();
        return;
      }
      const cycles: [ImageRGBA, ImageRGBA][] = [];
      if (pairing === "passphrase") cycles.push([initPair.reference, initPair.payload]);
      const pair = renderTmPair(frame, codec, { moduleSize: 8, quietZone: 5 });
      cycles.push([pair.reference, pair.payload]);
      for (const [r, p] of cycles) {
        for (const [img, k] of [[r, "R"], [p, "P"]] as const) {
          if (abort || finished) return;
          const res = await showAndCapture(img, k, rxCam, txScreen);
          if (res?.frame?.isNew) await onFrame(res.frame.bytes);
        }
      }
    });

    if (abort) throw new Aborted();

    // ── Result ───────────────────────────────────────────────────────────
    const { data, verified } = await receiver.result();
    step("data", "done");
    step("ok", verified ? "done" : "bad");
    receivedFile = unpack(data);
    const p = receiver.progress();
    const k = info?.kTotal ?? 1;
    log("ok", t("log.received", { name: receivedFile.name, size: readableSize(receivedFile.data.length), verdict: t(verified ? "log.sha.ok" : "log.sha.bad") }));
    showResult(receivedFile, [
      ["lab.sum.simTime", `${(simClock / 1000).toFixed(1)} s`],
      ["lab.sum.cpu", `${((performance.now() - t0) / 1000).toFixed(1)} s`],
      ["lab.sum.symbols", t("lab.sum.symbolsVal", { n: p.receivedSymbols, k })],
      ["lab.sum.overhead", `${fmt(((p.receivedSymbols - k) / k) * 100)} %`],
      ["lab.sum.images", fmt(stats.images)],
      ["lab.sum.lostMixed", `${fmt(stats.lost)} / ${fmt(stats.mixed)}`],
      ["lab.sum.frames", fmt(sender.sentFrames)],
      ["lab.sum.rate", `${readableSize(Math.round(data.length / Math.max(simClock / 1000, 0.001)))}/s`],
    ]);
    if (spy) setSpyVerdict("lab.spy.end", { n: fmt(spyCam.seen) });
  } catch (e) {
    if (e instanceof Aborted) log("bad", t("log.stopped"));
    else {
      console.error(e);
      log("bad", (e as Error).message);
    }
    step("ok", "bad");
  } finally {
    sender.dispose();
    receiver.dispose();
    spy?.dispose();
    current = null;
    running = false;
    $<HTMLButtonElement>("#run").disabled = false;
    $<HTMLButtonElement>("#stop").disabled = true;
  }
}

let lastBlocks: { k: number; received: number; complete: boolean }[] = [];

function renderProgress(receiver: ReceiverSession, kTotal: number): void {
  const p = receiver.progress();
  lastBlocks = receiver.blocks().slice(0, 32);
  $("#rx-sym").textContent = `${p.receivedSymbols} / ${kTotal}`;
  const scale = Math.max(kTotal * 1.25, p.receivedSymbols);
  $("#rx-bar").style.width = `${(p.receivedSymbols / scale) * 100}%`;
  $("#rx-kmark").style.left = `${(kTotal / scale) * 100}%`;
  renderBlocks();
  $("#st-replays").textContent = fmt(p.replays);
  $("#st-corrupt").textContent = fmt(p.corrupted);
}

function renderBlocks(): void {
  const box = $("#rx-blocks");
  if (box.children.length !== lastBlocks.length) {
    box.replaceChildren(
      ...lastBlocks.map(() => {
        const d = document.createElement("div");
        d.className = "blk";
        d.append(document.createElement("i"));
        return d;
      }),
    );
  }
  lastBlocks.forEach((b, i) => {
    const el = box.children[i] as HTMLElement;
    el.classList.toggle("done", b.complete);
    (el.firstElementChild as HTMLElement).style.width = `${clamp((b.received / Math.max(b.k, 1)) * 100, 0, 100)}%`;
    el.title = t(b.complete ? "lab.rx.blockDone" : "lab.rx.block", { i, received: b.received, k: b.k });
  });
}

let lastSummary: [Key, string][] = [];

function showResult(file: TransferredFile, summary: [Key, string][]): void {
  $("#rx-result").hidden = false;
  $("#rx-name").textContent = `${file.name} · ${readableSize(file.data.length)}`;
  preview?.release();
  preview = createPreview(file);
  $("#rx-preview").replaceChildren(preview.element);
  lastSummary = summary;
  renderSummary();
}

function renderSummary(): void {
  $("#rx-summary").replaceChildren(
    ...lastSummary.map(([k, v]) => {
      const d = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = t(k);
      const dd = document.createElement("dd");
      dd.textContent = v;
      d.append(dt, dd);
      return d;
    }),
  );
}

// ── Controls ──────────────────────────────────────────────────────────────

function buildSliders(): void {
  const box = $("#sliders");
  box.replaceChildren(
    ...PARAMS.map((p) => {
      const label = document.createElement("label");
      label.className = "slider";
      label.dataset.i18nTitle = `param.${p.key}.hint`;
      label.title = t(`param.${p.key}.hint` as Key);
      const name = document.createElement("span");
      name.dataset.i18n = `param.${p.key}`;
      name.textContent = t(`param.${p.key}` as Key);
      const out = document.createElement("output");
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step);
      input.dataset.key = p.key;
      const sync = () => {
        const v = Number(input.value);
        params[p.key] = v;
        out.textContent = `${p.step < 1 ? v.toFixed(2) : v}${p.unit ? ` ${p.unit}` : ""}`;
        input.style.setProperty("--pct", `${((v - p.min) / (p.max - p.min)) * 100}%`);
      };
      input.addEventListener("input", () => {
        sync();
        $$("[data-preset]").forEach((b) => b.classList.remove("on"));
      });
      input.value = String(params[p.key]);
      sync();
      label.append(name, out, input);
      return label;
    }),
  );
}

function applyPreset(name: string): void {
  Object.assign(params, PRESETS[name]);
  $$<HTMLInputElement>("#sliders input").forEach((i) => {
    i.value = String(params[i.dataset.key as keyof Params]);
    i.dispatchEvent(new Event("input"));
  });
  $$("[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === name));
}

export function initLab(): void {
  const textarea = $<HTMLTextAreaElement>("#tx-text");
  textarea.value = t("sample.text");
  buildSliders();
  setCaption("lab.tx.screen");
  setSpyVerdict("lab.spy.waiting");
  $$<HTMLButtonElement>("[data-preset]").forEach((b) => (b.onclick = () => applyPreset(b.dataset.preset!)));
  $$<HTMLButtonElement>("[data-src]").forEach((b) => {
    b.onclick = () => {
      source = b.dataset.src as Source;
      $$("[data-src]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      textarea.hidden = source !== "text";
      $("#tx-file-box").hidden = source !== "file";
      if (source === "image") $("#tx-size").textContent = t("lab.tx.imageSize");
    };
  });
  $<HTMLInputElement>("#tx-file").onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    const info = $("#tx-file-info");
    delete info.dataset.i18n; // now shows the file, not the "No file" label
    if (!f) return;
    if (f.size > 256 * 1024) {
      info.textContent = t("lab.tx.tooBig", { name: f.name, size: readableSize(f.size) });
      chosenFile = null;
      return;
    }
    chosenFile = { name: f.name, type: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) };
    info.textContent = `${f.name} · ${readableSize(f.size)}`;
  };
  $<HTMLButtonElement>("#run").onclick = () => void run();
  $<HTMLButtonElement>("#stop").onclick = () => {
    abort = true;
    current?.sender.cancel();
  };
  $<HTMLButtonElement>("#rx-save").onclick = () => {
    if (receivedFile) saveFile(receivedFile);
  };
  $<HTMLButtonElement>("#log-clear").onclick = () => $("#log").replaceChildren();

  // Language change: swap the sample text if untouched, re-render what JS rendered.
  let sample = textarea.value;
  onLangChange(() => {
    if (textarea.value === sample) textarea.value = sample = t("sample.text");
    else sample = t("sample.text");
    setSpyVerdict(spyMsg.key, spyMsg.vars);
    renderBlocks();
    renderSummary();
  });

  // Idle screen: the init code of a dummy session, so the panels are not empty.
  const idle = renderTmPair(pairingFrame(new Uint8Array(INIT_CODE_SIZE).map((_, i) => (i * 37) & 255)), CODEC.COLOR_4, { moduleSize: 8, quietZone: 5 });
  paint($<HTMLCanvasElement>("#tx-screen"), idle.payload);
  const pill = $("#tx-phase");
  pill.dataset.i18n = "lab.tx.idle";
  pill.textContent = t("lab.tx.idle");
  paint($<HTMLCanvasElement>("#ch-cam"), degradeImage(idle.payload, simOptions()));
  const advice = $("#ch-advice");
  advice.dataset.i18n = "lab.ch.camera";
  advice.textContent = t("lab.ch.camera");
  log("ch", t("log.ready"));
}
