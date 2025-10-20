export type PremiumConvention = 'BASE' | 'QUOTE';

export interface MarketSpec {
  /** Optional id, handy for logging/telemetry */
  symbol?: string;

  /** Whether quotes are in base (e.g. USD) or quoted (e.g. BTC) units */
  premiumConvention: PremiumConvention;

  /** Contract multiplier (e.g., 100 for SPX options) */
  contractMultiplier: number;

  /** Smallest price increment in *quoted* units */
  minTick: number;

  /** Optional hard cap for quoted premium used for sanity checks */
  maxPremium?: number;

  /** BASE → QUOTED conversion (pass forward if needed; ignore if not) */
  fromBaseToQuoted: (priceBase: number, forward?: number) => number;

  /** QUOTED → BASE conversion (pass forward if needed; ignore if not) */
  fromQuotedToBase: (priceQuoted: number, forward?: number) => number;
}
