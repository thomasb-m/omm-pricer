import { MarketSpec } from './types';
import { DeribitBTC } from './specs/deribitBTC';
import { CMESPX } from './specs/cmeSPX';

const registry: Record<string, MarketSpec> = {
  BTC: DeribitBTC,
  SPX: CMESPX,
};

export function getMarketSpec(symbol: string): MarketSpec {
  return registry[symbol] ?? DeribitBTC;
}

export type { MarketSpec } from './types';
export { clampQuoted, quoteFromBase } from './utils/quoteUnits';
