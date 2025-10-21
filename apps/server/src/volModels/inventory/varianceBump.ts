/**
 * Production-grade variance bump computation for PC quotes
 * 
 * Philosophy: Keep CC as single source of truth (your belief).
 * Apply inventory pressure via variance-space adjustment at quote time.
 * 
 * Safety features:
 * - Vega/T floors prevent near-expiry explosions
 * - Absolute + fractional caps keep adjustments bounded
 * - Soft clipping (tanh) prevents quote jitter
 * - √T scaling on λ for horizon risk
 * - Parity/sanity bounds
 * - Microstructure bands vs CC mid
 */

import { black76Greeks } from "../../risk/index.js";

// Helper for Black-76 vega using existing black76Greeks
function black76Vega(params: {
  F: number; K: number; T: number; sigma: number;
  r: number; q: number; call: boolean;
}): number {
    const greeks = black76Greeks(params.F, params.K, params.T, params.sigma, params.call, 1);
  return greeks.vega;
}

export interface VarianceBumpParams {
  // Market params
  F: number;           // Forward price
  K: number;           // Strike
  T: number;           // Time to expiry (years)
  r: number;           // Risk-free rate
  q: number;           // Dividend yield
  call: boolean;       // Call or put
  
  // CC state (your belief)
  ivCC: number;        // CC implied vol
  wCC: number;         // CC total variance
  ccMid: number;       // CC mid price
  
  // Inventory state
  lambda: number[];    // Cost per factor unit (λ)
  inventory: number[]; // Factor inventory (I)
  factorGreeksAt: () => number[]; // ∂P/∂factor at (K,T)
  
  // Safety knobs (with sensible defaults)
  maxAbsDW?: number;      // Absolute cap on δw (default: 0.02 = 2% variance)
  maxFracDW?: number;     // Fractional cap vs wCC (default: 0.25 = 25%)
  maxMoveVsCC?: number;   // Price band vs ccMid (default: 0.20 = ±20%)
}

export interface VarianceBumpResult {
    ivPC: number;           // Adjusted implied vol
    pcMid: number;          // Adjusted price
    edge: number;           // pcMid - ccMid
    diagnostics: {
      Tf: number;           // Time floor applied
      vega: number;         // Raw vega before floor
      vegaf: number;        // Floored vega
      dP_dW: number;        // ∂P/∂w (price sensitivity to variance)
      gPrice: number[];     // Factor greeks used
      lambda_scaled: number[]; // λ after √T scaling
      deltaP_raw: number;   // Raw pressure before scaling (NEW)
      scalePressure: number; // Pressure scaling factor (NEW)
      bandAbs: number;      // Target band (NEW)
      deltaP: number;       // Scaled pressure in price space
      deltaW: number;       // Variance bump (after clipping)
      deltaW_raw: number;   // Variance bump (before clipping)
      δwCap: number;        // Cap applied
      ivCC: number;         // Original CC vol
      wCC: number;          // Original CC variance
      wTarget: number;      // Target PC variance
      ivPC: number;         // Result PC vol
      ccMid: number;        // Original CC mid
      pcMid: number;        // Result PC mid
      clipped: boolean;     // Was clipping applied?
      bounded: boolean;     // Were price bounds applied?
    };
  }

/**
 * Compute PC quote via variance bump from factor inventory
 * 
 * Math:
 *   δP = Σ_i (λ_i × √T) × I_i × (∂P/∂factor_i)
 *   δw = δP / (∂P/∂w)  where ∂P/∂w = vega / (2σT)
 *   w_PC = w_CC + δw_clipped
 *   PC_mid = Black76(√(w_PC/T))
 */
