import { describe, expect, it } from "vitest";
import { moduleDiagnostic, autoModuleSize } from "../src/tm.ts";

describe("automatic module size (whole physical pixels)", () => {
  it("fits the mosaic in the short side of the container", () => {
    // Full-screen 1080p screen: 45 modules per grid (41 + quiet zone).
    expect(autoModuleSize(1920, 1080, 1)).toBe(24);
    expect(autoModuleSize(1920, 1080, 2)).toBe(12);
    expect(autoModuleSize(1920, 1080, 3)).toBe(8);
    expect(autoModuleSize(1920, 1080, 4)).toBe(6);
    for (const k of [1, 2, 3, 4, 5]) expect(autoModuleSize(1920, 1080, k) * 45 * k).toBeLessThanOrEqual(1080);
  });

  it("counts in physical pixels (screen density)", () => {
    // 412 × 915 CSS phone at density 2.625: 1,081 physical pixels wide.
    expect(autoModuleSize(412, 915, 3, 2.625)).toBe(8);
  });

  it("never goes below 2 pixels per module", () => {
    expect(autoModuleSize(200, 200, 7)).toBe(2);
  });
});

describe("module size alert", () => {
  it("nothing to report above 5 px, up to 3 × 3", () => {
    expect(moduleDiagnostic(8, 3)).toEqual({ level: "ok", message: "" });
  });

  it("beyond 3 × 3: warn that a 4K receiver is needed", () => {
    expect(moduleDiagnostic(6, 4).level).toBe("info");
  });

  it("4 px: warning, and the suggested mosaic keeps 5 px per module", () => {
    const d = moduleDiagnostic(4, 3); // 540 px side
    expect(d.level).toBe("warning");
    expect(d.message).toContain("2 × 2");
  });

  it("2 px: critical; a single grid if even 2 × 2 would be too fine", () => {
    const d = moduleDiagnostic(2, 4); // 360 px side
    expect(d.level).toBe("critical");
    expect(d.message).toContain("a single grid");
  });

  it("dense screen: 8 physical px at density 3 are only 2.7 CSS px — warning", () => {
    const d = moduleDiagnostic(8, 3, 3);
    expect(d.level).toBe("warning");
    expect(d.message).toContain("CSS px");
    expect(moduleDiagnostic(8, 3, 1).level).toBe("ok");
  });

  it("dense screen: 5 physical px at density 3 — critical", () => {
    expect(moduleDiagnostic(5, 4, 3).level).toBe("critical");
  });
});
