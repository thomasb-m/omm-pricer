// server/src/risk/FactorSpace.ts
//
// Factor basis + tiny vector ops + finite-diff factor greeks.
// This is agnostic to your internal CC model. You pass a priceFn.

export enum FactorIndex {
    L0 = 0,     // level
    S0 = 1,     // skew
    C0 = 2,     // curvature
    Sneg = 3,   // left wing
    Spos = 4,   // right wing
    F = 5,      // forward
  }
  
  export type Theta = [number, number, number, number, number, number]; // [L0,S0,C0,Sneg,Spos,F]
  export type Vec = number[];
  export type Mat = number[][];
  
  export const factorNames: Record<FactorIndex, string> = {
    [FactorIndex.L0]: "L0",
    [FactorIndex.S0]: "S0",
    [FactorIndex.C0]: "C0",
    [FactorIndex.Sneg]: "Sneg",
    [FactorIndex.Spos]: "Spos",
    [FactorIndex.F]: "F",
  };
  
  export const defaultEpsilons: Theta = [
    1e-4,   // L0
    1e-4,   // S0
    5e-4,   // C0
    5e-4,   // Sneg
    5e-4,   // Spos
    1e-2,   // F (in underlying price units)
  ];
  
  export function dot(a: Vec, b: Vec): number {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }
  
  export function add(a: Vec, b: Vec): Vec {
    const n = Math.min(a.length, b.length);
    const o = new Array(n);
    for (let i = 0; i < n; i++) o[i] = a[i] + b[i];
    return o;
  }
  
  export function scale(a: Vec, k: number): Vec {
    const o = new Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] * k;
    return o;
  }
  
  export function cloneTheta(t: Theta): Theta {
    return [t[0], t[1], t[2], t[3], t[4], t[5]];
  }
  
  // PriceFn signature: given (theta, instrument), return Black-76 price (or mid) in USD per contract.
  export type PriceFn<I> = (theta: Theta, inst: I) => number;
  
  /**
   * Central finite difference for factor greeks g_i = ∂P/∂θ
   * Safe defaults; replace later with analytic partials for speed/noise.
   */
  export function finiteDiffGreeks<I>(
    priceFn: PriceFn<I>,
    theta: Theta,
    inst: I,
    eps: Theta = defaultEpsilons
  ): number[] {
    const base = priceFn(theta, inst);
    const g = new Array(6).fill(0);
    for (let k = 0; k < 6; k++) {
      const h = eps[k];
      if (!isFinite(h) || h <= 0) continue;
      const thPlus = cloneTheta(theta);
      const thMinus = cloneTheta(theta);
      thPlus[k] += h;
      thMinus[k] -= h;
      const pPlus = priceFn(thPlus, inst);
      const pMinus = priceFn(thMinus, inst);
      g[k] = (pPlus - pMinus) / (2 * h);
      // gentle fallback if something blew up
      if (!isFinite(g[k])) g[k] = 0;
    }
    // ensure base is sane too (useful for callers)
    if (!isFinite(base)) throw new Error("finiteDiffGreeks: base price NaN/Inf");
    return g;
  }
  