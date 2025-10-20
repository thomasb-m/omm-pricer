import { MarketSpec } from '../types';

export function quoteFromBase(base: number, F: number, mkt: MarketSpec): number {
  return mkt.fromBaseToQuoted(base, F);
}
export function baseFromQuote(quoted: number, F: number, mkt: MarketSpec): number {
  return mkt.fromQuotedToBase(quoted, F);
}
export function clampQuoted(p: number, mkt: MarketSpec): number {
  const lo = Math.max(mkt.minTick * 0.5, 0);
  const hi = mkt.maxPremium ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(p, lo), hi);
}
