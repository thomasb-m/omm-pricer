/**
 * Target Curve Pricing - Production Ready
 * 
 * Core principle: Q*(P) = -(P - CC) / r
 * Your target inventory at price P is determined by your belief (CC) and cost per lot (r)
 * 
 * Sizes are determined by willingness: how much you need to trade to reach target
 */

export interface TargetCurvePricingInput {
    ccMid: number;              // Belief mid (Core Curve) - never changes on trades
    pcMid: number;              // Anchor mid (last fill price, or CC if no fills)
    currentPosition: number;    // Current position (lots, + = long, - = short)
    costPerLot: number;         // Cost per lot: r = g^T Λ Σ g (in price units)
    minTick: number;            // Exchange tick size
    halfSpread: number;         // Half-spread (market convention, fixed)
    policySize: number;         // Policy size per side (e.g., 100 lots)
    maxSize?: number;           // Hard cap (optional, default 1e9)
    alpha?: number;             // PC gravity factor (0 = fills only, default 0)
  }
  
  export interface TargetCurvePricingOutput {
    bid: number;
    ask: number;
    bidSize: number;         // Display size
    askSize: number;         // Display size
    replenishBid: number;    // ✅ ADD: Economic replenish
    replenishAsk: number;    // ✅ ADD: Economic replenish
    pcMid: number;
    edge: number;
    diagnostics: {
      targetAtBid: number;
      targetAtAsk: number;
      willingnessBid: number;
      willingnessAsk: number;
      capacityBid: number;
      capacityAsk: number;
      currentPosition: number;
      costPerLot: number;
    };
  }
  
  /**
   * Compute target curve quote
   * 
   * Algorithm:
   * 1. Center on PC mid (last trade)
   * 2. Compute target positions: Q*(P) = -(P - CC) / r
   * 3. Compute willingness: how much to trade to reach target
   * 4. Apply caps: min(policy, capacity, willingness, max)
   */
  export function computeTargetCurvePricing(
    input: TargetCurvePricingInput
  ): TargetCurvePricingOutput {
    const {
      ccMid,
      pcMid,
      currentPosition,
      costPerLot,
      minTick,
      halfSpread,
      policySize,
      maxSize = 1e9,
      alpha = 0  // No gravity by default (fills only)
    } = input;
  
    // ============================================================
    // 1. VALIDATION
    // ============================================================
    if (!Number.isFinite(ccMid) || !Number.isFinite(pcMid) || !Number.isFinite(costPerLot)) {
      throw new Error(
        `[computeTargetCurvePricing] Invalid inputs: ` +
        `ccMid=${ccMid}, pcMid=${pcMid}, costPerLot=${costPerLot}`
      );
    }
  
    if (costPerLot <= 0) {
      throw new Error(
        `[computeTargetCurvePricing] Invalid costPerLot: ${costPerLot} (must be > 0)`
      );
    }
  
    if (minTick <= 0) {
      throw new Error(
        `[computeTargetCurvePricing] Invalid minTick: ${minTick} (must be > 0)`
      );
    }
  
    // ============================================================
    // 2. OPTIONAL PC GRAVITY (disabled by default)
    // ============================================================
    // PC can drift toward target between trades
    // PC_target = CC - r * Q
    // pc_out = (1 - alpha) * pc + alpha * PC_target
    const pcTarget = ccMid - costPerLot * currentPosition;
    const pcOut = (1 - alpha) * pcMid + alpha * pcTarget;
  
    // ============================================================
    // 3. COMPUTE BID/ASK PRICES (tick-safe)
    // ============================================================
    const bid = Math.floor((pcOut - halfSpread) / minTick) * minTick;
    const ask = Math.ceil((pcOut + halfSpread) / minTick) * minTick;
  
    // ============================================================
    // 4. COMPUTE TARGET POSITIONS: Q*(P) = -(P - CC) / r
    // ============================================================
    const targetAtBid = -(bid - ccMid) / costPerLot;
    const targetAtAsk = -(ask - ccMid) / costPerLot;
  
    // ============================================================
    // 5. COMPUTE WILLINGNESS (don't overshoot target)
    // ============================================================
    // Bid: How much can we BUY to reach target at bid?
    const willingnessBid = Math.max(0, targetAtBid - currentPosition);
    
    // Ask: How much can we SELL to reach target at ask?
    const willingnessAsk = Math.max(0, currentPosition - targetAtAsk);
  
    // ============================================================
    // 6. COMPUTE CAPACITY CAPS (edge / r)
    // ============================================================
    const capacityBid = Math.max(0, (ccMid - bid) / costPerLot);
    const capacityAsk = Math.max(0, (ask - ccMid) / costPerLot);
  
   // ============================================================
    // 7. DISPLAY VS REPLENISH
    // ============================================================
    // Display: Always show policy size for presence
    const displayBid = policySize;
    const displayAsk = policySize;
    
    // Replenish: Bounded by economics (willingness, capacity)
    const replenishBid = Math.floor(
      Math.max(0, Math.min(policySize, capacityBid, willingnessBid, maxSize))
    );
    const replenishAsk = Math.floor(
      Math.max(0, Math.min(policySize, capacityAsk, willingnessAsk, maxSize))
    );
  
    // ============================================================
    // 8. SANITY CHECKS
    // ============================================================
    if (bid >= ask) {
      console.warn(
        `[computeTargetCurvePricing] WARNING: bid >= ask`,
        { bid, ask, pcOut, halfSpread, minTick }
      );
    }
  
    if (displayBid < 0 || displayAsk < 0 || replenishBid < 0 || replenishAsk < 0) {
        console.warn(
          `[computeTargetCurvePricing] WARNING: negative size`,
          { displayBid, displayAsk, replenishBid, replenishAsk }
        );
      }
  
    // ============================================================
    // 9. RETURN RESULT
    // ============================================================
    const edge = pcOut - ccMid;
  
    return {
        bid,
        ask,
        bidSize: displayBid,        // ✅ Always show policy size
        askSize: displayAsk,        // ✅ Always show policy size
        replenishBid,               // ✅ Economic bound
        replenishAsk,               // ✅ Economic bound
        pcMid: pcOut,
        edge,
        diagnostics: {
          targetAtBid,
          targetAtAsk,
          willingnessBid,
          willingnessAsk,
          capacityBid,
          capacityAsk,
          currentPosition,
          costPerLot
        }
      };
  }