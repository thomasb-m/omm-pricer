import { describe, it, expect } from "vitest";
import { Fit } from "../src/index.js";

describe("IRLS (Huber) recovers slope ~2 on noisy data", () => {
  it("fits y ≈ 1 + 2x with outliers", () => {
    const x = Array.from({length: 50}, (_,i)=> i/10);
    const y = x.map(v => 1 + 2*v + (Math.random()-0.5)*0.1);
    y[5] += 5; y[30] -= 4;

    const { beta0, beta1 } = Fit.irls(x, y, { kind: "huber", c: 1.345, maxIter: 50 });
    expect(beta1).toBeGreaterThan(1.7);
    expect(beta1).toBeLessThan(2.3);
    expect(beta0).toBeGreaterThan(0.5);
    expect(beta0).toBeLessThan(1.5);
  });
});
