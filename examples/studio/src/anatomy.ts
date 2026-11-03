/**
 * ANATOMY — the building blocks, one at a time:
 *   1. the 41×41 grid (roles, static codecs, TM subframes), hoverable;
 *   2. the byte layout of an encrypted frame (meta ×3, RS segments);
 *   3. the LT fountain code: peeling alone vs the ORP decoder (peeling + GF(2) Gauss).
 */
import {
  BODY_HEADER_SIZE,
  CODEC,
  CRC_SIZE,
  FountainDecoder,
  META_COPIES,
  META_SIZE,
  SEGMENT_SIZE,
  SYMBOL_CAPACITY,
  SYMBOL_SIZE,
  TAG_SIZE,
  fountainSymbol,
  frameSize,
  ltNeighbors,
  type Codec,
} from "@optirelay/core";
import {
  DATA_MODULES,
  GRID_SIZE,
  TM_PALETTE,
  availableBits,
  bitsPerModule,
  inTmAlignment,
  paletteOf,
  render,
  renderTmPair,
  roleOf,
  structuralGrid,
  tmCapacity,
  writeBytesToGrid,
  type ImageRGBA,
} from "@optirelay/optical";
import { pairingFrame } from "@optirelay/browser";
import { $, $$, fmt, paint, sleep } from "./ui";
import { onLangChange, t, type Key } from "./i18n";

// ── 1. Grid ───────────────────────────────────────────────────────────────

const MODULE = 12;
const QUIET = 2;
type Mode = "roles" | "1" | "2" | "3" | "tmR" | "tmP" | "tmFlick";
type Role = "finder" | "separator" | "timing" | "pilot" | "data" | "alignment";
let mode: Mode = "roles";
let flickTimer = 0;
let gridIndices: Uint8Array | null = null; // palette index per module (static codecs)

const ROLES: Role[] = ["finder", "separator", "timing", "pilot", "data", "alignment"];
const ROLE_COLORS: Record<Role, [number, number, number]> = {
  finder: [255, 210, 63],
  separator: [58, 65, 82],
  timing: [154, 164, 184],
  pilot: [255, 61, 154],
  data: [0, 170, 160],
  alignment: [182, 120, 255],
};
const roleLabel = (r: Role) => t(`role.${r}` as Key);
const explainKey = (m: Mode) => `an.explain.${m}` as Key;

function moduleRole(x: number, y: number, tm: boolean): Role {
  if (tm && inTmAlignment(x, y)) return "alignment";
  return roleOf(x, y);
}

const usesTm = () => mode.startsWith("tm") || mode === "roles";

function textBytes(): Uint8Array {
  return new TextEncoder().encode($<HTMLInputElement>("#grid-text").value || " ");
}

