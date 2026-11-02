import { describe, expect, it } from "vitest";
import { AdaptiveWidth } from "../src/adaptive-width.ts";

describe("adaptive decoding width", () => {
  it("switches to full width when the modules are fine, comes back when they are large", () => {
    const a = new AdaptiveWidth();
    expect(a.width(3840)).toBe(1920);
    expect(a.observe(12, 3840)).toBe(false);
    expect(a.observe(5.4, 3840)).toBe(true);
    expect(a.width(3840)).toBe(3840);
    expect(a.observe(11, 3840)).toBe(false); // hysteresis
    expect(a.observe(40, 3840)).toBe(true);
    expect(a.width(3840)).toBe(1920);
  });

  it("probes the full width when no grid is found, then comes back", () => {
    const a = new AdaptiveWidth();
    let switches = 0;
    for (let i = 0; i < 20; i++) switches += Number(a.observe(0, 3840));
    expect(switches).toBe(1);
    expect(a.width(3840)).toBe(3840);
    for (let i = 0; i < 20; i++) switches += Number(a.observe(0, 3840));
    expect(switches).toBe(2);
    expect(a.width(3840)).toBe(1920);
  });

  it("a grid found during the probe keeps the full width", () => {
    const a = new AdaptiveWidth();
    for (let i = 0; i < 20; i++) a.observe(0, 3840);
    expect(a.observe(6.5, 3840)).toBe(false);
    for (let i = 0; i < 40; i++) a.observe(0, 3840); // P hiding grids
    expect(a.width(3840)).toBe(3840);
  });

  it("no effect on a camera of 1,920 px or less", () => {
    const a = new AdaptiveWidth();
    for (let i = 0; i < 50; i++) expect(a.observe(i % 2 ? 0 : 4, 1920)).toBe(false);
    expect(a.width(1920)).toBe(1920);
  });
});
