import { describe, it, expect } from "vitest";
import { sviIV } from "@vol-core/smile";

describe("SVI → IV basic sanity", () => {
  it("returns finite, non-negative IV for sane params", () => {
    const svi = { a: 0.02, b: 0.3, rho: -0.2, m: 0.0, sigma: 0.5 };
    const k = 0.0;
    const T = 0.25;
    const iv = sviIV(k, T, svi);
    expect(Number.isFinite(iv)).toBe(true);
    expect(iv).toBeGreaterThanOrEqual(0);
  });
});