function roleImage(): ImageRGBA {
  const size = (GRID_SIZE + QUIET * 2) * MODULE;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([18, 21, 28, 255], i);
  for (let y = 0; y < GRID_SIZE; y++)
    for (let x = 0; x < GRID_SIZE; x++) {
      const [r, g, b] = ROLE_COLORS[moduleRole(x, y, true)];
      for (let py = 1; py < MODULE - 1; py++)
        for (let px = 1; px < MODULE - 1; px++) {
          const i = (((y + QUIET) * MODULE + py) * size + (x + QUIET) * MODULE + px) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
    }
  return { width: size, height: size, data };
}

function drawGrid(): void {
  clearInterval(flickTimer);
  const canvas = $<HTMLCanvasElement>("#grid-canvas");
  gridIndices = null;
  if (mode === "roles") paint(canvas, roleImage());
  else if (mode === "1" || mode === "2" || mode === "3") {
    const codec = Number(mode) as Codec;
    const grid = writeBytesToGrid(structuralGrid(codec), textBytes(), codec);
    gridIndices = grid;
    paint(canvas, render(grid, paletteOf(codec), { moduleSize: MODULE, quietZone: QUIET }));
  } else {
    const pair = renderTmPair(pairingFrame(textBytes().slice(0, 96)), CODEC.COLOR_4, { moduleSize: MODULE, quietZone: QUIET });
    if (mode === "tmR") paint(canvas, pair.reference);
    else if (mode === "tmP") paint(canvas, pair.payload);
    else {
      let on = false;
      paint(canvas, pair.reference);
      flickTimer = window.setInterval(() => paint(canvas, (on = !on) ? pair.payload : pair.reference), 260);
    }
  }
  renderGridText();
}

/** Everything textual around the grid (legend, explanation) — re-run on language change. */
function renderGridText(): void {
  $("#grid-explain").textContent = t(explainKey(mode));
  const ul = $("#grid-legend");
  if (mode === "roles") {
    const counts = new Map<Role, number>();
    for (let y = 0; y < GRID_SIZE; y++)
      for (let x = 0; x < GRID_SIZE; x++) {
        const r = moduleRole(x, y, true);
        counts.set(r, (counts.get(r) ?? 0) + 1);
      }
    ul.replaceChildren(
      ...ROLES.map((role) => {
        const li = document.createElement("li");
        const sw = document.createElement("i");
        sw.style.background = `rgb(${ROLE_COLORS[role].join(",")})`;
        const b = document.createElement("b");
        b.textContent = fmt(counts.get(role) ?? 0);
        li.append(sw, `${roleLabel(role)} `, b);
        return li;
      }),
    );
    return;
  }
  const tm = mode.startsWith("tm");
  const palette = tm ? TM_PALETTE : paletteOf(Number(mode) as Codec);
  const names = tm
    ? [t("an.tm.black"), t("an.tm.white"), t("an.tm.gray"), ...Array.from({ length: 8 }, (_, i) => t("an.tm.dir", { d: `${(i >> 2) & 1}${(i >> 1) & 1}${i & 1}` }))]
    : palette.map((_, i) => t("an.idx", { i, b: i.toString(2).padStart(bitsPerModule(Number(mode) as Codec), "0") }));
  ul.replaceChildren(
    ...palette.map((c, i) => {
      const li = document.createElement("li");
      const sw = document.createElement("i");
      sw.style.background = `rgb(${c.join(",")})`;
      li.append(sw, names[i]);
      return li;
    }),
  );
}

const dataIndex = new Map<string, number>(DATA_MODULES.map(([x, y], i) => [`${x},${y}`, i]));

function hover(e: PointerEvent): void {
  const canvas = e.currentTarget as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((((e.clientX - rect.left) / rect.width) * canvas.width) / MODULE) - QUIET;
  const y = Math.floor((((e.clientY - rect.top) / rect.height) * canvas.height) / MODULE) - QUIET;
  const tip = $("#grid-tip");
  if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) {
    tip.hidden = true;
    return;
  }
  const role = moduleRole(x, y, usesTm());
  const parts = [`(${x}, ${y})`, roleLabel(role)];
  const di = dataIndex.get(`${x},${y}`);
  if (role === "data" && di !== undefined) parts.push(t("an.tip.n", { n: di }));
  if (gridIndices && role === "data") {
    const v = gridIndices[y * GRID_SIZE + x];
    parts.push(t("an.tip.bits", { b: v.toString(2).padStart(bitsPerModule(Number(mode) as Codec), "0") }));
  }
  tip.textContent = parts.join(" · ");
  tip.hidden = false;
  tip.style.left = `${e.clientX - rect.left + 14}px`;
  tip.style.top = `${e.clientY - rect.top + 14}px`;
}

function capacityTable(): void {
  const rows: string[][] = ([CODEC.MONO_2, CODEC.COLOR_4, CODEC.COLOR_8] as Codec[]).map((c) => [
    ["MONO_2", "COLOR_4", "COLOR_8"][c - 1],
    String(bitsPerModule(c)),
    fmt(availableBits(c)),
    String(SYMBOL_CAPACITY[c]),
    t("an.cap.bytes", { n: frameSize(SYMBOL_CAPACITY[c], true) }),
  ]);
  rows.push(["TM4", "2", fmt(tmCapacity(CODEC.COLOR_4) * 8), String(SYMBOL_CAPACITY[CODEC.COLOR_4]), t("an.cap.pair", { n: tmCapacity(CODEC.COLOR_4) })]);
  rows.push(["TM8", "3", fmt(tmCapacity(CODEC.COLOR_8) * 8), String(SYMBOL_CAPACITY[CODEC.COLOR_8]), t("an.cap.pair", { n: tmCapacity(CODEC.COLOR_8) })]);
  $("#cap-table").replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement("tr");
      for (const v of r) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      return tr;
    }),
  );
}

// ── 2. Frame layout ───────────────────────────────────────────────────────

interface Part {
  label: string;
  bytes: number;
  cls: string;
}
let frameCodec: Codec = CODEC.COLOR_4;

