import { CODEC, CryptoWebCrypto, SenderSession, ReceiverSession, INIT_CODE_SIZE, RESPONSE_CODE_SIZE, REVEAL_CODE_SIZE, pairingCodeKind } from "@optirelay/core";
import { renderTmPair, degradeImage, TmReceiver } from "@optirelay/optical";
// browser pkg helpers pairingFrame etc. — try import (may touch DOM at import?)
const b = await import("@optirelay/browser").catch(e => { console.log("browser import fail", e.message); return null; });
const { pairingFrame, isPairingFrame, pairingPayload } = b;
const crypto = new CryptoWebCrypto();
const codec = Number(process.argv[2] ?? CODEC.COLOR_4);
const sender = new SenderSession(crypto, { pairing: "passphrase", codecs: [codec] });
const msg = new Uint8Array(4000).map((_, i) => (i * 2654435761 >>> 13) & 255);
await sender.prepare(msg);
await sender.receivePassphrase("K7QFM2XP9CHR");
const SSAS = sender.sas(); sender.confirmSas();
const init = pairingFrame(sender.initCode());
console.log("init frame len", init.length, "INIT", INIT_CODE_SIZE, RESPONSE_CODE_SIZE, REVEAL_CODE_SIZE);
const rx = new TmReceiver();
const recv = new ReceiverSession(crypto);
let t = 0, frames = 0, valid = 0, lost = 0;
const opts = { blur: 1, noise: 6, rotationDegrees: 4, perspective: [0.08, 0.03], gains: [1.05, 0.95, 0.85], scale: 0.85, seed: 1 };
let tSum = 0;
async function feed(raw, c) {
  const { reference, payload } = renderTmPair(raw, c, { moduleSize: 8 });
  for (const img of [reference, payload]) {
    const t0 = performance.now();
    const cap = degradeImage(img, { ...opts, seed: (opts.seed++) });
    const r = rx.process(cap, (t += 120));
    tSum += performance.now() - t0;
    if (r.frame && r.frame.isNew) await onFrame(r.frame.bytes);
  }
}
async function onFrame(bytes) {
  valid++;
  if (isPairingFrame(bytes)) {
    const code = pairingPayload(bytes, INIT_CODE_SIZE);
    if (recv.state === "initial" && code && pairingCodeKind(code) === "init") {
      const info = recv.scanInitCode(code);
      console.log("init info", { k: info.kTotal, blocks: info.blockCount, size: info.streamSize, compressed: info.compressed });
      await recv.pairWithPassphrase("K7QFM2XP9CHR");
      console.log("SAS", SSAS, recv.sas());
      recv.confirmSas();
    }
    return;
  }
  if (recv.state !== "calibre" && recv.state !== "transmission") return;
  const st = await recv.receiveFrame(bytes);
  if (!st.accepted) console.log("rej", st.rejection);
  if (recv.done) sender.finish();
}
await sender.start(async (frame) => {
  frames++; if (frames > 400) { sender.cancel(); return; }
  await feed(init, CODEC.COLOR_4);
  if (Math.random() < 0.3) { lost++; return; }
  await feed(frame, codec);
});
const { data, verified } = await recv.result();
console.log("done", { frames, lost, valid, verified, ok: new TextDecoder().decode(data) === new TextDecoder().decode(msg) && data.length === msg.length, ms_per_img: (tSum / (rx.stats.images)).toFixed(1), stats: rx.stats, prog: recv.progress() });
