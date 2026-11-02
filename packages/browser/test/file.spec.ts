import { describe, expect, it } from "vitest";
import { readableThroughput, unpack, readableDuration, pack, TransferTracker } from "../src/file.ts";

describe("file envelope", () => {
  it("round trip of name, type and data; sanitized name", () => {
    const data = Uint8Array.from([1, 2, 3, 250]);
    const f = unpack(pack({ name: "../keys/wifi:home.txt", type: "text/plain", data }));
    expect(f.name).toBe(".._keys_wifi_home.txt");
    expect(f.type).toBe("text/plain");
    expect(Array.from(f.data)).toEqual([1, 2, 3, 250]);
  });
  it("bare bytes stay bare bytes", () => {
    expect(unpack(Uint8Array.from([9, 9, 9])).name).toBe("optirelay-received.bin");
  });
});

describe("transfer tracking", () => {
  it("progress capped before the end, consistent throughput and remaining time", () => {
    const tracker = new TransferTracker(10_000, 100);
    tracker.start(0);
    const e = tracker.state(50, false, 5000);
    expect(e.progress).toBeCloseTo(0.5);
    expect(e.throughput).toBeCloseTo(1000);
    expect(e.remaining).toBeCloseTo(5);
    expect(tracker.state(120, false, 6000).progress).toBe(0.99);
    expect(tracker.state(120, true, 6000).progress).toBe(1);
    expect(readableThroughput(1536)).toBe("1.5 KB/s");
    expect(readableDuration(75)).toBe("1 min 15 s");
  });
});
