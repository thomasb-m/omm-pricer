// src/markets/types.ts

/** How option premiums are expressed for a market. */
export type PremiumConvention = 'QUOTE' | 'BASE';
/*
  QUOTE: premium is in underlying units (e.g., BTC per contract)
  BASE : premium is in base currency (e.g., USD per contract)
*/

/** Minimal shape every market spec must implement. */
export interface MarketSpec {
  /** Registry key / human id, e.g. 'BTC', 'ETH', 'SPX'. */
  id: string;

  /** Price unit convention for premiums. */
  premiumConvention: PremiumConvention;

  /** Minimum price increment in *quoted* units. */
  minTick: number;

  /** Optional sanity cap on premium in *quoted* units (per contract). */
  maxPremium?: number;

  /**
   * Convert a premium expressed in BASE currency into QUOTED units.
   * Example (crypto): USD → BTC using forward (USD/BTC).
   */
  fromBaseToQuoted(basePremium: number, forward: number): number;

  /**
   * Convert a premium expressed in QUOTED units back to BASE currency.
   * Example (crypto): BTC → USD using forward (USD/BTC).
   */
  fromQuotedToBase(quotedPremium: number, forward: number): number;
}

/** Shape of the registry used by getMarketSpec(symbol). */
export type MarketRegistry = Record<string, MarketSpec>;
