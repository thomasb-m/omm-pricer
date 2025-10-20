import { MarketSpec } from '../types';

export const CMESPX: MarketSpec = {
  symbol: 'SPX',
  premiumConvention: 'BASE',     // quoted in USD
  contractMultiplier: 100,
  minTick: 0.05,
  maxPremium: 1e6,
  fromBaseToQuoted: (priceUSD) => priceUSD,
  fromQuotedToBase: (priceUSD) => priceUSD,
};
