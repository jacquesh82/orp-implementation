/**
 * REAL TRANSFER — two devices, a real screen and a real camera.
 * Same flow as examples/secure-hello-world of @optirelay/browser, plus files,
 * codec choice, auto module size, progress tracking and in-place preview.
 */
import { CODEC, CryptoWebCrypto, INIT_CODE_SIZE, ReceiverSession, SenderSession, pairingCodeKind, type Codec } from "@optirelay/core";
import {
  COMFORT_MODULE,
  COMFORT_MODULE_CSS,
  SendThroughput,
  autoModuleSize,
  TmDisplay,
  TmReader,
  TransferTracker,
  closeCamera,
  createPreview,
  detectCapabilities,
  isPairingFrame,
  moduleDiagnostic,
  openCamera,
  pack,
  pairingFrame,
  pairingPayload,
  readableDuration,
  readableSize,
  readableThroughput,
  saveFile,
  unpack,
  type Preview,
  type TransferredFile,
} from "@optirelay/browser";
import { applyH } from "@optirelay/optical";
import { $, $$, CODE_LENGTH, fmt, normalizedCode, randomCode, sasText, shownCode } from "./ui";
import { onLangChange, t, type Key } from "./i18n";

let liveSource: "text" | "file" = "text";
let liveFile: TransferredFile | null = null;
let cleanup: (() => void) | null = null;

type Vars = Record<string, string | number>;
/** Last status message, kept as a key so a language switch can re-render it. */
let status: { key: Key; vars?: Vars; bad?: boolean } | null = null;
let modulePx = 0;
/** Mosaic of the sending in progress (columns), and whether it was chosen automatically. */
let mosaic = { columns: 1, auto: false };

/** Largest mosaic offered: beyond 4 × 4 a phone rarely reads the modules. */
const MAX_COLUMNS = 4;
/** In a mosaic, the init code takes one cell every BATCH_CODE batches. */
const BATCH_CODE = 3;

/**
 * "Automatic" mosaic: the most grids whose modules stay comfortable to film
 * on THIS screen — ≥ COMFORT_MODULE physical pixels and ≥ COMFORT_MODULE_CSS
 * CSS pixels (same thresholds as moduleDiagnostic of @optirelay/browser).
 */
function automaticColumns(width: number, height: number): number {
  const density = devicePixelRatio || 1;
  const comfort = Math.max(COMFORT_MODULE, COMFORT_MODULE_CSS * density);
  for (let columns = MAX_COLUMNS; columns > 1; columns--) {
    if (autoModuleSize(width, height, columns, density) >= comfort) return columns;
  }
  return 1;
}

function renderColumns(): void {
  const key = mosaic.auto ? "live.gridsShownAuto" : "live.gridsShown";
  $("#live-columns").textContent = mosaic.columns === 1 ? t("live.grids1") : t(key, { n: mosaic.columns });
}

function setStatus(key: Key, vars?: Vars, bad = false): void {
  status = { key, vars, bad };
  renderStatus();
}

function renderStatus(): void {
  const el = $("#live-status");
  el.textContent = status ? t(status.key, status.vars) : "";
  el.classList.toggle("bad", !!status?.bad);
}

function show(role: "choice" | "sender" | "receiver"): void {
  $("#live-choice").hidden = role !== "choice";
  $("#live-sender").hidden = role !== "sender";
  $("#live-receiver").hidden = role !== "receiver";
}

function back(): void {
  cleanup?.();
  cleanup = null;
  show("choice");
}

// ── Sending ───────────────────────────────────────────────────────────────

