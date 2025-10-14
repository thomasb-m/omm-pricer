// apps/server/src/risk/factors/buildDeltaAnchoredBasis.ts
/**
 * Delta-Anchored Price-Space Factor Basis
 * 
 * Factors: [Δ, Γ/𝒱 blend, Skew(25/75), CallWing(10Δ), PutWing(10Δ), Convexity]
 * Built in ln-moneyness, anchored by delta buckets, Gram-Schmidt orthogonalized
 * 
 * FIXED: Z-moneyness adaptive wing width + no-skip regularization
 */

import { black76Greeks } from '../../risk';

export interface Leg {
  strike: number;
  K: number;      // Same as strike (for compatibility)
  T: number;      // Years to expiry
  F: number;      // Forward
  isCall: boolean;
  weight: number; // Typically size/spread²
}

export interface Basis {
  names: string[];
  Phi: number[][];   // [numLegs × numFactors] factor values
  norms: number[];   // Pre-orthogonalization norms (diagnostic)
}

export interface DeltaBuckets {
  k10p: number;   // 10Δ put strike (ln-moneyness)
  k25: number;    // 25Δ strike
  kATM: number;   // ATM (ln-moneyness = 0)
  k75: number;    // 75Δ call strike
  k10c: number;   // 10Δ call strike
}

/**
 * Invert delta to find strike buckets
 * Uses bisection on Black-76 delta
 */
export function findDeltaBuckets(F: number, T: number, sigma: number): DeltaBuckets {
  const Tpos = Math.max(T, 1e-8);
  const sigmaPos = Math.max(sigma, 0.01);
  
  // Bisection to find k = ln(K/F) for target delta
  const invertDelta = (targetDelta: number, isCall: boolean): number => {
    let kL = -3.0;  // Far OTM put
    let kR = 3.0;   // Far OTM call
    
    for (let iter = 0; iter < 64; iter++) {
      const kM = 0.5 * (kL + kR);
      const K = F * Math.exp(kM);
      const g = black76Greeks(F, K, Tpos, sigmaPos, isCall, 1.0);
      const delta = g.delta;
      
      const error = delta - targetDelta;
      if (Math.abs(error) < 1e-6) return kM;
      
      // Adjust bounds
      const gL = black76Greeks(F, F * Math.exp(kL), Tpos, sigmaPos, isCall, 1.0);
      const errorL = gL.delta - targetDelta;
      
      if (errorL * error <= 0) {
        kR = kM;
      } else {
        kL = kM;
      }
    }
    
    return 0.5 * (kL + kR);
  };
  
  return {
    k10p: invertDelta(-0.10, false),  // 10Δ put (delta ≈ -0.10)
    k25: invertDelta(-0.25, false),   // 25Δ put (delta ≈ -0.25)
    kATM: 0,                          // ATM (K = F)
    k75: invertDelta(0.75, true),     // 75Δ call
    k10c: invertDelta(0.10, true)     // 10Δ call (note: delta ≈ 0.10 for deep OTM)
  };
}

/**
 * Z-moneyness: normalized distance in volatility units
 */
function zMoneyness(k: number, k0: number, sigma: number, T: number): number {
  return (k - k0) / Math.max(sigma * Math.sqrt(Math.max(T, 1e-9)), 1e-6);
}

/**
 * Gaussian bump in z-space
 */
function bumpZ(zval: number, widthZ: number): number {
  return Math.exp(-0.5 * Math.pow(zval / widthZ, 2));
}

/**
 * Gaussian bump function (legacy, for non-wing factors)
 */
function gaussianBump(x: number, sigma: number): number {
  return Math.exp(-0.5 * (x / sigma) ** 2);
}

/**
 * Build factor shapes (before orthogonalization)
 */
function buildRawFactors(
  legs: Leg[],
  F: number,
  T: number,
  sigma: number
): Array<{name: string, values: number[]}> {
  const Tpos = Math.max(T, 1e-8);
  const sigmaPos = Math.max(sigma, 0.01);
  
  // Compute greeks and ln-moneyness for each leg
  const enriched = legs.map(leg => {
    const k = Math.log(leg.strike / Math.max(F, 1e-12));
    const g = black76Greeks(F, leg.strike, Tpos, sigmaPos, leg.isCall, 1.0);
    return {
      ...leg,
      k,
      delta: g.delta,
      gamma: g.gamma,
      vega: g.vega
    };
  });
  
  // Find delta buckets
  const buckets = findDeltaBuckets(F, Tpos, sigmaPos);
  const kBand = Math.max(1e-6, Math.abs(buckets.k25 - buckets.k75));
  
  // Factor 1: Delta (∂P/∂F)
  const deltaFactor = enriched.map(leg => leg.delta);
  
  // Factor 2: Gamma/Vega blend
  // α(T) = exp(-T/T₀) where T₀ = 30 days
  const alpha = Math.exp(-Tpos / (30/365));
  const gammaVegaFactor = enriched.map(leg => {
    const gammaPrice = leg.gamma * F * F;  // Convert to price units
    return alpha * gammaPrice + (1 - alpha) * leg.vega;
  });
  
  // Factor 3: Skew (25/75Δ)
  // Linear tilt between 25Δ and 75Δ, vega-weighted
  const skewFactor = enriched.map(leg => {
    let tilde = (leg.k - buckets.kATM) / kBand;
    tilde = Math.max(-1, Math.min(1, tilde));  // Clip to [-1, 1]
    return tilde * leg.vega;
  });
  
  // Factor 4: Call Wing (10Δ) - Z-ADAPTIVE
  // Use z-moneyness for proper scaling across maturities
  const widthZ = 1.0;  // Standard deviation in z-space
  const callWingFactor = enriched.map(leg => {
    const zVal = zMoneyness(leg.k, buckets.k10c, sigmaPos, Tpos);
    return bumpZ(zVal, widthZ) * leg.vega;
  });
  
  // Factor 5: Put Wing (10Δ) - Z-ADAPTIVE
  const putWingFactor = enriched.map(leg => {
    const zVal = zMoneyness(leg.k, buckets.k10p, sigmaPos, Tpos);
    return bumpZ(zVal, widthZ) * leg.vega;
  });
  
  // Factor 6: Convexity
  // Centered quadratic, vega-weighted
  const wSum = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const kBar = enriched.reduce((s, l) => s + l.weight * l.k, 0) / wSum;
  const varK = enriched.reduce((s, l) => s + l.weight * (l.k - kBar) ** 2, 0) / wSum || 1e-6;
  
  const convexityFactor = enriched.map(leg => {
    const centered = ((leg.k - kBar) ** 2) / varK - 1;  // Zero mean
    return centered * leg.vega;
  });
  
  return [
    { name: 'Delta', values: deltaFactor },
    { name: 'GammaVega', values: gammaVegaFactor },
    { name: 'Skew(25/75)', values: skewFactor },
    { name: 'CallWing(10Δ)', values: callWingFactor },
    { name: 'PutWing(10Δ)', values: putWingFactor },
    { name: 'Convexity', values: convexityFactor }
  ];
}

