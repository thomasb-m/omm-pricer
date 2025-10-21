import { describe, it, expect } from "vitest";
import { Fit } from "../src/index.js";

describe("static no-arb (light)", () => {
  it("reports zero violations for convex tv", () => {
    const k = [-1,-0.5,0,0.5,1];
    const tv = [1,0.3,0.2,0.3,1];
    const d = Fit.staticNoArbDiagnostics(k, tv);
    expect(d.violations).toBe(0);
  });
});
