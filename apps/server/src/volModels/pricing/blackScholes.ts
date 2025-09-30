/**
 * Black-Scholes Pricing Engine
 * Handles option pricing and Greeks calculation
 */

/**
 * Cumulative normal distribution
 */
function normCdf(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    
    const sign = x >= 0 ? 1 : -1;
    const absX = Math.abs(x) / Math.sqrt(2.0);
    
    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    
    return 0.5 * (1.0 + sign * y);
  }
  
  /**
   * Normal PDF
   */
  function normPdf(x: number): number {
    return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  }
  
  export interface OptionInputs {
    strike: number;
    spot: number;
    vol: number;      // Annualized volatility
    T: number;        // Time to expiry in years
    r: number;        // Risk-free rate
    isCall: boolean;
  }
  
  export interface OptionGreeks {
    price: number;
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
    rho: number;
  }
  
  /**
   * Calculate Black-Scholes price and Greeks
   */
  export function blackScholes(inputs: OptionInputs): OptionGreeks {
    const { strike, spot, vol, T, r, isCall } = inputs;
    
    // Handle edge cases
    if (T <= 0) {
      const intrinsic = isCall ? 
        Math.max(spot - strike, 0) : 
        Math.max(strike - spot, 0);
      
      return {
        price: intrinsic,
        delta: intrinsic > 0 ? (isCall ? 1 : -1) : 0,
        gamma: 0,
        vega: 0,
        theta: 0,
        rho: 0
      };
    }
    
    // Calculate d1 and d2
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * T) / (vol * sqrtT);
    const d2 = d1 - vol * sqrtT;
    
    // Calculate price
    const Nd1 = normCdf(d1);
    const Nd2 = normCdf(d2);
    const Nminusd1 = normCdf(-d1);
    const Nminusd2 = normCdf(-d2);
    
    const discountFactor = Math.exp(-r * T);
    
    let price: number;
    let delta: number;
    
    if (isCall) {
      price = spot * Nd1 - strike * discountFactor * Nd2;
      delta = Nd1;
    } else {
      price = strike * discountFactor * Nminusd2 - spot * Nminusd1;
      delta = -Nminusd1;
    }
    
    // Calculate common Greeks
    const nd1 = normPdf(d1);
    const gamma = nd1 / (spot * vol * sqrtT);
    const vega = spot * nd1 * sqrtT / 100; // Divide by 100 for 1% vol move
    
    // Calculate theta (per day)
    let theta: number;
    if (isCall) {
      theta = (-spot * nd1 * vol / (2 * sqrtT) - r * strike * discountFactor * Nd2) / 365;
    } else {
      theta = (-spot * nd1 * vol / (2 * sqrtT) + r * strike * discountFactor * Nminusd2) / 365;
    }
    
    // Calculate rho (per 1% rate move)
    const rho = isCall ? 
      strike * T * discountFactor * Nd2 / 100 :
      -strike * T * discountFactor * Nminusd2 / 100;
    
    return {
      price,
      delta,
      gamma,
      vega,
      theta,
      rho
    };
  }
  
  /**
   * Calculate implied volatility from price using Newton-Raphson
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
    // Initial guess using Brenner-Subrahmanyam approximation
    let vol = Math.sqrt(2 * Math.PI / T) * (price / spot);
    
    // Bounds
    const minVol = 0.001;
    const maxVol = 5.0;
    
    vol = Math.max(minVol, Math.min(maxVol, vol));
    
    for (let i = 0; i < maxIterations; i++) {
      const result = blackScholes({
        strike,
        spot,
        vol,
        T,
        r,
        isCall
      });
      
      const priceDiff = result.price - price;
      
      // Check convergence
      if (Math.abs(priceDiff) < tolerance) {
        return vol;
      }
      
      // Newton-Raphson update
      const vega = result.vega * 100; // Adjust vega scaling
      
      if (Math.abs(vega) < 1e-8) {
        return null; // Vega too small, can't converge
      }
      
      vol = vol - priceDiff / vega;
      
      // Keep within bounds
      vol = Math.max(minVol, Math.min(maxVol, vol));
    }
    
    return null; // Failed to converge
  }
  
  /**
   * Convert price to implied vol, or vol to price
   */
  export class PriceVolConverter {
    /**
     * Convert variance to Black-Scholes implied vol
     */
    static varianceToIV(variance: number, T: number): number {
      if (T <= 0) return 0;
      return Math.sqrt(variance / T);
    }
    
    /**
     * Convert implied vol to total variance
     */
    static ivToVariance(iv: number, T: number): number {
      return iv * iv * T;
    }
    
    /**
     * Price option from total variance
     */
    static priceFromVariance(
      variance: number,
      strike: number,
      spot: number,
      T: number,
      r: number,
      isCall: boolean
    ): number {
      const iv = this.varianceToIV(variance, T);
      
      const result = blackScholes({
        strike,
        spot,
        vol: iv,
        T,
        r,
        isCall
      });
      
      return result.price;
    }
  }
  
  /**
   * Calculate delta in various conventions
   */
  export class DeltaConventions {
    /**
     * Get spot delta (standard BS delta)
     */
    static spotDelta(inputs: OptionInputs): number {
      const result = blackScholes(inputs);
      return result.delta;
    }
    
    /**
     * Get forward delta (excluding spot move effect)
     */
    static forwardDelta(inputs: OptionInputs): number {
      const spotDelta = this.spotDelta(inputs);
      const df = Math.exp(-inputs.r * inputs.T);
      return spotDelta / df;
    }
    
    /**
     * Get simple moneyness delta (for bucketing)
     */
    static simplicDelta(inputs: OptionInputs): number {
      return Math.abs(this.spotDelta(inputs));
    }
    
    /**
     * Map strike to delta bucket
     */
    static strikeToBucket(
      strike: number,
      spot: number,
      vol: number,
      T: number,
      r: number = 0
    ): string {
      // Always use put delta for consistency
      const delta = Math.abs(this.spotDelta({
        strike,
        spot,
        vol,
        T,
        r,
        isCall: false
      }));
      
      // Standard buckets
      if (delta >= 0.45 && delta <= 0.55) return 'atm';
      if (delta >= 0.20 && delta <= 0.30) return 'rr25';
      if (delta >= 0.08 && delta <= 0.12) return 'rr10';
      return 'wings';
    }
  }
  
  /**
   * Test the pricing engine
   */
  export function testPricing(): void {
    console.log('Testing Black-Scholes Pricing...\n');
    
    // Test ATM option
    const atmInputs: OptionInputs = {
      strike: 100,
      spot: 100,
      vol: 0.3,
      T: 0.25,
      r: 0.05,
      isCall: true
    };
    
    const atmResult = blackScholes(atmInputs);
    console.log('ATM Call (S=K=100, vol=30%, T=3M):');
    console.log(`  Price: ${atmResult.price.toFixed(2)}`);
    console.log(`  Delta: ${atmResult.delta.toFixed(3)}`);
    console.log(`  Gamma: ${atmResult.gamma.toFixed(4)}`);
    console.log(`  Vega:  ${atmResult.vega.toFixed(2)}`);
    
    // Test OTM put
    const otmInputs: OptionInputs = {
      strike: 90,
      spot: 100,
      vol: 0.3,
      T: 0.25,
      r: 0.05,
      isCall: false
    };
    
    const otmResult = blackScholes(otmInputs);
    console.log('\nOTM Put (S=100, K=90, vol=30%, T=3M):');
    console.log(`  Price: ${otmResult.price.toFixed(2)}`);
    console.log(`  Delta: ${otmResult.delta.toFixed(3)}`);
    console.log(`  Bucket: ${DeltaConventions.strikeToBucket(90, 100, 0.3, 0.25)}`);
    
    // Test implied vol
    const targetPrice = 5.0;
    const iv = impliedVol(targetPrice, 100, 100, 0.25, 0.05, true);
    console.log(`\nImplied vol for price=${targetPrice}: ${iv ? (iv * 100).toFixed(1) + '%' : 'Failed'}`);
  }