// Basic units helpers used by server tests

/** Convert basis points to absolute amount relative to a base value. */
export function bpsToAbs(bps: number, base: number): number {
  // 1 bp = 1e-4
  return (bps * 1e-4) * base;
}

/** Convert absolute amount to basis points relative to a base value. */
export function absToBps(abs: number, base: number): number {
  const denom = Math.max(Math.abs(base), Number.EPSILON);
  return (abs / denom) * 1e4;
}

/** Round a number to the nearest tick size. */
export function roundToTick(x: number, tick: number): number {
  const t = Math.max(tick, Number.EPSILON);
  return Math.round(x / t) * t;
}

/** Day-count conversions used in tests. */
export type DayCount = 'ACT365' | 'Y365_25' | 'TRADING_252';

/** Convert calendar days to a year fraction given a convention. */
export function daysToYearFraction(days: number, conv: DayCount): number {
  switch (conv) {
    case 'ACT365':     return days / 365.0;
    case 'Y365_25':    return days / 365.25;
    case 'TRADING_252':return days / 252.0;   // ← test expects trading-days basis
    default:           return days / 365.0;
  }
}

/** Convert a year fraction back to calendar days given a convention. */
export function yearFractionToDays(T: number, conv: DayCount): number {
  switch (conv) {
    case 'ACT365':     return T * 365.0;
    case 'Y365_25':    return T * 365.25;
    case 'TRADING_252':return T * 252.0;      // ← inverse of the above
    default:           return T * 365.0;
  }
}
