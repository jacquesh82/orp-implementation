import { CODEC, CryptoWebCrypto, SenderSession, ReceiverSession, INIT_CODE_SIZE, RESPONSE_CODE_SIZE, REVEAL_CODE_SIZE, pairingCodeKind } from "@optirelay/core";
import { renderTmPair, degradeImage, TmReceiver } from "@optirelay/optical";
import { pairingFrame, isPairingFrame, pairingPayload, pack, unpack } from "@optirelay/browser";
const c = new CryptoWebCrypto();
// strong pairing through the optical channel
function through(raw, codec = CODEC.COLOR_4) {
  const rx = new TmReceiver(); const { reference, payload } = renderTmPair(raw, codec, { moduleSize: 8 });
  rx.process(degradeImage(reference, { noise: 4, seed: 3 }), 0); const r = rx.process(degradeImage(payload, { noise: 4, seed: 4 }), 100);
  return r.frame?.bytes;
}
const s = new SenderSession(c, { codecs: [CODEC.COLOR_8] });
await s.prepare(pack({ name: "note.txt", type: "text/plain", data: new TextEncoder().encode("secret") }));
const r = new ReceiverSession(c);
const ib = through(pairingFrame(s.initCode()));
console.log("init kind", pairingCodeKind(pairingPayload(ib, INIT_CODE_SIZE)));
const info = r.scanInitCode(pairingPayload(ib, INIT_CODE_SIZE)); console.log("byPass", info.byPassphrase, info.encrypted);
const resp = await r.responseCode(); const rb = through(pairingFrame(resp));
const rp = pairingPayload(rb, RESPONSE_CODE_SIZE); console.log("resp kind", pairingCodeKind(rp));
await s.receiveResponseCode(rp);
const rev = s.revealCode(); const vb = through(pairingFrame(rev)); const vp = pairingPayload(vb, REVEAL_CODE_SIZE);
console.log("reveal kind", pairingCodeKind(vp));
await r.receiveRevealCode(vp); console.log("SAS", s.sas(), r.sas(), "states", s.state, r.state);
s.confirmSas(); r.confirmSas();
// eavesdropper on passphrase session
const s2 = new SenderSession(c, { pairing: "passphrase", codecs: [CODEC.COLOR_4] });
await s2.prepare(new TextEncoder().encode("x".repeat(500) + Math.random()));
await s2.receivePassphrase("GOODCODE1234"); s2.confirmSas();
const spy = new ReceiverSession(c); spy.scanInitCode(s2.initCode()); await spy.pairWithPassphrase("WRONGCODE123"); spy.confirmSas();
const rejs = []; spy.events.on("rejection", (e) => rejs.push(e.reason));
let n = 0; await s2.start(async (f) => { const st = await spy.receiveFrame(f); if (++n >= 3) s2.finish(); });
console.log("spy rejections", rejs, spy.progress());
// mixed rolling shutter image
const { reference, payload } = renderTmPair(pairingFrame(s2.initCode()), CODEC.COLOR_4, { moduleSize: 8 });
const mix = { width: reference.width, height: reference.height, data: new Uint8ClampedArray(reference.data) };
mix.data.set(payload.data.subarray(reference.data.length / 2), reference.data.length / 2);
const rx = new TmReceiver(); rx.process(reference, 0); const m = rx.process(mix, 100);
console.log("mixed:", m.subframe?.type, rx.stats);
