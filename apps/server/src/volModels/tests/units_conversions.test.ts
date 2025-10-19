import { describe, it, expect } from "vitest";
import { bpsToAbs, absToBps, roundToTick, daysToYearFraction, yearFractionToDays } from "../../../../../packages/vol-core/src/units";

describe("Units conversions", () => {
  it("bps ↔ abs round-trip at a base", () => {
    const base = 123.456;
    const bps = 37.5;
    const abs = bpsToAbs(bps, base);
    const bps2 = absToBps(abs, base);
    expect(Math.abs(bps2 - bps)).toBeLessThan(1e-12);
  });

  it("tick rounding is stable", () => {
    const tick = 0.25;
    const x = 101.37;
    const rounded = roundToTick(x, tick);
    expect(Math.abs(rounded / tick - Math.round(x / tick))).toBeLessThan(1e-12);
  });

  it("daycount conversions are consistent", () => {
    const days = 90;
    const T1 = daysToYearFraction(days, "ACT365");
    const daysBack = yearFractionToDays(T1, "ACT365");
    expect(Math.abs(daysBack - days)).toBeLessThan(1e-12);

    const T2 = daysToYearFraction(days, "Y365_25");
    expect(T2).toBeCloseTo(days / 365.25, 12);

    const T3 = daysToYearFraction(days, "TRADING_252");
    expect(T3).toBeCloseTo(days / 252.0, 12);
  });
});
