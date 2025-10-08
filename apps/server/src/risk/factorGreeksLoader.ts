// apps/server/src/risk/factorGreeksLoader.ts
/**
 * Bridge between existing FactorSpace and new factor registry system
 * 
 * Version 2: Now returns 7 factors [F, Gamma, L0, S0, C0, Sneg, Spos]
 * Gamma is computed via finite-diff on F (second derivative)
 */

import { FACTORS, d, FACTOR_LABELS, FactorVector } from './factors';
import { 
  finiteDiffGreeks, 
  PriceFn, 
  Theta,
  defaultEpsilons,
  cloneTheta
} from './FactorSpace';

// Export your existing types so other modules can use them
export type { Theta, PriceFn } from './FactorSpace';

/**
 * Your instrument type - adjust if needed
 */
export type Instrument = {
  symbol: string;
  strike: number;
  expiryMs: number;
  isCall: boolean;
};

/**
 * Market context wraps the theta vector
 */
export type MarketContext = {
  theta: Theta;  // [L0, S0, C0, Sneg, Spos, F] (from FactorSpace)
};

/**
 * Compute Gamma via finite difference on F (second derivative)
 * Gamma = d²P/dF² ≈ (P(F+h) - 2P(F) + P(F-h)) / h²
 */
function computeGamma(
  priceFn: PriceFn<Instrument>,
  theta: Theta,
  inst: Instrument,
  h: number = 10  // Bump size in underlying price units (e.g., $10 for BTC)
): number {
  // F is at index 5 in your FactorSpace theta
  const thetaPlus = cloneTheta(theta);
  const thetaMinus = cloneTheta(theta);
  const thetaBase = theta;
  
  thetaPlus[5] += h;
  thetaMinus[5] -= h;
  
  const pPlus = priceFn(thetaPlus, inst);
  const pBase = priceFn(thetaBase, inst);
  const pMinus = priceFn(thetaMinus, inst);
  
  // Second derivative
  const gamma = (pPlus - 2 * pBase + pMinus) / (h * h);
  
  return isFinite(gamma) ? gamma : 0;
}

/**
 * Compute factor greeks: [F, Gamma, L0, S0, C0, Sneg, Spos]
 * 
 * Your FactorSpace returns: [L0, S0, C0, Sneg, Spos, F]
 * We reorder and add Gamma to match the new registry
 * 
 * @param instr - Option instrument
 * @param ctx - Market context containing theta
 * @param priceFn - Your pricing function
 * @param eps - Optional bump sizes (defaults to defaultEpsilons)
 * @returns Factor greeks in registry order [F, Gamma, L0, S0, C0, Sneg, Spos]
 */
export function factorGreeksFor(
    instr: Instrument,
    ctx: MarketContext,
    priceFn: PriceFn<Instrument>,
    eps?: Theta
  ): number[] {
    // Get base greeks from FactorSpace
    const baseGreeks = finiteDiffGreeks(priceFn, ctx.theta, instr, eps);
    const gamma = computeGamma(priceFn, ctx.theta, instr);
    
    // Get current price for normalization
    const basePrice = priceFn(ctx.theta, instr);
    
    // Normalize greeks: express as "fraction of contract value per factor unit"
    // This makes them comparable across strikes and maturities
    const normalize = (g: number) => {
      return basePrice > 0 ? g / basePrice : 0;
    };
    
    // Reorder to registry and normalize
    const raw = [
      baseGreeks[5],  // F
      gamma,          // Gamma
      baseGreeks[0],  // L0
      baseGreeks[1],  // S0
      baseGreeks[2],  // C0
      baseGreeks[3],  // Sneg
      baseGreeks[4],  // Spos
    ];
    
    // Additional scaling for each factor type
    const typeScales = [
        1.0,     // F
        0.0001,  // Gamma
        0.001,   // L0
        0.01,    // S0 ← 10x smaller (was 0.1, now 0.01)
        0.1,     // C0
        0.1,     // Sneg
        0.1,     // Spos
      ];
    
    return raw.map((g, i) => normalize(g) * typeScales[i]);
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