async function send(): Promise<void> {
  const file: TransferredFile =
    liveSource === "file" && liveFile
      ? liveFile
      : { name: "message.txt", type: "text/plain;charset=utf-8", data: new TextEncoder().encode($<HTMLTextAreaElement>("#live-text").value || "Hello world") };
  const codec = Number($<HTMLSelectElement>("#live-codec").value) as Codec;
  show("sender");
  const code = randomCode();
  const session = new SenderSession(new CryptoWebCrypto(), { pairing: "passphrase", codecs: [codec] });
  await session.prepare(pack(file));
  await session.receivePassphrase(code);
  $("#live-code").textContent = shownCode(code);
  $("#live-sas").textContent = sasText(session.sas());
  $("#live-size").textContent = readableSize(file.data.length);
  session.confirmSas();

  const stage = $("#live-stage");
  const choice = $<HTMLSelectElement>("#live-grids").value;
  const columnsNow = () =>
    choice === "auto" ? automaticColumns(stage.clientWidth, stage.clientHeight) : Number(choice);
  mosaic = { columns: columnsNow(), auto: choice === "auto" };
  renderColumns();
  const display = new TmDisplay($<HTMLCanvasElement>("#live-canvas"), {
    moduleSize: "auto",
    box: () => ({ width: stage.clientWidth, height: stage.clientHeight }),
    onModule: (px, columns) => {
      modulePx = px;
      $("#live-module").textContent = t("live.modulePx", { px });
      // The diagnostic sentence comes from @optirelay/browser (English only).
      const d = moduleDiagnostic(px, columns, devicePixelRatio);
      const diag = $("#live-diag");
      diag.textContent = d.message;
      diag.dataset.level = d.level;
    },
  });
  display.subframeDuration = Number($<HTMLSelectElement>("#live-period").value);
  const throughput = new SendThroughput();
  const init = pairingFrame(session.initCode());
  let stopped = false;
  cleanup = () => {
    stopped = true;
    session.finish();
    display.stop();
    session.dispose();
  };
  // One grid: the init code before each frame. Mosaic: the frames are held
  // until a batch fills the screen, the init code taking one cell every
  // BATCH_CODE batches — a receiver can start at any moment either way.
  let batch: Uint8Array[] = [];
  let batches = 0;
  const hud = () => {
    $("#live-frames").textContent = fmt(session.sentFrames);
    $("#live-thr").textContent = readableThroughput(throughput.throughput);
  };
  await session.start(async (frame) => {
    if (stopped) return;
    throughput.frame(frame);
    if (mosaic.columns === 1) {
      await display.show(init, CODEC.COLOR_4, 1);
      await display.show(frame, codec, 2);
      hud();
      return;
    }
    const cells = mosaic.columns * mosaic.columns;
    const withCode = batches % BATCH_CODE === 0;
    batch.push(frame);
    if (batch.length < cells - (withCode ? 1 : 0)) return;
    const shown = withCode ? [init, ...batch] : batch;
    batch = [];
    batches++;
    await display.showBatch(shown, mosaic.columns, 2);
    hud();
    // "Automatic": the screen may have changed (rotation, window resized).
    if (mosaic.auto) {
      const columns = columnsNow();
      if (columns !== mosaic.columns) {
        mosaic.columns = columns;
        renderColumns();
      }
    }
  });
}

// ── Receiving ─────────────────────────────────────────────────────────────

