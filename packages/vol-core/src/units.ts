// packages/vol-core/src/units.ts
import type { UnitsConfig, DayCount } from "@core-types";

/** Basis points conversions at a given base value (price or tv). */
export function bpsToAbs(bps: number, baseValue: number): number {
  return (bps / 1e4) * baseValue;
}
export function absToBps(abs: number, baseValue: number): number {
  if (baseValue === 0) return 0;
  return (abs / baseValue) * 1e4;
}

/** Tick/lot helpers */
export function roundToTick(x: number, tickSize: number): number {
  return Math.round(x / tickSize) * tickSize;
}
export function ticksToAbs(ticks: number, tickSize: number): number {
  return ticks * tickSize;
}
export function absToTicks(abs: number, tickSize: number): number {
  return abs / tickSize;
}

/** Daycount helpers (Step 0–1 keeps it simple) */
export function daysToYearFraction(days: number, convention: DayCount): number {
  switch (convention) {
    case "ACT365": return days / 365.0;
    case "Y365_25": return days / 365.25;
    case "TRADING_252": return days / 252.0;
    default: return days / 365.0;
  }
}
export function yearFractionToDays(T: number, convention: DayCount): number {
  switch (convention) {
    case "ACT365": return T * 365.0;
    case "Y365_25": return T * 365.25;
    case "TRADING_252": return T * 252.0;
    default: return T * 365.0;
  }
}

/** Frozen default UnitsConfig usable before real configManager arrives. */
export const DefaultUnitsConfig: UnitsConfig = Object.freeze({
  dayCount: "ACT365",
  tickSize: 0.01,
  lotSize: 1,
  bpsValueAt: "price"
});
