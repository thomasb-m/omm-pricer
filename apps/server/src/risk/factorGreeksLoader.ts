// apps/server/src/risk/factorGreeksLoader.ts
/**
 * Bridge between existing FactorSpace and new factor registry system
 * 
 * Your existing finiteDiffGreeks already computes the 6 factors we need,
 * so this is just a thin wrapper that adds metadata.
 */

import { FACTORS, d, FACTOR_LABELS, FactorVector } from './factors';
import { 
  finiteDiffGreeks, 
  PriceFn, 
  Theta,
  defaultEpsilons 
} from './FactorSpace';

// Export your existing types so other modules can use them
export type { Theta, PriceFn } from './FactorSpace';

/**
 * Your instrument type - adjust if needed
 * (Look in your codebase for the actual Instrument interface)
 */
export type Instrument = {
  symbol: string;
  strike: number;
  expiryMs: number;
  isCall: boolean;
  // Add other fields your instrument has
};

/**
 * Market context wraps the theta vector
 */
export type MarketContext = {
  theta: Theta;  // [L0, S0, C0, Sneg, Spos, F]
  // Add other market data you need (rates, etc.)
};

/**
 * Compute factor greeks using your existing finite-diff method
 * Returns raw array: [L0, S0, C0, Sneg, Spos, F]
 * 
 * @param instr - Option instrument
 * @param ctx - Market context containing theta
 * @param priceFn - Your pricing function
 * @param eps - Optional bump sizes (defaults to defaultEpsilons)
 * @returns Factor greeks in registry order
 */
export function factorGreeksFor(
  instr: Instrument,
  ctx: MarketContext,
  priceFn: PriceFn<Instrument>,
  eps?: Theta
): number[] {
  // Your existing function already returns the correct order!
  return finiteDiffGreeks(priceFn, ctx.theta, instr, eps);
}

/**
 * Get factor greeks with metadata (for logging to DB)
 */
export function factorGreeksWithMetadata(
  instr: Instrument,
  ctx: MarketContext,
  priceFn: PriceFn<Instrument>,
  eps?: Theta
): FactorVector {
  return {
    version: FACTORS.version,
    labels: [...FACTOR_LABELS],
    values: factorGreeksFor(instr, ctx, priceFn, eps),
  };
}

/**
 * Validate that computed greeks are sane
 */
export function validateGreeks(g: number[], symbol: string): void {
  if (g.length !== d) {
    throw new Error(
      `Greeks dimension mismatch for ${symbol}: expected ${d}, got ${g.length}`
    );
  }
  
  for (let i = 0; i < d; i++) {
    if (!isFinite(g[i])) {
      console.warn(
        `Non-finite greek for ${symbol} at factor ${FACTOR_LABELS[i]}: ${g[i]}`
      );
      g[i] = 0; // Safe fallback
    }
  }
}