async function receive(): Promise<void> {
  show("receiver");
  setStatus("live.opening");
  $("#live-result").hidden = true;
  $("#live-meter").hidden = true;
  $("#live-compare").hidden = true;
  $("#live-code-form").hidden = true;

  const stream = await openCamera({ rearFacing: true });
  const video = $<HTMLVideoElement>("#live-video");
  video.srcObject = stream;
  await video.play();
  setStatus("live.aim");

  const cryptoProvider = new CryptoWebCrypto();
  let session = new ReceiverSession(cryptoProvider);
  let initCode: Uint8Array | null = null;
  let tracker: TransferTracker | null = null;
  let forged = 0;
  let preview: Preview | null = null;
  let queue = Promise.resolve();
  const overlay = $<HTMLCanvasElement>("#live-overlay");

  const reader = new TmReader(video, {
    stream,
    onFrame: (bytes) => {
      queue = queue.then(() => frameRead(bytes)).catch((e) => console.warn("[live]", e));
    },
    onImage: (result, image, all) => {
      $("#live-advice").textContent = result.advice; // framing advice from @optirelay/optical (English)
      overlay.width = image.width;
      overlay.height = image.height;
      const o = overlay.getContext("2d")!;
      o.clearRect(0, 0, image.width, image.height);
      o.lineWidth = Math.max(2, image.width / 300);
      // One outline per grid found: a mosaic of 2 × 2 to 4 × 4 shows several.
      for (const r of all.length ? all : [result]) {
        const loc = r.location;
        if (!loc) continue;
        o.strokeStyle = r.frame ? "#4cd98a" : "#428fff";
        o.beginPath();
        ([[-0.5, -0.5], [40.5, -0.5], [40.5, 40.5], [-0.5, 40.5]] as const).forEach(([x, y], i) => {
          const [px, py] = applyH(loc.h, x, y);
          if (i) o.lineTo(px, py);
          else o.moveTo(px, py);
        });
        o.closePath();
        o.stroke();
      }
    },
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    reader.close();
    closeCamera(stream);
    session.dispose();
    preview?.release();
  };
  cleanup = close;

  function newSession(): void {
    session.dispose();
    session = new ReceiverSession(cryptoProvider);
    session.scanInitCode(initCode!);
    forged = 0;
    session.events.on("rejection", ({ reason }) => {
      if (reason === "falsifiee" && ++forged === 3) askCode("live.wrongCode");
    });
  }

  function askCode(key: Key, vars?: Vars): void {
    setStatus(key, vars);
    $("#live-compare").hidden = true;
    $("#live-code-form").hidden = false;
    $<HTMLInputElement>("#live-code-input").value = "";
    $("#live-code-input").focus();
  }

  $<HTMLFormElement>("#live-code-form").onsubmit = (e) => {
    e.preventDefault();
    const typed = normalizedCode($<HTMLInputElement>("#live-code-input").value);
    if (typed.length !== CODE_LENGTH) return askCode("live.codeLength", { n: CODE_LENGTH });
    $("#live-code-form").hidden = true;
    setStatus("live.deriving");
    queue = queue.then(async () => {
      if (session.state !== "appairage") newSession();
      await session.pairWithPassphrase(typed);
      $("#live-rx-sas").textContent = sasText(session.sas());
      setStatus("live.compare");
      $("#live-compare").hidden = false;
      $("#live-match").focus();
    });
  };
  $("#live-match").onclick = () => {
    session.confirmSas();
    $("#live-compare").hidden = true;
    setStatus("live.receiving");
    $("#live-meter").hidden = false;
  };
  $("#live-mismatch").onclick = () => askCode("live.different");

  async function frameRead(bytes: Uint8Array): Promise<void> {
    if (closed) return;
    if (isPairingFrame(bytes)) {
      const code = pairingPayload(bytes, INIT_CODE_SIZE);
      if (initCode || !code || pairingCodeKind(code) !== "init") return;
      try {
        const info = session.scanInitCode(code);
        if (!info.byPassphrase) throw new Error(t("live.refusedCodes"));
        tracker = new TransferTracker(info.streamSize, info.kTotal);
      } catch (e) {
        setStatus("live.refused", { msg: (e as Error).message }, true);
        close();
        return;
      }
      initCode = code;
      newSession();
      askCode("live.found");
      return;
    }
    if (session.state !== "calibre" && session.state !== "transmission") return;
    const st = await session.receiveFrame(bytes);
    if (st.accepted && tracker) {
      const p = session.progress();
      if (p.receivedFrames === 1) tracker.start();
      const s = tracker.state(p.receivedSymbols, session.done);
      $("#live-bar").style.width = `${s.progress * 100}%`;
      $("#live-pct").textContent = `${Math.round(s.progress * 100)} % · ${readableThroughput(s.throughput)}`;
      $("#live-eta").textContent = Number.isFinite(s.remaining) ? t("live.remaining", { t: readableDuration(s.remaining) }) : "";
    }
    if (!session.done) return;
    const { data } = await session.result();
    const file = unpack(data);
    preview = createPreview(file);
    $("#live-preview").replaceChildren(preview.element);
    $("#live-name").textContent = `${file.name} · ${readableSize(file.data.length)}`;
    $("#live-result").hidden = false;
    $("#live-bar").style.width = "100%";
    setStatus("live.done");
    $("#live-save").onclick = () => ($("#live-save-msg").textContent = saveFile(file).message);
    reader.close();
    closeCamera(stream);
  }

  reader.start();
}

// ── Page ──────────────────────────────────────────────────────────────────

function renderCaps(): void {
  const caps = detectCapabilities();
  const items: [Key, boolean][] = [
    ["live.cap.secure", caps.secureContext],
    ["live.cap.crypto", caps.crypto],
    ["live.cap.camera", caps.camera],
    ["live.cap.compression", caps.compression],
  ];
  const chips = items.map(([key, ok]) => {
    const s = document.createElement("span");
    s.className = `cap ${ok ? "ok" : "bad"}`;
    s.textContent = `${ok ? "✓" : "✗"} ${t(key)}`;
    return s;
  });
  if (!caps.secureContext) {
    const s = document.createElement("span");
    s.className = "cap warn";
    s.textContent = t("live.cap.hint");
    chips.push(s);
  }
  $("#caps").replaceChildren(...chips);
}

export function initLive(): void {
  renderCaps();
  const textarea = $<HTMLTextAreaElement>("#live-text");
  textarea.value = t("live.defaultText");
  let sample = textarea.value;

  onLangChange(() => {
    renderCaps();
    renderStatus();
    if (modulePx) $("#live-module").textContent = t("live.modulePx", { px: modulePx });
    renderColumns();
    if (textarea.value === sample) textarea.value = sample = t("live.defaultText");
    else sample = t("live.defaultText");
  });

  $$<HTMLButtonElement>("[data-lsrc]").forEach((b) => {
    b.onclick = () => {
      liveSource = b.dataset.lsrc as "text" | "file";
      $$("[data-lsrc]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      textarea.hidden = liveSource !== "text";
      $("#live-file-box").hidden = liveSource !== "file";
    };
  });
  $<HTMLInputElement>("#live-file").onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    liveFile = { name: f.name, type: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) };
    const info = $("#live-file-info");
    delete info.dataset.i18n;
    info.textContent = `${f.name} · ${readableSize(f.size)}`;
  };

  const fail = (e: unknown) => {
    console.error(e);
    show("receiver");
    setStatus("live.error", { msg: (e as Error).message }, true);
  };
  $("#live-send").onclick = () => void send().catch(fail);
  $("#live-receive").onclick = () => void receive().catch(fail);
  $("#live-stop").onclick = back;
  $("#live-cancel").onclick = back;
}

/** Leaving the view releases the camera / stops the display. */
export function leaveLive(): void {
  if (cleanup) back();
}
