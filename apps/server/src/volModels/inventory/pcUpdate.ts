/**
 * Continuous PC Update on Fills
 * 
 * PC moves proportionally to fill fraction, then nudges toward inventory target
 * Prevents jumps on partial fills while staying economically consistent
 */

export type FillSide = 'bid' | 'ask';

export interface PCUpdateParams {
  pc: number;              // Current PC before fill
  cc: number;              // Current CC (belief mid)
  r: number;               // Cost per lot
  Q: number;               // Position before fill
  side: FillSide;          // Which side filled
  price: number;           // Our quoted price that filled (bid or ask)
  postedSize: number;      // Size we showed on that side
  fillSize: number;        // Executed size at that price
  kTrade?: number;         // κ_trade ∈ (0,1], default 1 (full snap on full fill)
  gamma?: number;          // γ ≥ 1, default 1 (linear)
  alphaInv?: number;       // α_inv ∈ [0,0.3], default 0.1 (inventory target pull)
}

export interface PCUpdateResult {
  pcAfter: number;         // Updated PC
  QAfter: number;          // Updated position
  fraction: number;        // Fraction filled
  pcTradeStep: number;     // PC after trade anchor (before inventory nudge)
  pcTarget: number;        // Inventory-consistent target mid
}

/**
 * Update PC continuously based on fill
 * 
 * Two-step process:
 * 1. Move toward fill price proportional to fill fraction
 * 2. Nudge toward inventory-consistent target
 */
export function updatePCOnFill(params: PCUpdateParams): PCUpdateResult {
  const {
    pc,
    cc,
    r,
    Q,
    side,
    price,
    postedSize,
    fillSize,
    kTrade = 1.0,      // Full snap on full fill
    gamma = 1.0,       // Linear (use 1.5-2.0 to dampen small fills)
    alphaInv = 0.1     // Small inventory pull (0.05-0.15 typical)
  } = params;

  // ============================================================
  // 1. CLAMP AND COMPUTE FRACTION
  // ============================================================
  const s = Math.max(0, Math.min(fillSize, postedSize));
  const f = postedSize > 0 ? Math.min(1, s / postedSize) : 0;

  // ============================================================
  // 2. TRADE-ANCHOR MOVE (toward fill price)
  // ============================================================
  // PC₁ = PC + κ_trade · f^γ · (price - PC)
  const pc1 = pc + kTrade * Math.pow(f, gamma) * (price - pc);

  // ============================================================
  // 3. UPDATE POSITION
  // ============================================================
  const Qprime = side === 'bid' ? (Q + s) : (Q - s);

  // ============================================================
  // 4. INVENTORY-TARGET MOVE
  // ============================================================
  // PC_target = CC - r·Q'
  const pcTgt = cc - r * Qprime;
  
  // PC₂ = PC₁ + α_inv · (PC_target - PC₁)
  const pc2 = pc1 + alphaInv * (pcTgt - pc1);

  return {
    pcAfter: pc2,
    QAfter: Qprime,
    fraction: f,
    pcTradeStep: pc1,
    pcTarget: pcTgt
  };
}

/**
 * Stateful PC updater for handling multiple partials at same level
 */
export class PCUpdater {
  private remainingSize: Map<FillSide, number> = new Map();

  constructor() {
    this.remainingSize.set('bid', 0);
    this.remainingSize.set('ask', 0);
  }

  /**
   * Reset remaining size when reposting quotes
   */
  repost(bidSize: number, askSize: number): void {
    this.remainingSize.set('bid', bidSize);
    this.remainingSize.set('ask', askSize);
  }

  /**
   * Update PC on fill, tracking remaining size
   */
  onFill(params: PCUpdateParams): PCUpdateResult {
    const side = params.side;
    const rem = this.remainingSize.get(side) || params.postedSize;
    
    // Use remaining size for fraction calculation
    const adjustedParams = {
      ...params,
      postedSize: rem
    };
    
    const result = updatePCOnFill(adjustedParams);
    
    // Reduce remaining size
    const newRem = Math.max(0, rem - params.fillSize);
    this.remainingSize.set(side, newRem);
    
    return result;
  }
}