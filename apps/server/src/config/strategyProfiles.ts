/**
 * Strategy Profiles - Production Ready
 * 
 * Defines behavior for different instrument types:
 * - default: Standard ATM/near-money options
 * - otm_fly: Far OTM queue game with large clips
 * - stress: Defensive mode for high volatility
 */

export interface StrategyProfile {
    name: string;
    
    // Ladder params
    clip: number;                // Fixed clip size (s₀)
    halfSpread: number;          // h (in price units)
    minDisplay: number;          // Minimum visibility
    maxVisible: number;          // Cap at touch
    
    // Reserve (iceberg)
    reserveFactor: number;       // Off-touch reserve (× display)
    
    // Snapper
    policy: 'join' | 'smart';
    stepFrac: number;            // Fraction to show when stepping
    minStepLots: number;
    edgeStepMinTicks: number;
    cooldownMs: number;
    
    // PC dynamics
    pcGravityAlpha: number;      // Between-trade drift toward target
    
    // Risk
    maxNotional: number;
    maxDeltaPerSide: number;
    
    // Toxicity gates
    toxGateZ: number;
  }
  
  export const STRATEGY_PROFILES: Record<string, StrategyProfile> = {
    default: {
      name: 'default',
      
      // Ladder: 10-lot clips at 1 tick spread
      clip: 10,
      halfSpread: 0.0001,      // 1 tick for BTC
      minDisplay: 2,
      maxVisible: 50,
      
      // Reserve: minimal
      reserveFactor: 1,
      
      // Snapper: smart with guards
      policy: 'smart',
      stepFrac: 0.25,
      minStepLots: 3,
      edgeStepMinTicks: 0.3,
      cooldownMs: 100,
      
      // PC dynamics
      pcGravityAlpha: 0.1,
      
      // Risk
      maxNotional: 10.0,         // 10 BTC
      maxDeltaPerSide: 100,      // BTC
      
      // Tox
      toxGateZ: 2.0
    },
    
    otm_fly: {
      name: 'otm_fly',
      
      // Ladder: large clips at 1 tick
      clip: 1000,
      halfSpread: 0.0001,
      minDisplay: 50,
      maxVisible: 1000,
      
      // Reserve: large iceberg
      reserveFactor: 5,
      
      // Snapper: queue-first (join unless huge edge)
      policy: 'smart',
      stepFrac: 0.1,             // Only 10% when stepping
      minStepLots: 50,
      edgeStepMinTicks: 1.0,     // High threshold
      cooldownMs: 250,           // Slower updates
      
      // PC dynamics
      pcGravityAlpha: 0.05,      // Less gravity (more fill-driven)
      
      // Risk
      maxNotional: 100.0,
      maxDeltaPerSide: 1000,
      
      // Tox
      toxGateZ: 1.5              // More conservative
    },
    
    stress: {
      name: 'stress',
      
      // Ladder: smaller clips, wider spread
      clip: 5,
      halfSpread: 0.0002,        // 2 ticks
      minDisplay: 1,
      maxVisible: 20,
      
      // Reserve: minimal
      reserveFactor: 0.5,
      
      // Snapper: join only
      policy: 'join',
      stepFrac: 0,
      minStepLots: 0,
      edgeStepMinTicks: 999,
      cooldownMs: 500,           // Very slow
      
      // PC dynamics
      pcGravityAlpha: 0.15,      // More gravity (faster mean revert)
      
      // Risk: tighter
      maxNotional: 2.0,
      maxDeltaPerSide: 20,
      
      // Tox
      toxGateZ: 0.5              // Very defensive
    }
  };
  
  /**
   * Select profile based on instrument characteristics
   */
  export function selectProfile(params: {
    strike: number;
    forward: number;
    T: number;
    iv: number;
    rvZ?: number;
  }): StrategyProfile {
    const { strike, forward, T, rvZ = 0 } = params;
    
    // Stress mode override
    if (rvZ > 2.0) {
      return STRATEGY_PROFILES.stress;
    }
    
    const moneyness = strike / forward;
    const isFarOTM = moneyness < 0.85 || moneyness > 1.15;
    const isShortDated = T < 0.02; // < 7 days
    
    // Far OTM with time → fly game
    if (isFarOTM && !isShortDated) {
      return STRATEGY_PROFILES.otm_fly;
    }
    
    // Near money → default
    return STRATEGY_PROFILES.default;
  }
  
  /**
   * Get profile by name (with fallback)
   */
  export function getProfile(name: string): StrategyProfile {
    return STRATEGY_PROFILES[name] || STRATEGY_PROFILES.default;
  }