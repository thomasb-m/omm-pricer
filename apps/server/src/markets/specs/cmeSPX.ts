import { MarketSpec } from '../types';

export const CMESPX: MarketSpec = {
  symbol: 'SPX',
  premiumConvention: 'BASE',
  contractMultiplier: 100,
  minTick: 0.05,
  fromBaseToQuoted: (priceUSD) => priceUSD,
  fromQuotedToBase: (priceUSD) => priceUSD,
};
