// src/markets/specs/deribitBTC.ts
import { MarketSpec } from '../types';

export const DeribitBTC: MarketSpec = {
  symbol: 'BTC',
  premiumConvention: 'QUOTE',
  contractMultiplier: 1,
  minTick: 0.0001,          // 1 satoshi in BTC terms
  maxPremium: 1.0,          // can't be > 1 BTC per BTC
  fromBaseToQuoted: (priceUSD, F) => priceUSD / Math.max(F, 1e-6), // USD → BTC
  fromQuotedToBase: (priceBTC, F) => priceBTC * Math.max(F, 1e-6), // BTC → USD
};
