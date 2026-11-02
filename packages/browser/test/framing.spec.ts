import { describe, expect, it } from "vitest";
import { FramingSmoother } from "../src/framing.ts";

describe("FramingSmoother", () => {
  it("ignores transitions and isolated advice", () => {
    const l = new FramingSmoother();
    expect(l.track("")).toBe("");
    // An isolated saturated image, a transition: the frame stays green.
    expect(l.track("Image saturated")).toBe("");
    expect(l.track(null)).toBe("");
    expect(l.track("")).toBe("");
  });

  it("turns orange after 4 agreeing images, back to green after 2", () => {
    const l = new FramingSmoother();
    l.track("");
    for (let i = 0; i < 3; i++) expect(l.track("Too far")).toBe("");
    expect(l.track("Too far")).toBe("Too far");
    expect(l.track("")).toBe("Too far");
    expect(l.track("")).toBe("");
  });
});