function frameParts(codec: Codec): Part[] {
  const n = SYMBOL_CAPACITY[codec];
  const parts: Part[] = [];
  for (let i = 0; i < META_COPIES; i++) parts.push({ label: t("an.seg.meta", { i: i + 1 }), bytes: META_SIZE, cls: "meta" });
  const body: Part[] = [{ label: t("an.seg.head"), bytes: BODY_HEADER_SIZE, cls: "head" }];
  for (let i = 0; i < n; i++) body.push({ label: t("an.seg.sym", { i: i + 1 }), bytes: SYMBOL_SIZE, cls: "sym" });
  body.push({ label: t("an.seg.tag"), bytes: TAG_SIZE, cls: "tag" }, { label: t("an.seg.crc"), bytes: CRC_SIZE, cls: "crc" });
  // Split the body into Reed-Solomon segments of ≤ SEGMENT_SIZE bytes, each followed by its parity.
  let used = 0;
  const rs = (): Part => ({ label: t("an.seg.rs"), bytes: 8, cls: "rs" });
  for (const p of body) {
    let left = p.bytes;
    while (left > 0) {
      const take = Math.min(left, SEGMENT_SIZE - used);
      parts.push({ ...p, bytes: take });
      left -= take;
      used += take;
      if (used === SEGMENT_SIZE) {
        parts.push(rs());
        used = 0;
      }
    }
  }
  if (used > 0) parts.push(rs());
  return parts;
}

function drawFrame(): void {
  const codec = frameCodec;
  const parts = frameParts(codec);
  const total = parts.reduce((s, p) => s + p.bytes, 0);
  const expected = frameSize(SYMBOL_CAPACITY[codec], true);
  $("#frame-strip").replaceChildren(
    ...parts.map((p) => {
      const d = document.createElement("div");
      d.className = `seg ${p.cls}`;
      d.style.flexGrow = String(p.bytes);
      d.title = `${p.label} · ${p.bytes}`;
      const label = document.createElement("span");
      label.textContent = p.label;
      const size = document.createElement("small");
      size.textContent = String(p.bytes);
      d.append(label, size);
      return d;
    }),
  );
  const legend: [string, string][] = [
    ["meta", t("an.leg.meta", { n: META_COPIES })],
    ["head", t("an.leg.head")],
    ["sym", t("an.leg.sym", { n: SYMBOL_SIZE })],
    ["tag", t("an.leg.tag")],
    ["crc", t("an.leg.crc")],
    ["rs", t("an.leg.rs", { n: SEGMENT_SIZE })],
  ];
  const totalLi = document.createElement("li");
  totalLi.className = "total";
  totalLi.textContent = t("an.total", {
    n: total,
    check: total === expected ? t("an.total.ok") : t("an.total.diff", { n: expected }),
    cap: tmCapacity(codec),
  });
  $("#frame-legend").replaceChildren(
    totalLi,
    ...legend.map(([cls, text]) => {
      const li = document.createElement("li");
      const i = document.createElement("i");
      i.className = `seg ${cls}`;
      li.append(i, text);
      return li;
    }),
  );
}

// ── 3. Fountain playground ────────────────────────────────────────────────

const SYM = 16; // bytes per source symbol in the playground (the protocol uses 96)
let K = 24;
let lossPct = 30;
let sources: Uint8Array[] = [];
let decoder = new FountainDecoder(K);
let nextSeed = 1;
let sent = 0;
let lost = 0;
let recv = 0;
let peelSolved: boolean[] = [];
let peelPending: Set<number>[] = [];
let completeAt = 0;
let auto = 0;
let lastBench: { k: number; orp: number[]; peel: number[] } | null = null;

function randomSources(k: number): Uint8Array[] {
  return Array.from({ length: k }, () => crypto.getRandomValues(new Uint8Array(SYM)));
}

/** Peeling ONLY: solve an equation once a single unknown remains, in cascade. */
function peel(neighbors: Uint32Array, solved: boolean[], pending: Set<number>[]): void {
  const eq = new Set([...neighbors].filter((i) => !solved[i]));
  if (eq.size === 0) return;
  pending.push(eq);
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of pending) {
      if (e.size !== 1) continue;
      const [i] = e;
      solved[i] = true;
      progress = true;
      for (const other of pending) other.delete(i);
    }
    for (let j = pending.length - 1; j >= 0; j--) if (pending[j].size === 0) pending.splice(j, 1);
  }
}

function resetFountain(): void {
  stopAuto();
  K = Number($<HTMLInputElement>("#ft-k").value);
  sources = randomSources(K);
  decoder = new FountainDecoder(K);
  nextSeed = (Math.random() * 2 ** 31) >>> 0;
  sent = lost = recv = completeAt = 0;
  peelSolved = new Array(K).fill(false);
  peelPending = [];
  $("#ft-feed").replaceChildren();
  $("#ft-sources").replaceChildren(
    ...sources.map((_, i) => {
      const d = document.createElement("div");
      d.className = "src";
      d.textContent = String(i);
      return d;
    }),
  );
  renderFountain();
}

