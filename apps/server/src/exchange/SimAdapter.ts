// apps/server/src/exchange/SimAdapter.ts
/**
 * SimAdapter: Simulates exchange behavior for testing
 * 
 * Responsibilities:
 * - Generate synthetic market data (F, IV, skew)
 * - Simulate fills based on quotes
 * - Prevent dust fills (< minFillQty)
 */

import { SimConfig } from '../config/featureFlags';

export interface MarketData {
  ts: number;
  F: number;      // Forward price
  atmIV: number;  // ATM implied volatility
  skew: number;   // Volatility skew
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  sizeBid: number;
  sizeAsk: number;
}

export interface Fill {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
}

export class SimAdapter {
  private tickCount = 0;
  private rng: () => number;
  
  constructor(
    private config: SimConfig,
    seed?: number
  ) {
    // Simple seeded RNG for reproducibility
    let s = seed ?? Math.floor(Math.random() * 1e9);
    this.rng = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }
  
  /**
   * Generate next market data point
   */
  tick(): MarketData {
    this.tickCount++;
    
    // Simulate mean-reverting forward price
    const F = 50000 + Math.sin(this.tickCount / 10) * 100 + (this.rng() - 0.5) * 50;
    
    // Simulate mean-reverting IV
    const atmIV = 0.10 + Math.sin(this.tickCount / 7) * 0.04 + (this.rng() - 0.5) * 0.01;
    
    // Simulate mean-reverting skew
    const skew = -0.05 + Math.sin(this.tickCount / 5) * 0.08 + (this.rng() - 0.5) * 0.02;
    
    return {
      ts: Date.now() + this.tickCount * 1000,
      F,
      atmIV,
      skew,
    };
  }
  
  /**
   * Simulate fills based on quotes
   * 
   * NEW: Filters out dust fills (< minFillQty)
   */
  tryFill(quotes: Quote[]): Fill[] {
    const fills: Fill[] = [];
    
    for (const quote of quotes) {
      // Random chance to fill
      if (this.rng() > this.config.fillProbability) {
        continue;
      }
      
      // Random side
      const side = this.rng() < 0.5 ? 'buy' : 'sell';
      
      // Random quantity from available size
      const maxSize = side === 'buy' ? quote.sizeAsk : quote.sizeBid;
      const fillQty = maxSize * (0.1 + this.rng() * 0.9); // 10-100% of size
      
      // ================================================================
      // 🚨 FIX: Prevent dust fills
      // ================================================================
      if (fillQty < this.config.minFillQty) {
        continue; // Skip fills smaller than minimum
      }
      
      // Fill at quoted price
      const price = side === 'buy' ? quote.ask : quote.bid;
      
      fills.push({
        symbol: quote.symbol,
        side,
        qty: fillQty,
        price,
      });
    }
    
    return fills;
  }
  
  /**
   * Reset simulation state
   */
  reset(seed?: number): void {
    this.tickCount = 0;
    if (seed !== undefined) {
      let s = seed;
      this.rng = () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
      };
    }
  }
}