/**
 * Weighted Gram-Schmidt orthonormalization
 * FIX: Don't skip low-norm factors - regularize them
 */
function orthonormalize(
  rawFactors: Array<{name: string, values: number[]}>,
  weights: number[]
): Basis {
  const m = rawFactors[0]?.values.length || 0;
  const n = rawFactors.length;
  
  if (m === 0 || n === 0) {
    throw new Error('Cannot orthonormalize empty factor set');
  }
  
  // Weighted dot product
  const wDot = (a: number[], b: number[]): number => {
    let s = 0;
    for (let i = 0; i < m; i++) {
      s += weights[i] * a[i] * b[i];
    }
    return s;
  };
  
  const names: string[] = [];
  const orthoCols: number[][] = [];
  const norms: number[] = [];
  
  for (const factor of rawFactors) {
    let v = factor.values.slice();
    
    // Subtract projections onto previous orthogonal vectors
    for (let j = 0; j < orthoCols.length; j++) {
      const proj = wDot(v, orthoCols[j]);
      for (let i = 0; i < m; i++) {
        v[i] -= proj * orthoCols[j][i];
      }
    }
    
    // Normalize (with regularization floor)
    const norm = Math.sqrt(wDot(v, v));
    
    // FIX: Don't skip - use regularization floor
    const normUsed = Math.max(norm, 1e-8);
    
    if (norm < 1e-8) {
      console.warn(`[buildBasis] Factor '${factor.name}' has low norm (${norm.toExponential(2)}), using regularization`);
    }
    
    const u = v.map(x => x / normUsed);
    
    names.push(factor.name);
    orthoCols.push(u);
    norms.push(norm);  // Store actual norm for diagnostics
  }
  
  // Pack as Phi[i][j] = factor j evaluated at leg i
  const Phi: number[][] = Array.from({length: m}, () => Array(orthoCols.length).fill(0));
  for (let j = 0; j < orthoCols.length; j++) {
    for (let i = 0; i < m; i++) {
      Phi[i][j] = orthoCols[j][i];
    }
  }
  
  return { names, Phi, norms };
}

/**
 * Main entry point: build delta-anchored basis for a set of legs
 */
export function buildDeltaAnchoredBasis(
  legs: Leg[],
  F: number,
  T: number,
  sigma: number
): Basis {
  if (legs.length < 3) {
    throw new Error('Need at least 3 legs to build factor basis');
  }
  
  // Short-dated guardrail (GPT's point 4)
  const Tmin = Math.max(T, 3/365);  // At least 3 days
  const sigmaMin = Math.max(sigma, 0.10);
  
  // Build raw factors
  const rawFactors = buildRawFactors(legs, F, Tmin, sigmaMin);
  
  // Extract weights
  const weights = legs.map(l => Math.max(l.weight, 1e-12));
  
  // Orthogonalize
  const basis = orthonormalize(rawFactors, weights);
  
  console.log('[buildDeltaAnchoredBasis] Created basis:', {
    numLegs: legs.length,
    numFactors: basis.names.length,
    factors: basis.names,
    norms: basis.norms.map(n => n.toExponential(2))
  });
  
  return basis;
}

/**
 * Convenience: build basis from market data
 */
export function buildBasisFromMarket(
  strikes: number[],
  T: number,
  F: number,
  marketMids: number[],
  weights: number[],
  optionTypes: boolean[]  // true = call, false = put
): Basis {
  const legs: Leg[] = strikes.map((K, i) => ({
    strike: K,
    K,
    T,
    F,
    isCall: optionTypes[i],
    weight: weights[i]
  }));
  
  // Use representative ATM IV for delta buckets
  const atmIdx = strikes.reduce((closest, K, i) => 
    Math.abs(K - F) < Math.abs(strikes[closest] - F) ? i : closest
  , 0);
  
  // Rough IV from ATM price
  const atmPrice = marketMids[atmIdx];
  const atmIV = Math.sqrt((2 * Math.PI / T) * (atmPrice / F)) || 0.5;
  
  return buildDeltaAnchoredBasis(legs, F, T, atmIV);
}