function emitOne(): void {
  if (completeAt) return stopAuto();
  const seed = nextSeed++;
  sent++;
  const neighbors = ltNeighbors(K, seed);
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = `#${seed % 10000} · d=${neighbors.length}`;
  chip.dataset.n = [...neighbors].join(",");
  if (Math.random() * 100 < lossPct) {
    lost++;
    chip.classList.add("lost");
  } else {
    recv++;
    decoder.receive(seed, fountainSymbol(sources, K, seed));
    peel(neighbors, peelSolved, peelPending);
    if (decoder.complete && !completeAt) {
      completeAt = recv;
      const ok = decoder.reconstruct().every((s, i) => s.every((b, j) => b === sources[i][j]));
      chip.classList.add(ok ? "win" : "lost");
    }
  }
  chip.onpointerenter = () => highlight(chip.dataset.n!);
  chip.onpointerleave = () => highlight("");
  const feed = $("#ft-feed");
  feed.prepend(chip);
  while (feed.children.length > 40) feed.lastElementChild!.remove();
  renderFountain();
}

function highlight(list: string): void {
  const set = new Set(list ? list.split(",").map(Number) : []);
  $$("#ft-sources .src").forEach((el, i) => el.classList.toggle("hl", set.has(i)));
}

function renderFountain(): void {
  const peeled = peelSolved.filter(Boolean).length;
  $$("#ft-sources .src").forEach((el, i) => {
    el.classList.toggle("peel", peelSolved[i]);
    el.classList.toggle("gauss", !!completeAt && !peelSolved[i]);
  });
  $("#ft-sent").textContent = fmt(sent);
  $("#ft-lost").textContent = fmt(lost);
  $("#ft-recv").textContent = fmt(recv);
  $("#ft-peel").textContent = `${peeled} / ${K}`;
  $("#ft-orp").textContent = completeAt
    ? t("an.ft.complete", { n: completeAt, x: completeAt - K })
    : t("an.ft.waiting", { n: decoder.receivedSymbols });
  $("#ft-orp").className = completeAt ? "ok" : "";
  $("#ft-auto").textContent = t(auto ? "an.ft.pause" : "an.ft.auto");
}

function stopAuto(): void {
  clearInterval(auto);
  auto = 0;
  $("#ft-auto").textContent = t("an.ft.auto");
}

async function bench(): Promise<void> {
  const out = $("#ft-bench-out");
  out.hidden = false;
  out.textContent = t("an.ft.computing");
  const k = K;
  const trials = 300;
  const orp: number[] = [];
  const peelOnly: number[] = [];
  const src = randomSources(k).map((s) => s.slice(0, 4));
  for (let i = 0; i < trials; i++) {
    const dec = new FountainDecoder(k);
    const solved = new Array(k).fill(false);
    const pending: Set<number>[] = [];
    let seed = (Math.random() * 2 ** 31) >>> 0;
    let n = 0;
    let orpAt = 0;
    let peelAt = 0;
    while ((!orpAt || !peelAt) && n < k * 4) {
      n++;
      const s = seed++;
      if (!orpAt) {
        dec.receive(s, fountainSymbol(src, k, s));
        if (dec.complete) orpAt = n;
      }
      if (!peelAt) {
        peel(ltNeighbors(k, s), solved, pending);
        if (solved.every(Boolean)) peelAt = n;
      }
    }
    orp.push(orpAt || k * 4);
    peelOnly.push(peelAt || k * 4);
    if (i % 25 === 24) {
      out.textContent = t("an.ft.progress", { i: i + 1, n: trials });
      await sleep(0);
    }
  }
  lastBench = { k, orp, peel: peelOnly };
  renderBench();
}

function renderBench(): void {
  if (!lastBench) return;
  $("#ft-bench-out").replaceChildren(histogram(lastBench.k, lastBench.orp, lastBench.peel));
}

