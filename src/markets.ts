export type PremiumConvention = 'QUOTE' | 'BASE';

export interface MarketSpec {
  symbol: string;
  /** Where option premiums are quoted */
  premiumConvention: PremiumConvention;
  /** Smallest price increment in quoted units */
  minTick: number;
  /** Hard cap for quoted premium (e.g., ≤ 1 BTC). Undefined = no cap. */
  maxPremium?: number;

  /** Convert base-currency price (e.g., USD) → quoted units (e.g., BTC) */
  fromBaseToQuoted(basePrice: number, forward: number): number;
  /** Convert quoted units → base currency */
  fromQuotedToBase(quotedPrice: number, forward: number): number;
}

/** Returns the market spec for a product symbol. Extend as needed. */
export function getMarketSpec(product: string): MarketSpec {
  const Fsafe = (F: number) => Math.max(F, 1e-6);

  switch (product.toUpperCase()) {
    case 'BTC':
      return {
        symbol: 'BTC',
        premiumConvention: 'QUOTE',   // premiums in BTC
        minTick: 0.0001,
        maxPremium: 1.0,              // option worth ≤ 1 BTC
        fromBaseToQuoted: (base, F) => base / Fsafe(F),
        fromQuotedToBase: (q, F) => q * Fsafe(F),
      };

    case 'ETH':
      return {
        symbol: 'ETH',
        premiumConvention: 'QUOTE',   // premiums in ETH
        minTick: 0.001,
        maxPremium: 1.0,              // option worth ≤ 1 ETH (tune if you prefer)
        fromBaseToQuoted: (base, F) => base / Fsafe(F),
        fromQuotedToBase: (q, F) => q * Fsafe(F),
      };

    case 'SPX':
      return {
        symbol: 'SPX',
        premiumConvention: 'BASE',    // premiums already in USD
        minTick: 0.05,                // typical SPX option tick
        // no maxPremium cap in USD by default
        fromBaseToQuoted: (base) => base,
        fromQuotedToBase: (q) => q,
      };

    default:
      // Sensible fallback: treat as base-quoted with penny tick
      return {
        symbol: product.toUpperCase(),
        premiumConvention: 'BASE',
        minTick: 0.01,
        fromBaseToQuoted: (base) => base,
        fromQuotedToBase: (q) => q,
      };
  }
}
