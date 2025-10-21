/**
 * Fixed-Clip Ladder Pricing
 * 
 * Enforces invariant: r = h / s₀
 * Guarantees: One clip on both sides, each fill = one rung
 */

export interface LadderParams {
    h: number;      // Half-spread (price units)
    s0: number;     // Fixed clip size (lots)
    tick: number;   // Tick size
  }
  
  export interface LadderConfig {
    r: number;      // Cost per lot (derived from h/s₀)
  }
  
  /**
   * Compute ladder parameters from half-spread and clip size
   * Enforces: r = h / s₀ so that moving by h changes target by s₀
   */
  export function ladderParams(params: LadderParams): LadderConfig {
    const { h, s0 } = params;
    
    if (s0 <= 0) {
      throw new Error(`[ladderParams] Invalid clip size: ${s0}`);
    }
    
    const r = h / s0;  // Ladder invariant
    
    return { r };
  }
  
  /**
   * Validate ladder geometry
   */
  export function validateLadder(params: LadderParams, r: number): boolean {
    const expectedR = params.h / params.s0;
    const tolerance = 1e-10;
    
    return Math.abs(r - expectedR) < tolerance;
  }