function histogram(k: number, orp: number[], peelOnly: number[]): HTMLElement {
  const over = (a: number[]) => a.map((n) => (n - k) / k);
  const o = over(orp);
  const p = over(peelOnly);
  const max = Math.min(3, Math.max(...o, ...p));
  const bins = 24;
  const w = max / bins || 1;
  const count = (a: number[]) => {
    const h = new Array(bins).fill(0);
    for (const v of a) h[Math.min(bins - 1, Math.floor(Math.max(0, v) / w))]++;
    return h;
  };
  const ho = count(o);
  const hp = count(p);
  const top = Math.max(...ho, ...hp);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const W = 640;
  const H = 180;
  const bw = W / bins;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + 22}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", t("an.bench.aria"));
  const el = (tag: string, attrs: Record<string, string | number>, title?: string, text?: string) => {
    const e = document.createElementNS(NS, tag);
    for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, String(v));
    if (title) {
      const ti = document.createElementNS(NS, "title");
      ti.textContent = title;
      e.append(ti);
    }
    if (text) e.textContent = text;
    svg.append(e);
  };
  el("line", { x1: 0, y1: H, x2: W, y2: H, class: "axis" });
  for (let i = 0; i < bins; i++) {
    const x = i * bw;
    const yo = H - (ho[i] / top) * (H - 10);
    const yp = H - (hp[i] / top) * (H - 10);
    const range = { a: Math.round(i * w * 100), b: Math.round((i + 1) * w * 100) };
    el("rect", { class: "hp", x: x + 1, y: yp, width: bw - 2, height: H - yp, rx: 2 }, t("an.bench.tipPeel", { n: hp[i], ...range }));
    el("rect", { class: "ho", x: x + bw * 0.25, y: yo, width: bw * 0.5, height: H - yo, rx: 2 }, t("an.bench.tipOrp", { n: ho[i], ...range }));
  }
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    el("text", { x: (v / max) * W, y: H + 16, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle" }, undefined, `+${Math.round(v * 100)} %`);
  }

  const head = document.createElement("div");
  head.className = "bench-h";
  const line = (cls: string | null, label: string, value?: string) => {
    const s = document.createElement("span");
    if (cls) {
      const sw = document.createElement("i");
      sw.className = `sw ${cls}`;
      s.append(sw);
    } else s.className = "soft";
    s.append(label);
    if (value) {
      const b = document.createElement("b");
      b.textContent = ` ${value}`;
      s.append(b);
    }
    return s;
  };
  head.append(
    line("ho", t("an.bench.orp"), `+${(mean(o) * 100).toFixed(1)} %`),
    line("hp", t("an.bench.peel"), `+${(mean(p) * 100).toFixed(1)} %`),
    line(null, t("an.bench.meta", { k, n: orp.length })),
  );
  const box = document.createElement("div");
  box.append(head, svg);
  return box;
}

// ── Init ──────────────────────────────────────────────────────────────────

export function initAnatomy(): void {
  const input = $<HTMLInputElement>("#grid-text");
  input.value = t("an.grid.default");
  let sample = input.value;

  $$<HTMLButtonElement>("#grid-modes [data-mode]").forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.mode as Mode;
      $$("#grid-modes [data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      drawGrid();
    };
  });
  input.oninput = drawGrid;
  const canvas = $<HTMLCanvasElement>("#grid-canvas");
  canvas.onpointermove = hover;
  canvas.onpointerleave = () => ($("#grid-tip").hidden = true);
  drawGrid();
  capacityTable();

  $$<HTMLButtonElement>("#frame-codec [data-fc]").forEach((b) => {
    b.onclick = () => {
      $$("#frame-codec [data-fc]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      frameCodec = Number(b.dataset.fc) as Codec;
      drawFrame();
    };
  });
  drawFrame();

  const k = $<HTMLInputElement>("#ft-k");
  k.oninput = () => {
    $("#ft-k-out").textContent = k.value;
    resetFountain();
  };
  const loss = $<HTMLInputElement>("#ft-loss");
  loss.oninput = () => {
    lossPct = Number(loss.value);
    $("#ft-loss-out").textContent = `${loss.value} %`;
  };
  $("#ft-step").onclick = emitOne;
  $("#ft-reset").onclick = resetFountain;
  $("#ft-auto").onclick = () => {
    if (auto) return stopAuto();
    if (completeAt) resetFountain();
    auto = window.setInterval(emitOne, 160);
    $("#ft-auto").textContent = t("an.ft.pause");
  };
  $("#ft-bench").onclick = () => void bench();
  resetFountain();

  onLangChange(() => {
    if (input.value === sample) {
      input.value = sample = t("an.grid.default");
      drawGrid(); // the encoded bytes changed
    } else {
      sample = t("an.grid.default");
      renderGridText();
    }
    capacityTable();
    drawFrame();
    renderFountain();
    renderBench();
  });
}

export function leaveAnatomy(): void {
  clearInterval(flickTimer);
  stopAuto();
}
