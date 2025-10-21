/**
 * Snapper - Book-Aware Quote Adjustment
 * 
 * Decides whether to:
 * - Join the touch (preserve queue priority)
 * - Step ahead 1 tick (capture flow when justified)
 * 
 * Gates: queue rank, toxicity, edge after fees, cooldown
 */

export type SnapperSide = 'bid' | 'ask';

export interface SnapperInput {
  // Model parameters
  side: SnapperSide;
  modelPrice: number;       // Target curve price (PC ± h)
  displayLots: number;      // What we want to show
  replenishLots: number;    // Economic bound
  
  // Market state
  bestPrice: number;        // Current touch price
  queueDepth?: number;      // Total size at touch (optional)
  ourPriorSize?: number;    // Our existing size at touch (optional)
  
  // Economics
  CC: number;               // Belief mid
  tick: number;             // Tick size
  makerFee: number;         // Maker fee (e.g., -0.00002 for rebate)
  
  // Signals
  alphaMicro: number;       // Micro-alpha signal [-1, +1]
  rvZ: number;              // Realized vol Z-score (0-1 = calm, >1 = stress)
  
  // Policy
  policy: 'join' | 'smart';
  stepFrac: number;         // Fraction of display to show when stepping (0.1-0.3)
  minStepLots: number;      // Minimum size to step with
  edgeStepMinTicks: number; // Minimum edge (in ticks) to justify step
  minNotional: number;      // Minimum notional to quote
  
  // State
  lastUpdateMs: number;     // Last time we updated this side
  nowMs: number;            // Current time
  cooldownMs: number;       // Minimum time between updates
}

export interface SnapperOutput {
  price: number;            // Final quote price
  displayLots: number;      // Final display size
  replenishLots: number;    // Final replenish size
  action: 'join' | 'step' | 'back_off' | 'skip';
  reason?: string;
}

/**
 * Snap quote to book with join/step-ahead logic
 */
export function snapToBook(input: SnapperInput): SnapperOutput {
  const {
    side,
    modelPrice,
    displayLots,
    replenishLots,
    bestPrice,
    queueDepth,
    ourPriorSize = 0,
    CC,
    tick,
    makerFee,
    alphaMicro,
    rvZ,
    policy,
    stepFrac,
    minStepLots,
    edgeStepMinTicks,
    minNotional,
    lastUpdateMs,
    nowMs,
    cooldownMs
  } = input;

  // ============================================================
  // 1. COOLDOWN CHECK
  // ============================================================
  const timeSinceUpdate = nowMs - lastUpdateMs;
  if (timeSinceUpdate < cooldownMs) {
    return {
      price: bestPrice,
      displayLots: 0,
      replenishLots: 0,
      action: 'skip',
      reason: 'cooldown'
    };
  }

  // ============================================================
  // 2. DEFAULT: JOIN THE TOUCH
  // ============================================================
  let price = side === 'bid' 
    ? Math.min(modelPrice, bestPrice)  // Never improve bid beyond model
    : Math.max(modelPrice, bestPrice); // Never improve ask beyond model
  
  let showLots = displayLots;
  let replLots = replenishLots;
  let action: SnapperOutput['action'] = 'join';

  // ============================================================
  // 3. COMPUTE EDGE AFTER FEES
  // ============================================================
  const edgeAtModel = side === 'bid'
    ? (CC - modelPrice - makerFee)
    : (modelPrice - CC - makerFee);
  
  const edgeAtModelTicks = edgeAtModel / tick;

  // ============================================================
  // 4. STEP-AHEAD DECISION (only if policy = 'smart')
  // ============================================================
  if (policy === 'smart') {
    // Compute queue rank (0 = front, 1 = back)
    const queueRank = queueDepth && queueDepth > 0
      ? Math.min(1, ourPriorSize / queueDepth)
      : 0.5; // Default: assume middle of queue

    // Check if alpha supports stepping on this side
    const alphaFavorsSide = side === 'bid' 
      ? alphaMicro > 0   // Positive alpha → expect upward move → aggressive bid
      : alphaMicro < 0;  // Negative alpha → expect downward move → aggressive ask

    // All conditions must be true to step ahead
    const canStep = (
      queueRank > 0.8 &&              // Poor queue position (back 20%)
      rvZ < 0.5 &&                     // Market is calm (not stressed)
      alphaFavorsSide &&               // Alpha signal supports this side
      displayLots >= minStepLots &&    // Have enough size to show
      edgeAtModelTicks >= edgeStepMinTicks // Model edge justifies it
    );

    if (canStep) {
      // Step ahead 1 tick with reduced size
      price = side === 'bid'
        ? Math.max(bestPrice + tick, modelPrice)  // Improve bid by 1 tick
        : Math.min(bestPrice - tick, modelPrice); // Improve ask by 1 tick

      showLots = Math.max(minStepLots, Math.floor(displayLots * stepFrac));
      replLots = Math.min(replenishLots, showLots);
      action = 'step';
    }
  }

  // ============================================================
  // 5. EDGE SAFETY: BACK OFF IF NEGATIVE EDGE
  // ============================================================
  const finalEdge = side === 'bid'
    ? (CC - price - makerFee)
    : (price - CC - makerFee);

  if (finalEdge < 0) {
    // Back off by 1 tick
    price = side === 'bid' ? price - tick : price + tick;
    showLots = Math.max(0, Math.floor(showLots / 2));
    replLots = Math.min(replLots, showLots);
    action = 'back_off';
  }

  // ============================================================
  // 6. NOTIONAL FLOOR
  // ============================================================
  if (price * showLots < minNotional) {
    return {
      price,
      displayLots: 0,
      replenishLots: 0,
      action: 'skip',
      reason: 'below_min_notional'
    };
  }

  // ============================================================
  // 7. RETURN FINAL QUOTE
  // ============================================================
  return {
    price,
    displayLots: showLots,
    replenishLots: replLots,
    action
  };
}