// apps/server/src/risk/factors/buildDeltaAnchoredBasis.ts

// --- Public types kept for compatibility ---
export interface Leg {
    strike: number;
    K: number;      // same as strike
    T: number;      // years to expiry
    F: number;      // forward
    isCall: boolean;
    weight: number; // e.g. size / spread^2
  }
  
  export interface Basis {
    names: string[];   // factor names
    Phi: number[][];   // [numLegs x numFactors]
    norms: string[];   // diagnostic only (stringified)
  }
  
  /**
   * Build a 5-factor variance-shape basis in normalized moneyness:
   *   0) Level (L0)      : 1
   *   1) Slope (S0)      : z
   *   2) Curvature (C0)  : z^2
   *   3) PutWing (Sneg)  : max(-z, 0)
   *   4) CallWing (Spos) : max( z, 0)
   *
   * where z = k / (atmVol * sqrt(T)),  k = ln(K/F).
   * No delta or gamma-vega terms. No extra “Convexity” factor.
   */
  export function buildDeltaAnchoredBasis(
    legs: Leg[],
    forward: number,
    T: number,
    atmIV: number
  ): Basis {
    if (!Array.isArray(legs) || legs.length < 3) {
      throw new Error('Need at least 3 legs to build factor basis');
    }
  
    const names = ['Level', 'Slope', 'Curvature', 'PutWing(10Δ)', 'CallWing(10Δ)'];
    const iv = Math.max(atmIV, 1e-6);
    const rt = Math.max(Math.sqrt(Math.max(T, 1e-8)), 1e-6);
  
    const Phi: number[][] = new Array(legs.length);
    const rawCols = Array.from({ length: 5 }, () => new Array(legs.length).fill(0));
  
    // build raw columns
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const F = leg.F ?? forward;
      const K = leg.K ?? leg.strike;
  
      const k = Math.log(Math.max(K, 1e-12) / Math.max(F, 1e-12));
      const z = k / (iv * rt);
  
      // 0: Level
      rawCols[0][i] = 1.0;
      // 1: Slope
      rawCols[1][i] = z;
      // 2: Curvature (the single curvature term we keep)
      rawCols[2][i] = z * z;
      // 3: Put wing
      rawCols[3][i] = Math.max(-z, 0);
      // 4: Call wing
      rawCols[4][i] = Math.max(z, 0);
    }
  
    // weighted Gram–Schmidt (lightweight, keeps shapes stable)
    const w = legs.map(l => Math.max(l.weight ?? 1, 1e-12));
    const m = legs.length;
  
    const dotW = (a: number[], b: number[]) => {
      let s = 0;
      for (let i = 0; i < m; i++) s += w[i] * a[i] * b[i];
      return s;
    };
  
    const orthoCols: number[][] = [];
    const norms: number[] = [];
  
    for (let j = 0; j < rawCols.length; j++) {
      // copy column
      const v = rawCols[j].slice();
  
      // subtract projections
      for (let q = 0; q < orthoCols.length; q++) {
        const coeff = dotW(v, orthoCols[q]);
        for (let i = 0; i < m; i++) v[i] -= coeff * orthoCols[q][i];
      }
  
      // normalize (with floor)
      const nrm = Math.sqrt(Math.max(dotW(v, v), 0));
      const used = Math.max(nrm, 1e-8);
      for (let i = 0; i < m; i++) v[i] /= used;
  
      orthoCols.push(v);
      norms.push(nrm);
    }
  
    // pack Phi as [row i][col j]
    for (let i = 0; i < m; i++) {
      Phi[i] = new Array(orthoCols.length);
      for (let j = 0; j < orthoCols.length; j++) {
        Phi[i][j] = orthoCols[j][i];
      }
    }
  
    const basis: Basis = {
      names,
      Phi,
      norms: norms.map(n => n.toExponential(2)),
    };
  
    console.log('[buildDeltaAnchoredBasis] Created basis:', {
      numLegs: legs.length,
      numFactors: basis.names.length,
      factors: basis.names,
      norms: basis.norms,
    });
  
    return basis;
  }
  