export function computeVarianceBump(p: VarianceBumpParams): VarianceBumpResult {
    const {
      F, K, T, r, q, call,
      ivCC, wCC, ccMid,
      lambda, inventory,
      factorGreeksAt,
      maxAbsDW = 0.02,      // 2% absolute cap in total variance
      maxFracDW = 0.25,     // 25% of current variance
      maxMoveVsCC = 0.20    // ±20% price band vs CC mid (now used for scaling, not clamping)
    } = p;
  
    // ============================================================
    // 1. SAFETY: Floor T and vega to prevent division by zero
    // ============================================================
    const Tf = Math.max(T, 1e-5);  // Never less than ~9 hours
    
    const vega0 = black76Vega({ 
      F, K, T: Tf, sigma: ivCC, r, q, call 
    });
    const vegaf = Math.max(vega0, 1e-8);
    
    // Jacobian: ∂P/∂w = vega / (2σT) 
    // Scale by forward to fix units (vega is per BTC, we need per contract)
    const dP_dW = vegaf / Math.max(2 * ivCC * Tf * F, 1e-8);
    
    // ============================================================
    // 2. FACTOR GREEKS & HORIZON SCALING
    // ============================================================
    const gPrice = factorGreeksAt();
    
    // Scale λ by √T: risk grows with time
    const lambda_scaled = lambda.map(l => (l ?? 0) * Math.sqrt(Tf));
  
    // ============================================================
    // 3. COMPUTE PRESSURE IN PRICE SPACE (RAW)
    // ============================================================
    // δP = Σ (λ_i × I_i × g_i)
    let deltaP_raw = 0;
    const n = Math.min(gPrice.length, lambda_scaled.length, inventory.length);
    
    for (let i = 0; i < n; i++) {
      const pressure_i = (lambda_scaled[i] ?? 0) * (inventory[i] ?? 0);
      deltaP_raw += pressure_i * (gPrice[i] ?? 0);
    }
  
    // ============================================================
    // 3b. ADAPTIVE PRESSURE SCALING (GPT's fix)
    // ============================================================
    // If pressure is huge, scale it down to fit within the target band
    // This prevents quotes from being dead-on-arrival
    const targetBand = Math.abs(ccMid) * maxMoveVsCC;  // e.g., 20% of ccMid
    const minBandAbs = 0.0001;  // Minimum 0.01 bps for very cheap options
    const bandAbs = Math.max(targetBand, minBandAbs);
    
    // Scale pressure if it exceeds the band
    const scalePressure = bandAbs > 0 
      ? Math.min(1, bandAbs / Math.max(Math.abs(deltaP_raw), 1e-12)) 
      : 1;
    
    const deltaP = deltaP_raw * scalePressure;
  
    // ============================================================
    // 4. CONVERT TO VARIANCE BUMP
    // ============================================================
    const deltaW_raw = deltaP / dP_dW;
  
    // ============================================================
    // 5. APPLY CAPS: Both absolute and fractional
    // ============================================================
    const δwCap = Math.max(
      Math.min(maxAbsDW, maxFracDW * wCC),
      1e-6  // Minimum cap to prevent zero division
    );
  
    // Soft clip (tanh): smooth saturation prevents quote jitter
    const softClip = (x: number, c: number): number => {
      return c * Math.tanh(x / Math.max(c, 1e-9));
    };
    
    const deltaW = softClip(deltaW_raw, δwCap);
    const clipped = Math.abs(deltaW_raw) > δwCap * 0.99;
  
    // ============================================================
    // 6. APPLY ADJUSTMENT & KEEP VARIANCE POSITIVE
    // ============================================================
    const wTarget = Math.max(wCC + deltaW, 1e-10);
    const ivPC = Math.sqrt(wTarget / Tf);
  
    // ============================================================
    // 7. PRICE WITH ADJUSTED IV
    // ============================================================
    let pcMid_raw = black76Greeks(F, K, Tf, ivPC, call, Math.exp(-r * Tf)).price;
  
    // ============================================================
    // 8. PARITY & SANITY BOUNDS
    // ============================================================
    let bounded = false;
    
    // Intrinsic value
    const intrinsic = Math.max(
      call 
        ? (F * Math.exp(-q*Tf) - K * Math.exp(-r*Tf))
        : (K * Math.exp(-r*Tf) - F * Math.exp(-q*Tf)),
      0
    );
    
    // Trivial upper bound
    const trivialCap = call 
      ? (F * Math.exp(-q*Tf)) 
      : (K * Math.exp(-r*Tf));
  
    // Fallback if pricing failed
    if (!Number.isFinite(pcMid_raw)) {
      pcMid_raw = ccMid;
      bounded = true;
    }
  
    // Apply bounds
    const pcMid_unbounded = pcMid_raw;
    pcMid_raw = Math.max(intrinsic, Math.min(pcMid_raw, trivialCap));
    
    if (pcMid_raw !== pcMid_unbounded) {
      bounded = true;
    }
  
    // ============================================================
    // 9. BAND AS SCALING (NOT CLAMPING) - GPT's key insight
    // ============================================================
    // If we still overshoot the band after all adjustments,
    // scale back towards ccMid instead of hard-clamping
    const overshoot = Math.abs(pcMid_raw - ccMid) - bandAbs;
    const pcMid = overshoot > 0
      ? ccMid + Math.sign(pcMid_raw - ccMid) * bandAbs
      : pcMid_raw;
    
    if (pcMid !== pcMid_raw) {
      bounded = true;
    }
  
    // ============================================================
    // 10. RETURN WITH DIAGNOSTICS
    // ============================================================
    return {
      ivPC,
      pcMid,
      edge: pcMid - ccMid,
      diagnostics: {
        Tf,
        vega: vega0,
        vegaf,
        dP_dW,
        gPrice,
        lambda_scaled,
        deltaP_raw,        // Raw pressure before scaling
        scalePressure,     // How much we scaled (< 1 means we limited it)
        bandAbs,           // The band we're targeting
        deltaP,            // Scaled pressure
        deltaW,
        deltaW_raw,
        δwCap,
        ivCC,
        wCC,
        wTarget,
        ivPC,
        ccMid,
        pcMid,
        clipped,
        bounded
      }
    };
  }

/**
 * Helper: Check if variance bump looks reasonable
 * Returns warnings if diagnostics suggest issues
 */
export function validateVarianceBump(
  result: VarianceBumpResult
): string[] {
  const warnings: string[] = [];
  const d = result.diagnostics;

  // Check for extreme adjustments
  if (d.clipped) {
    warnings.push(`Variance bump clipped: ${d.deltaW_raw.toFixed(4)} → ${d.deltaW.toFixed(4)}`);
  }

  // Check for extreme IV changes
  const ivChange = Math.abs(d.ivPC - d.ivCC) / d.ivCC;
  if (ivChange > 0.5) {
    warnings.push(`Large IV change: ${(ivChange*100).toFixed(1)}%`);
  }

  // Check if bounds were hit
  if (d.bounded) {
    warnings.push('Price bounds applied (parity/band constraints hit)');
  }

  // Check for tiny vega (near-expiry risk)
  if (d.vega < 1e-6) {
    warnings.push(`Very low vega: ${d.vega.toExponential(2)} (near expiry?)`);
  }

  // Check for extreme pressure
  if (Math.abs(d.deltaP) > d.ccMid * 0.5) {
    warnings.push(`Large pressure: δP=${d.deltaP.toFixed(2)} vs ccMid=${d.ccMid.toFixed(2)}`);
  }

  return warnings;
}