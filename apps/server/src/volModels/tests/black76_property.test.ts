import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { black76Call, impliedVolFromPrice } from "@vol-core/black76";

describe("Black-76 properties (price ↔ IV ↔ price holds under random inputs)", () => {
  it("round-trips across random (F,K,T,iv)", () => {
    const arb = fc.record({
      F: fc.double({ min: 1e3, max: 5e5, noNaN: true }),
      k: fc.double({ min: -0.7, max: 0.7, noNaN: true }), // log-moneyness
      T: fc.double({ min: 1/365, max: 1.0, noNaN: true }), // 1 day .. 1 year
      iv: fc.double({ min: 0.05, max: 2.0, noNaN: true }),
    });

    fc.assert(fc.property(arb, ({F,k,T,iv}) => {
      const K = F * Math.exp(k);
      const df = 1.0;

      const p1 = black76Call(F, K, T, iv, df);
      const iv2 = impliedVolFromPrice(p1, F, K, T, df, 0.3);
      const p2 = black76Call(F, K, T, iv2, df);

      const tol = 1e-7 * (1 + p1);
      return Number.isFinite(iv2) && Math.abs(p2 - p1) <= tol;
    }), { numRuns: 200 });
  });
});
