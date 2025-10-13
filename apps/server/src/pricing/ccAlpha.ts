/**
 * CC Micro-Alpha - Tiny Directional Nudge
 * 
 * Adds small, clipped adjustment to CC based on:
 * - Order flow imbalance (OFI)
 * - Microprice imbalance
 * 
 * Goal: Push fill edge from ~0 to positive
 */

export interface CCAlphaInput {
    bid: number;
    ask: number;
    depthBid?: number;      // Size at best bid
    depthAsk?: number;      // Size at best ask
    ofiZ?: number;          // Order flow imbalance Z-score (optional)
    k?: number;             // Scaling factor (default 0.05)
    maxClipTicks?: number;  // Max nudge in ticks (default 0.5)
    rvZ?: number;           // Realized vol Z-score (reduce in stress)
  }
  
  export interface CCAlphaOutput {
    deltaTicks: number;     // Adjustment in ticks
    deltaPrice: number;     // Adjustment in price units
    signal: number;         // Raw signal before clipping
  }
  
  /**
   * Compute CC micro-alpha nudge
   * 
   * Returns small adjustment to add to CC:
   * CC_adjusted = CC + deltaPrice
   */
  export function computeCCAlpha(input: CCAlphaInput): CCAlphaOutput {
    const {
      bid,
      ask,
      depthBid = 100,
      depthAsk = 100,
      ofiZ = 0,
      k = 0.05,
      maxClipTicks = 0.5,
      rvZ = 0
    } = input;
  
    const spread = ask - bid;
    if (spread <= 0) {
      return { deltaTicks: 0, deltaPrice: 0, signal: 0 };
    }
  
    // ============================================================
    // 1. MICROPRICE IMBALANCE
    // ============================================================
    // Microprice = weighted average of bid/ask by depth
    // If ask side is deeper → microprice closer to ask → bearish
    const mid = (bid + ask) / 2;
    const totalDepth = depthBid + depthAsk;
    
    const microprice = totalDepth > 0
      ? (ask * depthBid + bid * depthAsk) / totalDepth
      : mid;
  
    // Imbalance in spread units [-1, +1]
    const microImbalanceZ = (microprice - mid) / (spread / 2);
  
    // ============================================================
    // 2. BLEND WITH OFI
    // ============================================================
    // Simple blend: average of micro imbalance and OFI
    const alphaRaw = (microImbalanceZ + ofiZ) / 2;
  
    // ============================================================
    // 3. REGIME GATING (reduce in stress)
    // ============================================================
    const regimeScale = rvZ > 1.0 ? 0.5 : 1.0;  // Half the signal if stressed
  
    // ============================================================
    // 4. CLIP TO MAX TICKS
    // ============================================================
    const signal = alphaRaw * regimeScale;
    const deltaTicks = Math.max(
      -maxClipTicks,
      Math.min(maxClipTicks, k * signal)
    );
  
    const deltaPrice = deltaTicks * spread;
  
    return {
      deltaTicks,
      deltaPrice,
      signal: alphaRaw
    };
  }
  
  /**
   * Simple OFI calculator (for testing)
   * In production, use rolling window of trades
   */
  export function computeSimpleOFI(trades: Array<{price: number; size: number; time: number}>): number {
    if (trades.length === 0) return 0;
  
    let buyVolume = 0;
    let sellVolume = 0;
  
    // Classify trades by price movement
    for (let i = 1; i < trades.length; i++) {
      const priceChange = trades[i].price - trades[i-1].price;
      
      if (priceChange > 0) {
        buyVolume += trades[i].size;
      } else if (priceChange < 0) {
        sellVolume += trades[i].size;
      }
    }
  
    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return 0;
  
    // Imbalance: +1 = all buys, -1 = all sells
    return (buyVolume - sellVolume) / totalVolume;
  }