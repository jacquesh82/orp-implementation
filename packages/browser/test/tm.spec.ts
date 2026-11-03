import { describe, expect, it } from "vitest";
import { INIT_CODE_SIZE, RESPONSE_CODE_SIZE, REVEAL_CODE_SIZE } from "@optirelay/core";
import { tmCapacity, TM_PALETTE, TmReceiver, simulateCapture, payloadSubframe, referenceSubframe } from "@optirelay/optical";
import { CODEC } from "@optirelay/core";
import { pairingPayload, isPairingFrame, pairingFrame } from "../src/tm.ts";

describe("TM4 pairing frames", () => {
  for (const size of [INIT_CODE_SIZE, RESPONSE_CODE_SIZE, REVEAL_CODE_SIZE]) {
    it(`${size}-byte code: fits in TM4 and reads back through the simulated camera`, () => {
      const payload = Uint8Array.from({ length: size }, (_, i) => (i * 37 + 5) & 0xff);
      const raw = pairingFrame(payload);
      expect(raw.length).toBeLessThanOrEqual(tmCapacity(CODEC.COLOR_4));
      expect(isPairingFrame(raw)).toBe(true);
      const receiver = new TmReceiver();
      receiver.process(simulateCapture(referenceSubframe(raw, CODEC.COLOR_4), TM_PALETTE, { noise: 6, seed: 1, gains: [1.3, 0.7, 1] }), 0);
      const r = receiver.process(simulateCapture(payloadSubframe(raw, CODEC.COLOR_4), TM_PALETTE, { noise: 6, seed: 2, gains: [1.3, 0.7, 1] }), 250);
      expect(r.frame?.codec).toBe(CODEC.COLOR_4);
      expect(Array.from(pairingPayload(r.frame!.bytes, size)!)).toEqual(Array.from(payload));
    });
  }
});
