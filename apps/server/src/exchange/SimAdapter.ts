// apps/server/src/exchange/SimAdapter.ts
/**
 * Phase 2 Week 1: Simulated exchange for paper trading
 * 
 * Features:
 * - Deterministic market data (seeded OU process)
 * - Realistic fill model (IOC against quotes)
 * - Configurable micro noise and slippage
 * - Shock injection for testing
 */

import { SeededRandom, createDeterministicRNG } from '../utils/numeric';

export type SimConfig = {
  initialF: number;          // Starting underlying price
  ouMean: number;            // Mean reversion level (often = initialF)
  ouTheta: number;           // Mean reversion speed (e.g. 0.1)
  ouSigma: number;           // Volatility of OU process (e.g. 0.02)
  tickMs: number;            // MD update interval (e.g. 100ms)
  
  // Fill model
  fillProbBase: number;      // Base fill probability (e.g. 0.1)
  fillProbSpreadDecay: number; // How fast prob decays with spread (e.g. 0.5)
  fillProbSizeDecay: number;   // How fast prob decays with size (e.g. 0.3)
  slippageBps: number;       // Expected slippage in bps (e.g. 1.0)
  
  // Shocks (optional)
  shockSchedule?: {
    timeMs: number;
    deltaF?: number;         // Underlying shock (e.g. +1%)
    deltaSkew?: number;      // Skew shock (e.g. +0.05)
  }[];
};

export type MarketData = {
  ts: number;
  F: number;                 // Underlying price
  atmIV: number;             // ATM implied vol
  skew: number;              // Skew parameter
  bid: number;               // Top of book bid (dummy for now)
  ask: number;               // Top of book ask (dummy for now)
};

export type Quote = {
  symbol: string;
  bid: number;
  ask: number;
  sizeBid: number;
  sizeAsk: number;
};

export type Fill = {
  ts: number;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  wasAggressive: boolean;    // True if we hit their quote
};

export type SimState = {
  currentTime: number;
  currentMD: MarketData;
  fills: Fill[];
};

export class SimAdapter {
  private config: SimConfig;
  private state: SimState;
  private rng: SeededRandom;
  
  // OU process state
  private F: number;
  private atmIV: number = 0.5;    // Start at 50% vol
  private skew: number = 0.0;     // Start neutral
  
  // Shock state
  private appliedShocks = new Set<number>();
  
  constructor(config: SimConfig, seed: number = 42) {
    this.config = config;
    this.rng = new SeededRandom(seed);
    this.F = config.initialF;
    
    const now = Date.now();
    this.state = {
      currentTime: now,
      currentMD: this.createMarketData(now),
      fills: [],
};
  }
  
  /**
   * Advance simulation by one tick
   * Returns new market data
   */
  tick(): MarketData {
    this.state.currentTime += this.config.tickMs;
    
    // Check for scheduled shocks
    this.applyShocks();
    
    // Evolve OU process: dF = θ(μ - F)dt + σ√dt·dW
    const dt = this.config.tickMs / 1000; // Convert to seconds
    const drift = this.config.ouTheta * (this.config.ouMean - this.F) * dt;
    const diffusion = this.config.ouSigma * Math.sqrt(dt) * this.rng.nextGaussian();
    
    this.F += drift + diffusion;
    
    // ATM vol mean-reverts slowly (optional: make configurable)
    const volDrift = 0.05 * (0.5 - this.atmIV) * dt;
    const volDiffusion = 0.1 * Math.sqrt(dt) * this.rng.nextGaussian();
    this.atmIV = Math.max(0.1, this.atmIV + volDrift + volDiffusion);
    
    // Skew mean-reverts to zero (optional)
    const skewDrift = 0.1 * (0.0 - this.skew) * dt;
    const skewDiffusion = 0.05 * Math.sqrt(dt) * this.rng.nextGaussian();
    this.skew += skewDrift + skewDiffusion;
    
    this.state.currentMD = this.createMarketData(this.state.currentTime);
    return this.state.currentMD;
  }
  
  private createMarketData(ts: number): MarketData {
    // Simple bid/ask spread (dummy - replace with actual order book if needed)
    const spread = this.F * 0.0005; // 5 bps
    
    return {
      ts,
      F: this.F,
      atmIV: this.atmIV,
      skew: this.skew,
      bid: this.F - spread / 2,
      ask: this.F + spread / 2,
    };
  }
  
  private applyShocks(): void {
    if (!this.config.shockSchedule) return;
    
    for (const shock of this.config.shockSchedule) {
      if (this.state.currentTime >= shock.timeMs && !this.appliedShocks.has(shock.timeMs)) {
        if (shock.deltaF !== undefined) {
          this.F *= (1 + shock.deltaF);
          console.log(`[SimAdapter] Applied F shock: ${(shock.deltaF * 100).toFixed(2)}% at t=${shock.timeMs}`);
        }
        if (shock.deltaSkew !== undefined) {
          this.skew += shock.deltaSkew;
          console.log(`[SimAdapter] Applied skew shock: ${shock.deltaSkew.toFixed(3)} at t=${shock.timeMs}`);
        }
        this.appliedShocks.add(shock.timeMs);
      }
    }
  }
  
