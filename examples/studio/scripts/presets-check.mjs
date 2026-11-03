// How many R/P pairs decode under each channel preset of the lab (TM4 and TM8).
import { CODEC } from "@optirelay/core";
import { renderTmPair, degradeImage, TmReceiver } from "@optirelay/optical";
import { pairingFrame } from "@optirelay/browser";
const P = {
  ideal: { blur: 0, noise: 0, rotation: 0, shake: 0, perspective: 0, distance: 1, tint: 0, crosstalk: 0, haze: 0 },
  hand: { blur: 1, noise: 6, rotation: 4, shake: 1.5, perspective: 0.06, distance: 0.88, tint: 0.2, crosstalk: 0.05, haze: 6 },
  bright: { blur: 1, noise: 10, rotation: -3, shake: 1, perspective: 0.04, distance: 0.85, tint: 0.45, crosstalk: 0.1, haze: 45 },
  hell: { blur: 2, noise: 16, rotation: 11, shake: 3, perspective: 0.12, distance: 0.72, tint: -0.6, crosstalk: 0.16, haze: 30 },
  maxrot: { blur: 0, noise: 0, rotation: 20, shake: 6, perspective: 0.2, distance: 1, tint: 0, crosstalk: 0, haze: 0 },
};
let s = 1; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function opts(p) {
  const c = p.crosstalk;
  const o = { scale: p.distance, rotationDegrees: p.rotation + rnd() * p.shake * 0.5, translation: [rnd() * p.shake * 3, rnd() * p.shake * 3], perspective: [p.perspective, p.perspective * 0.45], gains: [clamp(1 + 0.22 * p.tint, 0.4, 1.6), 1, clamp(1 - 0.32 * p.tint, 0.4, 1.6)], blur: p.blur, noise: p.noise, seed: s, moduleSize: 8 };
  if (c > 0) o.matrix = [[1 - c, c * 0.7, c * 0.3], [c * 0.5, 1 - c, c * 0.5], [c * 0.3, c * 0.7, 1 - c]];
  if (p.haze > 0) o.haze = [p.haze, p.haze * 0.95, p.haze * 0.85];
  return o;
}
for (const [name, p] of Object.entries(P)) {
  const row = [name];
  for (const codec of [CODEC.COLOR_4, CODEC.COLOR_8]) {
    let ok = 0; const N = 12;
    for (let i = 0; i < N; i++) {
      const raw = pairingFrame(new Uint8Array(97).map((_, j) => (j * 31 + i * 7) & 255));
      // emulate a data frame of the codec by rendering the pairing frame in that codec
      const { reference, payload } = renderTmPair(raw, codec, { moduleSize: 8, quietZone: 5 });
      const rx = new TmReceiver(); let t = 0;
      rx.process(degradeImage(reference, opts(p)), (t += 60));
      const r = rx.process(degradeImage(payload, opts(p)), (t += 60));
      if (r.frame) ok++;
    }
    row.push(`${codec === 2 ? "TM4" : "TM8"} ${ok}/12`);
  }
  console.log(row.join("  "));
}
