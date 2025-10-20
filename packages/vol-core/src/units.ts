import { DayCount } from "@core-types";

export function secondsPerYearFor(dc: DayCount): number {
  switch (dc) {
    case "ACT_365":
      return 365 * 24 * 3600;
    case "ACT_365_25":
      return 365.25 * 24 * 3600;
    case "BUS_252":
      return 252 * 24 * 3600;
    default:
      throw new Error(`Unknown daycount: ${dc}`);
  }
}

export function timeToExpirySeconds(
  nowSec: number,
  expirySec: number,
  epsSec = 1e-6
): number {
  const dt = expirySec - nowSec;
  return Math.max(dt, epsSec);
}

export function timeToExpiryYears(
  nowSec: number,
  expirySec: number,
  dc: DayCount = "ACT_365",
  epsSec = 1e-6
): number {
  const dt = timeToExpirySeconds(nowSec, expirySec, epsSec);
  return dt / secondsPerYearFor(dc);
}

export function bpsToAbs(bps: number, base: number): number {
  return (bps / 1e4) * base;
}

export function absToBps(abs: number, base: number): number {
  return base === 0 ? 0 : (abs / base) * 1e4;
}

// Legacy interface for backward compat
export interface UnitsConfig {
  daycount: DayCount;
  epsilonT: number;
}
