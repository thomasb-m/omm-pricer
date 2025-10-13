/**
 * Display vs Replenish Logic
 * 
 * Display: What market sees (always show clip for presence)
 * Replenish: What you actually refill (bounded by willingness/capacity)
 */

export interface DisplayReplenishInput {
    s0: number;              // Fixed clip size
    willingness: number;     // Economic willingness (lots)
    capacity: number;        // Capacity cap (lots)
    minDisplay: number;      // Minimum visibility (e.g., 1-5 lots)
    S_max: number;           // Hard cap
  }
  
  export interface DisplayReplenishOutput {
    display: number;         // Show to market
    replenish: number;       // Actually refill after fill
  }
  
  /**
   * Compute display and replenish sizes
   * 
   * Display: Always show clip (presence)
   * Replenish: Bounded by economics (willingness, capacity)
   */
  export function computeDisplayReplenish(
    input: DisplayReplenishInput
  ): DisplayReplenishOutput {
    const { s0, willingness, capacity, minDisplay, S_max } = input;
    
    // Display: Always show the clip (with minimum floor)
    const display = Math.max(minDisplay, s0);
    
    // Replenish: Bounded by economics
    const replenish = Math.floor(
      Math.max(0, Math.min(s0, willingness, capacity, S_max))
    );
    
    return { display, replenish };
  }