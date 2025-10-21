import { MarketSpec } from '../types';

export const DeribitBTC: MarketSpec = {
  symbol: 'BTC',
  premiumConvention: 'QUOTE',
  contractMultiplier: 1,
  minTick: 0.0001,
  maxPremium: 1.0,
  fromBaseToQuoted: (priceUSD, F) => priceUSD / Math.max(F || 1, 1e-6),
  fromQuotedToBase: (priceBTC, F) => priceBTC * Math.max(F || 1, 1e-6),
};
