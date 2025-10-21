import { describe, it, expect } from "vitest";
import { loadConfig } from "../config/configManager";

describe("pricing config integration", () => {
  it("config loads successfully with all required pricing fields", () => {
    const cfg = loadConfig();

    // Loaded + frozen
    expect(cfg).toBeTruthy();
    expect(Object.isFrozen(cfg)).toBe(true);

    // Pricing-critical fields
    expect(cfg.features.enablePricing).toBe(true);
    expect(cfg.primitives.daycount).toBe("ACT_365");
    expect(cfg.primitives.epsilonT).toBe(1e-9);

    // Risk structure
    expect(cfg.risk.covariance.sources).toEqual(["factor_returns", "pnl_innovations"]);
    expect(cfg.risk.lambda.targetVolBps).toBe(50);
    expect(cfg.risk.lambda.learningRate).toBe(0.01);
  });
});
