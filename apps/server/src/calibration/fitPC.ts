// apps/server/src/calibration/fitPC.ts
/**
 * Price-space PC calibration with no-arb enforcement
 * 
 * Fits: pc = cc + G·θ
 * Where:
 *   - cc: calibration-consistent prices from SVI
 *   - G: factor greeks matrix (∂P/∂θ)
 *   - θ: factor adjustments to minimize ||W^(1/2)(pc - market)||²
 * 
 * FIXED: Adaptive ridge for high condition number
 */

export interface PCFitInput {
    // Market data
    legs: Array<{
      strike: number;
      K: number;
      T: number;
      F: number;
      isCall: boolean;
      marketMid: number;
      weight: number;  // Typically size/(spread²)
    }>;
    
    // CC prices (your SVI-based belief)
    ccPrices: number[];
    
    // Factor greeks: G[i][j] = ∂P_i/∂θ_j
    factorGreeks: number[][];  // [numLegs × 6]
    
    // Regularization
    ridge: number;  // λ for ||θ||² penalty
    
    // Optional: caps on factor moves
    thetaMax?: number[];  // Max absolute change per factor
  }
  
  export interface PCFitOutput {
    // Fitted factor adjustments
    theta: number[];
    
    // PC prices: cc + G·θ
    pcPrices: number[];
    
    // Diagnostics
    rmse: number;
    maxError: number;
    within1TickPct: number;
    condG: number;
    ridgeUsed: number;  // Actual ridge used (may be inflated)
    
    // No-arb status
    noArbViolations: string[];
    shrinkApplied: number;  // 1.0 = no shrink, <1 = shrank to enforce no-arb
  }
  
  /**
   * Matrix operations
   */
  function matTvec(A: number[][], w: number[], v: number[]): number[] {
    const m = A.length;
    const n = A[0].length;
    const out = new Array(n).fill(0);
    
    for (let i = 0; i < m; i++) {
      const wi = w[i];
      const Ai = A[i];
      const vi = v[i];
      for (let j = 0; j < n; j++) {
        out[j] += Ai[j] * (wi * vi);
      }
    }
    
    return out;
  }
  
  function matTmat(A: number[][], w: number[]): number[][] {
    const m = A.length;
    const n = A[0].length;
    const out = Array.from({length: n}, () => new Array(n).fill(0));
    
    for (let i = 0; i < m; i++) {
      const wi = w[i];
      const Ai = A[i];
      for (let j = 0; j < n; j++) {
        const Aij = Ai[j];
        for (let k = 0; k < n; k++) {
          out[j][k] += Aij * (wi * Ai[k]);
        }
      }
    }
    
    return out;
  }
  
  function choleskySolve(A: number[][], b: number[]): number[] {
    const n = A.length;
    const L = Array.from({length: n}, () => new Array(n).fill(0));
    
    // Cholesky decomposition
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = 0;
        for (let k = 0; k < j; k++) {
          s += L[i][k] * L[j][k];
        }
        
        if (i === j) {
          L[i][j] = Math.sqrt(Math.max(A[i][i] - s, 1e-18));
        } else {
          L[i][j] = (A[i][j] - s) / L[j][j];
        }
      }
    }
    
    // Forward solve L y = b
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) {
        s -= L[i][k] * y[k];
      }
      y[i] = s / L[i][i];
    }
    
    // Back solve L^T x = y
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) {
        s -= L[k][i] * x[k];
      }
      x[i] = s / L[i][i];
    }
    
    return x;
  }
  
  /**
   * Ridge regression with optional theta caps
   * FIX: Adaptive ridge for high condition number
   */
  function solveRidge(
    G: number[][],
    y: number[],
    w: number[],
    lambda: number,
    thetaMax?: number[]
  ): { theta: number[], ridgeUsed: number, condG: number } {
    const m = G.length;
    const n = G[0].length;
    
    // Solve: (G^T W G + λI) θ = G^T W y
    const GTWy = matTvec(G, w, y);
    const GTWG = matTmat(G, w);
    
    // Compute condition number
    let minDiag = Infinity, maxDiag = -Infinity;
    for (let i = 0; i < n; i++) {
      minDiag = Math.min(minDiag, GTWG[i][i]);
      maxDiag = Math.max(maxDiag, GTWG[i][i]);
    }
    const condG = maxDiag / Math.max(minDiag, 1e-12);
    
    // FIX: Adaptive ridge for high condition
    let ridgeUsed = lambda;
    if (condG > 1e4) {
      ridgeUsed = lambda * 10;
      console.log(`[fitPC] High condition (${condG.toExponential(2)}), inflating ridge to ${ridgeUsed.toExponential(2)}`);
    }
    
    // Add ridge
    for (let j = 0; j < n; j++) {
      GTWG[j][j] += ridgeUsed;
    }
    
    let theta = choleskySolve(GTWG, GTWy);

    // ✅ SANITY CHECK: Detect solver failure
    if (theta.every(t => Math.abs(t - theta[0]) < 1e-9)) {
        console.warn(`[fitPC] All theta equal (${theta[0].toFixed(6)}), possible solver issue`);
        console.warn(`[fitPC] GTWG diagonal:`, GTWG.map((row, i) => row[i].toExponential(2)));
        console.warn(`[fitPC] GTWy:`, GTWy.map(y => y.toExponential(2)));
        console.warn(`[fitPC] Condition number: ${condG.toExponential(2)}`);
    }
    
    // Apply caps if provided
    if (thetaMax) {
      for (let j = 0; j < n; j++) {
        const cap = thetaMax[j];
        if (cap > 0 && Math.abs(theta[j]) > cap) {
          theta[j] = Math.sign(theta[j]) * cap;
        }
      }
    }
    
    return { theta, ridgeUsed, condG };
  }
  
  /**
   * No-arbitrage checks
   */
  function checkNoArb(
    legs: PCFitInput['legs'],
    pcPrices: number[]
  ): string[] {
    const violations: string[] = [];
    
    // Group by expiry
    const expiryGroups = new Map<number, Array<{idx: number, strike: number, price: number, isCall: boolean}>>();
    
    legs.forEach((leg, idx) => {
      if (!expiryGroups.has(leg.T)) {
        expiryGroups.set(leg.T, []);
      }
      expiryGroups.get(leg.T)!.push({
        idx,
        strike: leg.strike,
        price: pcPrices[idx],
        isCall: leg.isCall
      });
    });
    
    // Check each expiry
    for (const [T, group] of expiryGroups) {
      // Separate calls and puts
      const calls = group.filter(x => x.isCall).sort((a, b) => a.strike - b.strike);
      const puts = group.filter(x => !x.isCall).sort((a, b) => a.strike - b.strike);
      
      // 1. Calls decreasing in strike
      for (let i = 1; i < calls.length; i++) {
        if (calls[i].price > calls[i-1].price + 1e-8) {
          violations.push(
            `Call vertical arb: K${i-1}=${calls[i-1].strike} -> K${i}=${calls[i].strike}, ` +
            `P${i-1}=${calls[i-1].price.toFixed(6)} < P${i}=${calls[i].price.toFixed(6)}`
          );
        }
      }
      
      // 2. Puts increasing in strike
      for (let i = 1; i < puts.length; i++) {
        if (puts[i].price < puts[i-1].price - 1e-8) {
          violations.push(
            `Put vertical arb: K${i-1}=${puts[i-1].strike} -> K${i}=${puts[i].strike}, ` +
            `P${i-1}=${puts[i-1].price.toFixed(6)} > P${i}=${puts[i].price.toFixed(6)}`
          );
        }
      }
      
      // 3. Butterfly check (simplified)
      for (let i = 1; i < calls.length - 1; i++) {
        const K1 = calls[i-1].strike;
        const K2 = calls[i].strike;
        const K3 = calls[i+1].strike;
        const P1 = calls[i-1].price;
        const P2 = calls[i].price;
        const P3 = calls[i+1].price;
        
        const w = (K2 - K1) / (K3 - K1);
        const interp = (1 - w) * P1 + w * P3;
        
        if (P2 > interp + 1e-6) {
          violations.push(
            `Butterfly arb at K=${K2}: price=${P2.toFixed(6)} > interp=${interp.toFixed(6)}`
          );
        }
      }
    }
    
    return violations;
  }
  
  /**
   * Main PC fit with no-arb enforcement
   */
  export function fitPC(input: PCFitInput): PCFitOutput {
    const { legs, ccPrices, factorGreeks, ridge, thetaMax } = input;
    const m = legs.length;
    const n = factorGreeks[0].length;
    
    // Residuals: y = market - cc
    const y = legs.map((leg, i) => leg.marketMid - ccPrices[i]);
    const w = legs.map(leg => leg.weight);
    
    // Initial fit with adaptive ridge
    const solveResult = solveRidge(factorGreeks, y, w, ridge, thetaMax);
    let theta = solveResult.theta;
    const ridgeUsed = solveResult.ridgeUsed;
    const condG = solveResult.condG;
    
    let pcPrices = ccPrices.map((cc, i) => {
      let adj = 0;
      for (let j = 0; j < n; j++) {
        adj += factorGreeks[i][j] * theta[j];
      }
      return cc + adj;
    });
    
    // Check no-arb
    let violations = checkNoArb(legs, pcPrices);
    let shrinkFactor = 1.0;
    
    // Shrink theta until no violations (max 10 iterations)
    let iter = 0;
    while (violations.length > 0 && iter < 10) {
      shrinkFactor *= 0.7;
      
      const thetaShrunk = theta.map(t => t * shrinkFactor);
      pcPrices = ccPrices.map((cc, i) => {
        let adj = 0;
        for (let j = 0; j < n; j++) {
          adj += factorGreeks[i][j] * thetaShrunk[j];
        }
        return cc + adj;
      });
      
      violations = checkNoArb(legs, pcPrices);
      iter++;
    }
    
    if (violations.length > 0) {
      console.warn(`[fitPC] ${violations.length} no-arb violations remain after shrinking to ${shrinkFactor.toFixed(3)}`);
    }
    
    theta = theta.map(t => t * shrinkFactor);
    
    // Diagnostics
    const residuals = legs.map((leg, i) => pcPrices[i] - leg.marketMid);
    const wSum = w.reduce((s, wi) => s + wi, 0) || 1;
    const rmse = Math.sqrt(residuals.reduce((s, ri, i) => s + w[i] * ri * ri, 0) / wSum);
    const maxError = Math.max(...residuals.map(Math.abs));
    const within1Tick = residuals.filter(r => Math.abs(r) <= 0.0001).length / m;
    
    return {
      theta,
      pcPrices,
      rmse,
      maxError,
      within1TickPct: within1Tick,
      condG,
      ridgeUsed,
      noArbViolations: violations,
      shrinkApplied: shrinkFactor
    };
  }