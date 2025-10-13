/**
 * Unified Inventory-Aware Pricing
 * 
 * Philosophy: Edge from inventory pressure IS the spread driver.
 * No independent width calculations - everything flows from risk.
 * 
 * Core equation: e = g^T (Λ Σ I)
 * Where:
 *   g = factor greeks for this instrument
 *   Λ = diag(lambda) - cost per factor unit
 *   Σ = factor covariance matrix
 *   I = current factor inventory
 */

export type CenterMode = "cc" | "shifted";

export interface InventoryPricingInput {
  ccMid: number;                    // Clean mid from CC surface
  factorGreeks_g: number[];         // Instrument factor greeks [L0, S0, C0, Sneg, Spos, F]
  inventory_I: number[];            // Current factor inventory
  lambda: number[];                 // Per-factor cost (>= 0)
  covariance_Sigma: number[][];     // F x F covariance matrix (PSD)
  
  // Market microstructure
  quoteSize: number;                // In contracts (will scale to vega internally)
  gamma: number;                    // Instrument gamma for convexity penalty
  vega: number;                     // Instrument vega for size scaling
  marketLiquidity: number;          // 0..1 (1 = very liquid, 0 = illiquid)
  
  // Config
  minTick: number;                  // Exchange tick size
  baseHalfSpread?: number;          // Minimum half-spread (default: minTick)
  centerMode?: CenterMode;          // "cc" = center on CC, "shifted" = allow drift
  
  // Advanced (optional)
  betaSelf?: number;                // Self-impact coefficient for mid shift
  edgeCap?: number;                 // Cap on |edge| for safety
  maxHalfSpread?: number;           // Maximum half-spread guard
}

export interface InventoryPricingOutput {
  bid: number;
  ask: number;
  halfSpread: number;
  midUsed: number;
  edgeScalar: number;               // g^T (Λ Σ I) - directional edge
  diagnostics: {
    liqSoftener: number;
    sizeScale: number;
    gammaBump: number;
    inventoryTerm: number;
    midImpact: number;
    edgeCapped: boolean;
    spreadCapped: boolean;
  };
}

/**
 * Compute edge scalar: e = g^T (Λ Σ I)
 * This is the directional inventory pressure
 */
function computeEdgeScalar(
  g: number[],
  lambda: number[],
  Sigma: number[][],
  I: number[]
): number {
  const n = g.length;
  
  // Step 1: Compute Σ I
  const SigmaI = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      SigmaI[i] += Sigma[i][j] * I[j];
    }
  }
  
  // Step 2: Apply diagonal Λ: Λ Σ I
  const LambdaSigmaI = SigmaI.map((v, i) => lambda[i] * v);
  
  // Step 3: Dot product: g^T (Λ Σ I)
  let edge = 0;
  for (let i = 0; i < n; i++) {
    edge += g[i] * LambdaSigmaI[i];
  }
  
  return edge;
}

/**
 * Utility: clamp value between min and max
 */
function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/**
 * Main pricing function: compute inventory-aware bid/ask
 */
export function computeInventoryAwarePricing(
  input: InventoryPricingInput
): InventoryPricingOutput {
  const {
    ccMid,
    factorGreeks_g: g,
    inventory_I: I,
    lambda,
    covariance_Sigma: Sigma,
    quoteSize,
    gamma,
    vega,
    marketLiquidity,
    minTick,
    baseHalfSpread = minTick,
    centerMode = "cc",
    betaSelf = 0,
    edgeCap = Infinity,
    maxHalfSpread = Infinity
  } = input;

  // ============================================================
  // 1. COMPUTE INVENTORY EDGE (scalar)
  // ============================================================
  const rawEdge = computeEdgeScalar(g, lambda, Sigma, I);
  const edge = Math.sign(rawEdge) * Math.min(Math.abs(rawEdge), edgeCap);
  const edgeCapped = Math.abs(rawEdge) > edgeCap;

  // ============================================================
  // 2. COMPUTE HALF-SPREAD FROM EDGE
  // ============================================================
  // Core idea: spread is proportional to |edge|, scaled by:
  // - Market liquidity (less liquid → wider)
  // - Quote size (more size → wider)
  // - Gamma (more convexity → wider)
  
  // Liquidity softener: ∈ [0.35, 1.0]
  // More liquid (0.9) → 0.35+0.65*0.1 = 0.415 (tighter)
  // Less liquid (0.1) → 0.35+0.65*0.9 = 0.935 (wider)
  const liqSoftener = 0.35 + 0.65 * (1 - marketLiquidity);
  
  // Size scale: mild convexity in size
  // Use vega-adjusted size: quoteSize * vega gives vega notional
  const vegaNotional = quoteSize * Math.abs(vega);
  const sizeScale = Math.max(1, Math.sqrt(vegaNotional / 100)); // Normalize to ~100 vega
  
  // Gamma bump: more convexity → wider spread
  const gammaBump = 1 + 0.25 * clamp(Math.abs(gamma) * 100, 0, 10);
  
  // Inventory term: half of absolute edge
  const inventoryTerm = 0.5 * Math.abs(edge);
  
  // Compute raw half-spread
  let halfSpread = inventoryTerm * liqSoftener * sizeScale * gammaBump;
  
  // Apply minimum
  halfSpread = Math.max(halfSpread, baseHalfSpread);
  
  // Apply maximum cap
  const spreadCapped = halfSpread > maxHalfSpread;
  halfSpread = Math.min(halfSpread, maxHalfSpread);
  
  // Snap to tick
  halfSpread = Math.max(minTick, Math.round(halfSpread / minTick) * minTick);

  // ============================================================
  // 3. COMPUTE MID (with optional impact shift)
  // ============================================================
  let midImpact = 0;
  
  if (centerMode === "shifted" && betaSelf > 0) {
    // Self-impact: how much does our quote size move the mid?
    // midImpact = betaSelf * size * g^T (Λ Σ g)
    const selfRisk = computeEdgeScalar(g, lambda, Sigma, g);
    midImpact = betaSelf * quoteSize * selfRisk;
  }
  
  const midUsed = ccMid + midImpact;

  // ============================================================
  // 4. COMPUTE BID/ASK (snap to tick)
  // ============================================================
  const bid = Math.floor((midUsed - halfSpread) / minTick) * minTick;
  const ask = Math.ceil((midUsed + halfSpread) / minTick) * minTick;

  // ============================================================
  // 5. RETURN WITH DIAGNOSTICS
  // ============================================================
  return {
    bid,
    ask,
    halfSpread,
    midUsed,
    edgeScalar: edge,
    diagnostics: {
      liqSoftener,
      sizeScale,
      gammaBump,
      inventoryTerm,
      midImpact,
      edgeCapped,
      spreadCapped
    }
  };
}