import { describe, it, expect } from "vitest";
import { Fit } from "../src/index.js";

describe("convexity penalty in k-space", () => {
  it("penalizes concavity", () => {
    const k = [-1, 0, 1];
    // concave (frown): center higher than wings -> should be penalized
    const tv = [1, 1.9, 1];
    const { penalty, violations } = Fit.convexityPenaltyK(k, tv, 0);
    expect(violations).toBeGreaterThan(0);
    expect(penalty).toBeGreaterThan(0);
  });
});
