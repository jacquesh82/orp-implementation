import { expect, it } from "vitest";
import { INIT_CODE_SIZE } from "@optirelay/core";
import { clock, readSendState, pairingFrame } from "../src/tm.ts";

/** Same frame as the Rust test `state_matches_ts` (orp-transfer): interoperability. */
export const CODE = Uint8Array.from({ length: INIT_CODE_SIZE }, (_, i) => (i * 7 + 3) & 0xff);
export const STATE = { t: 47250, sentSymbols: 1234, suggestedSymbols: 9000 };

it("send state in the init code: round trip, absent if not written", () => {
  const t = pairingFrame(CODE, STATE);
  expect(readSendState(t)).toEqual(STATE);
  expect(readSendState(pairingFrame(CODE))).toBeNull();
  expect(readSendState(pairingFrame(CODE, { ...STATE, t: -3000 }))?.t).toBe(-3000);
  expect(clock(67.4)).toBe("1:07");
  if (process.env.SHOW_HEX) console.log(Buffer.from(t).toString("hex"));
});
