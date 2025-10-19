import { describe, it, expect } from "vitest";
import { black76Call, impliedVolFromPrice } from "../../../../../packages/vol-core/src/black76";

describe("Black-76 round-trip (price ↔ IV ↔ price)", () => {
  it("recovers price within tight tolerance", () => {
    const F = 100_000;
    const K = 100_000;
    const T = 0.25;
    const iv = 0.5;
    const df = 1.0;

    const price = black76Call(F, K, T, iv, df);
    const iv2 = impliedVolFromPrice(price, F, K, T, df, 0.4);
    const price2 = black76Call(F, K, T, iv2, df);

    const tol = 1e-8 * (1 + price);
    expect(Math.abs(price2 - price)).toBeLessThanOrEqual(tol);
  });
});
