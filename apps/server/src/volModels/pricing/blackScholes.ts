/**
 * Black-Scholes Pricing Engine
 * Handles option pricing and Greeks calculation
 * Conventions:
 *  - Vega: per absolute vol unit (1.0 = 100% vol)
 *  - Theta: per year (no /365 here; divide at display time if needed)
 *  - Rho: per 1% rate move (kept for compatibility)
 */

function normCdf(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
  
    const sign = x >= 0 ? 1 : -1;
    const absX = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * absX);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return 0.5 * (1 + sign * y);
  }
  
  function normPdf(x: number): number {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }
  
  export interface OptionInputs {
    strike: number;
    spot: number;
    vol: number;   // annualized volatility (decimal)
    T: number;     // time to expiry in years
    r: number;     // risk-free rate (decimal)
    isCall: boolean;
  }
  
  export interface OptionGreeks {
    price: number;
    delta: number;
    gamma: number;
    vega: number;   // per absolute vol
    theta: number;  // per year
    rho: number;    // per 1% rate move
  }
  
  export function blackScholes(inputs: OptionInputs): OptionGreeks {
    const { strike, spot, vol, T, r, isCall } = inputs;
  
    if (T <= 0) {
      const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
      return { price: intrinsic, delta: intrinsic > 0 ? (isCall ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
    }
  
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * T) / (vol * sqrtT);
    const d2 = d1 - vol * sqrtT;
  
    const Nd1 = normCdf(d1);
    const Nd2 = normCdf(d2);
    const Nmd1 = normCdf(-d1);
    const Nmd2 = normCdf(-d2);
  
    const df = Math.exp(-r * T);
  
    let price: number;
    let delta: number;
  
    if (isCall) {
      price = spot * Nd1 - strike * df * Nd2;
      delta = Nd1;
    } else {
      price = strike * df * Nmd2 - spot * Nmd1;
      delta = -Nmd1;
    }
  
    const nd1 = normPdf(d1);
    const gamma = nd1 / (spot * vol * sqrtT);
  
    // ✅ Vega per absolute vol unit
    const vega = spot * nd1 * sqrtT;
  
    // ✅ Theta per YEAR (no /365)
    let theta: number;
    if (isCall) {
      theta = -spot * nd1 * vol / (2 * sqrtT) - r * strike * df * Nd2;
    } else {
      theta = -spot * nd1 * vol / (2 * sqrtT) + r * strike * df * Nmd2;
    }
  
    // Rho per 1% rate move (kept)
    const rho = isCall ? (strike * T * df * Nd2) / 100 : (-strike * T * df * Nmd2) / 100;
  
    return { price, delta, gamma, vega, theta, rho };
  }
  
  /**
   * Newton solver for BS implied vol
   * Assumes vega is per absolute vol (no 100x scaling).
   */
  export function impliedVol(
    price: number,
    strike: number,
    spot: number,
    T: number,
    r: number,
    isCall: boolean,
    maxIterations: number = 50,
    tolerance: number = 1e-6
  ): number | null {
    let vol = Math.sqrt(2 * Math.PI / Math.max(T, 1e-12)) * Math.max(price, 1e-12) / Math.max(spot, 1e-12);
    vol = Math.max(0.001, Math.min(5.0, vol));
  
    for (let i = 0; i < maxIterations; i++) {
      const res = blackScholes({ strike, spot, vol, T, r, isCall });
      const diff = res.price - price;
      if (Math.abs(diff) < tolerance) return vol;
  
      const vega = res.vega; // ✅ already per absolute vol
      if (Math.abs(vega) < 1e-10) return null;
  
      vol = Math.max(0.001, Math.min(5.0, vol - diff / vega));
    }
    return null;
  }
  
  export class PriceVolConverter {
    static varianceToIV(variance: number, T: number): number {
      if (T <= 0) return 0;
      return Math.sqrt(variance / T);
    }
    static ivToVariance(iv: number, T: number): number {
      return iv * iv * T;
    }
    static priceFromVariance(
      variance: number,
      strike: number,
      spot: number,
      T: number,
      r: number,
      isCall: boolean
    ): number {
      const iv = this.varianceToIV(variance, T);
      return blackScholes({ strike, spot, vol: iv, T, r, isCall }).price;
    }
  }
  
  export class DeltaConventions {
    static spotDelta(inputs: OptionInputs): number {
      return blackScholes(inputs).delta;
    }
    static forwardDelta(inputs: OptionInputs): number {
      const df = Math.exp(-inputs.r * inputs.T);
      return this.spotDelta(inputs) / df;
    }
    // 🔤 rename: simplicDelta -> simpleDelta
    static simpleDelta(inputs: OptionInputs): number {
      return Math.abs(this.spotDelta(inputs));
    }
    static strikeToBucket(
      strike: number,
      spot: number,
      vol: number,
      T: number,
      r: number = 0
    ): string {
      const delta = Math.abs(this.spotDelta({ strike, spot, vol, T, r, isCall: false })); // put-delta convention
      if (delta >= 0.45 && delta <= 0.55) return 'atm';
      if (delta >= 0.20 && delta <= 0.30) return 'rr25';
      if (delta >= 0.08 && delta <= 0.12) return 'rr10';
      return 'wings';
    }
  }
  