  /**
   * Try to fill against our quotes (IOC)
   * Returns fills that occurred
   * 
   * Fill model:
   * - Probability decays with (spread / typical_spread) and (size / typical_size)
   * - Deterministic given timestamp + symbol (for reproducibility)
   */
  tryFill(quotes: Quote[]): Fill[] {
    const fills: Fill[] = [];
    
    for (const quote of quotes) {
      // Deterministic RNG per quote
      const quoteRNG = createDeterministicRNG(this.state.currentTime, quote.symbol);
      
      // Compute fill probabilities
      const spread = quote.ask - quote.bid;
      const midSize = (quote.sizeBid + quote.sizeAsk) / 2;
      
      // Normalize spread (assuming typical spread is ~0.1% of underlying)
      const typicalSpread = this.F * 0.001;
      const spreadRatio = spread / typicalSpread;
      
      // Probability decays exponentially with spread and size
      const probBid = this.config.fillProbBase * 
        Math.exp(-this.config.fillProbSpreadDecay * spreadRatio) *
        Math.exp(-this.config.fillProbSizeDecay * Math.log(1 + quote.sizeBid));
      
      const probAsk = this.config.fillProbBase * 
        Math.exp(-this.config.fillProbSpreadDecay * spreadRatio) *
        Math.exp(-this.config.fillProbSizeDecay * Math.log(1 + quote.sizeAsk));
      
      // Try bid fill
      if (quoteRNG.next() < probBid && quote.sizeBid > 0) {
        const slippage = this.F * (this.config.slippageBps / 10000) * quoteRNG.nextGaussian();
        const fillPrice = quote.bid + slippage;
        
        fills.push({
          ts: this.state.currentTime,
          symbol: quote.symbol,
          side: 'buy',
          qty: quote.sizeBid,
          price: fillPrice,
          wasAggressive: false,
        });
      }
      
      // Try ask fill
      if (quoteRNG.next() < probAsk && quote.sizeAsk > 0) {
        const slippage = this.F * (this.config.slippageBps / 10000) * quoteRNG.nextGaussian();
        const fillPrice = quote.ask - slippage;
        
        fills.push({
          ts: this.state.currentTime,
          symbol: quote.symbol,
          side: 'sell',
          qty: quote.sizeAsk,
          price: fillPrice,
          wasAggressive: false,
        });
      }
    }
    
    this.state.fills.push(...fills);
    return fills;
  }
  
  /**
   * Get current market data
   */
  getCurrentMD(): MarketData {
    return { ...this.state.currentMD };
  }
  
  /**
   * Get current simulation time
   */
  getCurrentTime(): number {
    return this.state.currentTime;
  }
  
  /**
   * Get all fills so far
   */
  getAllFills(): Fill[] {
    return [...this.state.fills];
  }
  
  /**
   * Reset simulation
   */
  reset(seed?: number): void {
    if (seed !== undefined) {
      this.rng = new SeededRandom(seed);
    }
    
    this.F = this.config.initialF;
    this.atmIV = 0.5;
    this.skew = 0.0;
    this.appliedShocks.clear();
    
    const now = Date.now();
    this.state = {
      currentTime: now,
      currentMD: this.createMarketData(now),
      fills: [],
};
  }
  
  /**
   * Inject a shock (for testing)
   */
  injectShock(deltaF?: number, deltaSkew?: number): void {
    if (deltaF !== undefined) {
      this.F *= (1 + deltaF);
      console.log(`[SimAdapter] Manual F shock: ${(deltaF * 100).toFixed(2)}%`);
    }
    if (deltaSkew !== undefined) {
      this.skew += deltaSkew;
      console.log(`[SimAdapter] Manual skew shock: ${deltaSkew.toFixed(3)}`);
    }
  }
}

/**
 * Example usage:
 * 
 * const sim = new SimAdapter({
 *   initialF: 50000,
 *   ouMean: 50000,
 *   ouTheta: 0.1,
 *   ouSigma: 0.02,
 *   tickMs: 100,
 *   fillProbBase: 0.1,
 *   fillProbSpreadDecay: 0.5,
 *   fillProbSizeDecay: 0.3,
 *   slippageBps: 1.0,
 *   shockSchedule: [
 *     { timeMs: Date.now() + 60000, deltaF: 0.01 },  // +1% after 1 min
 *   ],
 * }, 42);
 * 
 * // Main loop
 * setInterval(() => {
 *   const md = sim.tick();
 *   
 *   // Generate quotes from your QuoteEngine
 *   const quotes = quoteEngine.computeQuotes(md);
 *   
 *   // Try to fill
 *   const fills = sim.tryFill(quotes);
 *   
 *   // Process fills
 *   for (const fill of fills) {
 *     inventory.update(fill);
 *     logTrade(fill);
 *   }
 * }, 100);
 */