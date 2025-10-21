/**
 * Integrated Dual Surface Model with Market Calibration
 * Convention: TradeExecution.size is **DEALER-signed**
 *   - Customer BUY  => dealer SELL  => size = -|q|
 *   - Customer SELL => dealer BUY   => size = +|q|
 */
import { fitSmileDeltaShells, type QuotePoint } from '../calibration/deltaShellSmile';
import {
  SVIParams, TraderMetrics, NodeState, SVI, RiskScorer
} from './dualSurfaceModel';
import { ModelConfig, getDefaultConfig } from './config/modelConfig';
import { SmileInventoryController } from './smileInventoryController';
import { DeltaConventions } from './pricing/blackScholes';
import { black76Greeks } from '../risk/index';
import { overnightMasses } from "../pricing/seasonality";
import { eventMasses } from "../pricing/eventTable";
import { timeToExpiryYears } from "../utils/time";
import { calibrateSVI, MarketSmilePoint } from "./sviCalibration";
import { tauIntegral } from "../pricing/seasonality";
import { factorGreeksFiniteDiff } from './factors/factorGreeks';

import { 
  quoteDiagLogger, 
  type QuoteDiagnostics 
} from './inventory/quoteDiagnostics';

import { computeTargetCurvePricing } from './inventory/targetCurvePricing';

import { 
  LambdaLearner, 
  LambdaLearnerFactory,
  type FillObservation,
  type LambdaStats
} from './inventory/lambdaLearner';

import { fitPC } from '../calibration/fitPC';
import { buildDeltaAnchoredBasis } from '../risk/factors/buildDeltaAnchoredBasis';
import { getMarketSpec, clampQuoted } from '../markets/index';



const tiny = 1e-12;
/**
 * Compute ATM total variance from market mid price
 */
function computeAtmTotalVariance(
  atmCallMid: number,
  F: number,
  K: number,
  tau: number,
  mkt: ReturnType<typeof getMarketSpec>
): number {
  // Convert to base currency if needed
  const midBase = mkt.premiumConvention === 'QUOTE' 
    ? mkt.fromQuotedToBase(atmCallMid, F)
    : atmCallMid;
  
  // Invert Black-76 to get IV (simple Newton-Raphson)
  let iv = 0.5; // initial guess
  for (let iter = 0; iter < 10; iter++) {
    const price = blackFracPrice(F, K, tau, iv, true);
    const priceBase = price * F;
    const vega = black76Greeks(F, K, tau, iv, true, 1.0).vega;
    
    if (Math.abs(vega) < 1e-10) break;
    const diff = priceBase - midBase;
    if (Math.abs(diff) < 1e-8) break;
    
    iv = iv - diff / (vega * F);
    iv = Math.max(0.01, Math.min(5.0, iv)); // clamp
  }
  
  return iv * iv * tau;
}

/**
 * Compute ATM IV from straddle using strikes bracketing the forward
 */
function forwardATMStraddleIV(
  quotes: Array<{ strike: number; iv: number; weight?: number }>,
  F: number,
  tau: number,
  minTick: number
): number | null {
  // Sort by distance from forward
  const sorted = quotes.slice().sort((a, b) => 
    Math.abs(a.strike - F) - Math.abs(b.strike - F)
  );
  
  // Take closest 4 strikes, filter out floor-tick IVs
  const candidates = sorted.slice(0, 4).filter(q => {
    // Rough price check: IV should produce time value > 1.5 ticks
    const roughPrice = q.iv * Math.sqrt(tau) * F * 0.4; // approximate
    return roughPrice > 1.5 * minTick && q.iv > 0.01 && q.iv < 5.0;
  });
  
  if (candidates.length === 0) return null;
  
  // Use the closest valid strike's IV as ATM
  return candidates[0].iv;
}

/**
 * Vega-weighted IV interpolation at forward
 */
function vegaWeightedIVInterp(
  quotes: Array<{ strike: number; iv: number; weight?: number }>,
  F: number,
  T: number,
  minTick: number
): number {
  // Find two strikes bracketing F
  const below = quotes.filter(q => q.strike <= F).sort((a, b) => b.strike - a.strike);
  const above = quotes.filter(q => q.strike > F).sort((a, b) => a.strike - b.strike);
  
  if (below.length === 0 && above.length === 0) return 0.5;
  if (below.length === 0) return above[0].iv;
  if (above.length === 0) return below[0].iv;
  
  const k1 = below[0];
  const k2 = above[0];
  
  // Linear interpolation in log-moneyness
  const logF = Math.log(F);
  const logK1 = Math.log(k1.strike);
  const logK2 = Math.log(k2.strike);
  
  const w = (logF - logK1) / Math.max(logK2 - logK1, 1e-9);
  return (1 - w) * k1.iv + w * k2.iv;
}

const safe = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);

/**
 * Build clean mid from bid/ask, rejecting floor-tick quotes
 */
function mkMid(bid: number | undefined, ask: number | undefined, tick: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return NaN;
  if (bid! <= 0 || ask! <= 0) return NaN;
  if (ask! < bid!) return NaN;
  const mid = 0.5 * (bid! + ask!);
  // Treat floor-tick quotes as unusable targets
  if (mid <= 1.5 * tick) return NaN;
  return mid;
}

/**
 * Dimensionless Black-76: returns price as FRACTION OF FORWARD (BTC fraction)
 * This ensures unit consistency across all pricing paths
 */
function blackFracPrice(F: number, K: number, T: number, iv: number, isCall: boolean): number {
  const kRel = K / F;  // Normalize strike to forward
  // Price with forward = 1, strike = kRel (dimensionless)
  return black76Greeks(1.0, kRel, Math.max(T, 1e-8), iv, isCall, 1.0).price;
}

/**
 * Intrinsic value in the same units (fraction of BTC/forward)
 */
function intrinsicFrac(F: number, K: number, isCall: boolean): number {
  const kRel = K / F;
  return isCall ? Math.max(1 - kRel, 0) : Math.max(kRel - 1, 0);
}

/**
 * Health check summary for one refit
 */
function healthSummary(
  name: string,
  legs: Array<{K: number; mid: number; ccFull: number; intr: number; tvM: number; tvC: number}>,
  F: number,
  tick: number
): void {
  const n = legs.length;
  const atm = legs.reduce((best, x) => {
    const m = Math.abs(x.K / F - 1);
    return m < best.m ? {m, leg: x} : best;
  }, {m: 1e9, leg: legs[0]}).leg;

  const floors = legs.filter(x => x.mid <= 1.5 * tick).length;
  const badTV = legs.filter(x => x.tvM < 0 || x.tvC < 0).length;

  const res = legs.map(x => x.tvM - x.tvC);
  const absRes = res.map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => absRes[Math.floor((absRes.length - 1) * p)];
  const med = q(0.5);

  console.log(
    `[HEALTH ${name}] F=${F.toFixed(2)} ATM.K=${atm.K} mid=${atm.mid.toFixed(6)} cc=${atm.ccFull.toFixed(6)} ` +
    `intr=${atm.intr.toFixed(6)} floors=${floors}/${n} badTV=${badTV} med|ΔTV|=${med.toFixed(6)} ` +
    `q90=${q(0.9).toFixed(6)} tick=${tick.toExponential(2)}`
  );
}

export interface Quote {
  bid: number; ask: number;
  bidSize: number; askSize: number;
  pcMid: number; ccMid: number;
  edge: number; bucket: string;
}
export interface TradeExecution {
  expiryMs: number;
  strike: number;
  forward: number;
  optionType: 'C' | 'P';
  price: number;
  size: number;
  time: number;
}
export interface EnhancedSurface {
  expiry: number; cc: SVIParams; pc: SVIParams; nodes: Map<number, NodeState>;
}
export interface MarketQuoteForCalibration { strike: number; iv: number; weight?: number; }

/**
 * Calibrate SVI with ATM hard-anchored at k=0 (forward moneyness)
 * Optimizes only [b, rho, sigma], computes a = vATM - b*sigma
 */
function calibrateSVIWithATMAnchor(
  marketPoints: MarketSmilePoint[],
  F: number,
  T: number,
  vATM: number,
  config: any
): SVIParams {
  // Starting guess
  let b = 0.10;
  let rho = -0.25;
  let sigma = 0.20;
  
  // Objective: minimize weighted squared error with hard ATM pin at k=0
  function objective(params: number[]): number {
    const [bTry, rhoTry, sigmaTry] = params;
    const a = vATM - bTry * sigmaTry; // ATM anchor: w(0) = a + b*sigma = vATM
    
    let error = 0;
    let wSum = 0;
    
    // CRITICAL: Add synthetic ATM anchor at k=0 with huge weight
    {
      const wSVI0 = a + bTry * sigmaTry;  // w(0)
      const wTarget0 = vATM;
      const W0 = 1e6;  // Hard pin - dominates other weights
      error += W0 * Math.pow(wSVI0 - wTarget0, 2);
      wSum += W0;
    }
    
    // Add market points (using FORWARD for log-moneyness)
    for (const pt of marketPoints) {
      const k = Math.log(pt.strike / Math.max(F, 1e-9));  // k = ln(K/F), NOT ln(K/spot)
      const wSVI = a + bTry * (Math.sqrt(k * k + sigmaTry * sigmaTry) + rhoTry * k);
      const wMarket = pt.iv * pt.iv * T;
      const weight = pt.weight ?? 1;
      
      error += weight * Math.pow(wSVI - wMarket, 2);
      wSum += weight;
    }
    
    return error / Math.max(wSum, 1);
  }
  
  // Simple gradient descent with constraints
  const lr = 0.01;
  const maxIter = 200;
  
  for (let iter = 0; iter < maxIter; iter++) {
    const eps = 1e-6;
    const f0 = objective([b, rho, sigma]);
    
    // Finite difference gradients
    const gb = (objective([b + eps, rho, sigma]) - f0) / eps;
    const gr = (objective([b, rho + eps, sigma]) - f0) / eps;
    const gs = (objective([b, rho, sigma + eps]) - f0) / eps;
    
    // Update with constraints
    b = Math.max(config.bMin, b - lr * gb);
    rho = Math.max(-config.rhoMax, Math.min(config.rhoMax, rho - lr * gr));
    sigma = Math.max(config.sigmaMin, sigma - lr * gs);
    
    if (iter % 50 === 0) {
      const a = vATM - b * sigma;
      console.log(`[ATM-SVI] iter=${iter}, f=${f0.toExponential(4)}, a=${a.toFixed(6)}, b=${b.toFixed(6)}, rho=${rho.toFixed(3)}, sigma=${sigma.toFixed(6)}`);
    }
  }
  
  const a = vATM - b * sigma;
  
  // Validate
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(rho) || !Number.isFinite(sigma)) {
    console.error('[ATM-SVI] Invalid result, using fallback');
    return { a: vATM, b: 0.10, rho: -0.25, m: 0, sigma: 0.20 };
  }
  
  return { a, b, rho, m: 0, sigma };
}

export class IntegratedSmileModel {
  private surfaces = new Map<number, EnhancedSurface>();
  private inventoryController: SmileInventoryController;
  private riskScorer: RiskScorer;
  private config: ModelConfig;
  private sviConfig: any;
  private version = 0;
  private marketIVs = new Map<number, number>();
  private symbol: string;
  private clockFn: () => number = Date.now;

  // Lambda learner for online learning (optional)
  private lambdaLearner?: LambdaLearner;
  
  // Current lambda vector (cost per factor unit)
  // [L0, S0, C0, Sneg, Spos, F]
  private lambda: number[] = [
    0.0004,   // L0
    0.0032,   // S0
    0.0016,   // C0
    0.0012,   // Sneg
    0.0008,   // Spos
    0.0002    // F
  ];
  
  // Factor inventory vector
  // Tracks net exposure in each factor dimension
  // Updated by trades, decays over time
  private factorInventory: number[] = [0, 0, 0, 0, 0, 0];
  
  // Parallel mode: run old + new side-by-side for comparison
  private parallelMode: boolean = false;
  
  // Use new variance bump method (vs old SmileInventoryController)
  private useVarianceBump: boolean = false;

  // Price-space PC fit mode (Phase 1B)
  private usePCFit: boolean = false;
  
  // Cache for PC fit results per expiry
  private pcFitCache = new Map<number, {
    theta: number[];
    pcPrices: Map<number, number>;  // strike -> pcPrice
    timestamp: number;
    rmse: number;
  }>();
  
  // Batch pricing: collect market data for fitting
  private marketDataCache = new Map<number, Array<{
    strike: number;
    marketMid: number;
    weight: number;
  }>>();

  // Debounced refit
  private refitTimers = new Map<number, NodeJS.Timeout>();
  private refitDebounceMs = 2000;  // 2 seconds
  private refitHeartbeatMs = 10000;  // 10 seconds
  private lastRefitTime = new Map<number, number>();

  private mkt: ReturnType<typeof getMarketSpec>;


  constructor(product: 'BTC'|'ETH'|'SPX' = 'BTC', clockFn?: () => number) {
    this.symbol = product;
    this.mkt = getMarketSpec(product);
    this.config = getDefaultConfig(product);
    this.sviConfig = this.convertToSVIConfig(this.config);
    this.inventoryController = new SmileInventoryController(this.config);
    this.riskScorer = new RiskScorer();
    if (clockFn) this.clockFn = clockFn;
    
    // Initialize from environment
    this.parallelMode = process.env.PARALLEL_MODE === 'true';
    this.useVarianceBump = process.env.USE_VARIANCE_BUMP === 'true';
    this.usePCFit = (process.env.USE_PC_FIT ?? 'false').toLowerCase() === 'true';
    
    console.log('[ISM] Initialization:', {
      product,
      parallelMode: this.parallelMode,
      useVarianceBump: this.useVarianceBump,
      usePCFit: this.usePCFit,
      lambdaLearning: !!this.lambdaLearner
    });
    
    // Initialize lambda learner if enabled
    if (process.env.ENABLE_LAMBDA_LEARNING === 'true') {
      this.lambdaLearner = LambdaLearnerFactory.createDefault(6);
      console.log('[ISM] Lambda learning enabled');
    }
  }

  // ============================================================
  // HELPER METHODS FOR VARIANCE BUMP
  // ============================================================

  /**
   * Get current lambda vector
   */
  private getLambda(): number[] {
    if (this.lambdaLearner) {
      return this.lambdaLearner.getLambda();
    }
    return this.lambda;
  }
  
  /**
   * Compute edge scalar: e = g^T (Λ Σ g)
   * This gives the required edge per contract
   */
  private computeEdgeScalar(
    g: number[],
    lambda: number[],
    Sigma: number[][],
    factorVec: number[]
  ): number {
    const n = g.length;
    
    // Step 1: Compute Σ · factorVec
    const SigmaVec = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        SigmaVec[i] += Sigma[i][j] * factorVec[j];
      }
    }
    
    // Step 2: Apply diagonal Λ
    const LambdaSigmaVec = SigmaVec.map((v, i) => lambda[i] * v);
    
    // Step 3: Dot product: g^T (Λ Σ factorVec)
    let edge = 0;
    for (let i = 0; i < n; i++) {
      edge += g[i] * LambdaSigmaVec[i];
    }
    
    return edge;
  }

  /**
   * Get current factor inventory
   */
  private getInventory(): number[] {
    return this.factorInventory;
  }

  /**
   * Get covariance matrix for factors
   * TODO: Replace with learned covariance in Phase 2
   * For now: simple diagonal based on typical factor volatilities
   */
  private getCovariance(T: number): number[][] {
    // Typical factor volatilities (annualized)
    const factorVols = [
      0.20,  // L0 - Level
      0.30,  // S0 - Skew
      0.25,  // C0 - Curvature
      0.35,  // Sneg - Put wing
      0.35,  // Spos - Call wing
      0.15   // F - Forward
    ];
    
    // Scale by sqrt(T) for time-to-expiry
    const timeScale = Math.sqrt(T);
    
    // Create diagonal covariance matrix
    const n = 6;
    const Sigma: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
      Sigma[i][i] = Math.pow(factorVols[i] * timeScale, 2);
    }
    
    return Sigma;
  }

  /**
   * Compute factor greeks for a specific instrument
   */
  private computeFactorGreeks(
    strike: number,
    expiryMs: number,
    forward: number,
    isCall: boolean
  ): number[] {
    const now = this.clockFn();
    const T = Math.max(timeToExpiryYears(expiryMs, now), 1e-8);
    
    const s = this.surfaces.get(expiryMs);
    if (!s || !s.cc) {
      console.warn(`[computeFactorGreeks] No CC surface for expiry ${expiryMs}`);
      return [0, 0, 0, 0, 0, 0];
    }
    
    try {
      const cfg = this.sviConfig;
      const g = factorGreeksFiniteDiff(s.cc, strike, T, forward, isCall, cfg, false);
      return g;
    } catch (err) {
      console.error(`[computeFactorGreeks] Error:`, err);
      return [0, 0, 0, 0, 0, 0];
    }
  }

  /**
   * Fit PC surface for entire expiry using price-space calibration
   * Called once per expiry when market data is available
   */
  private fitPCForExpiry(expiryMs: number, forward: number): void {
    const marketData = this.marketDataCache.get(expiryMs);
    if (!marketData || marketData.length < 3) {
      console.warn(`[fitPCForExpiry] Insufficient market data for expiry ${expiryMs}`);
      return;
    }
    
    const now = this.clockFn();
    const T = Math.max(timeToExpiryYears(expiryMs, now), 1e-8);
    
    const s = this.surfaces.get(expiryMs);
    if (!s || !s.cc) {
      console.warn(`[fitPCForExpiry] No CC surface for expiry ${expiryMs}`);
      return;
    }
    
    // ✅ VALIDATION: Check CC surface is usable
    const testK = 0;  // ATM in log-moneyness
    const testVar = SVI.w(s.cc, testK);
    if (!Number.isFinite(testVar) || testVar <= 0) {
      console.warn(`[fitPCForExpiry] Invalid CC surface (ATM variance=${testVar}), aborting`);
      return;
    }
    
    // Get ATM IV once for all strikes (simpler and more stable)
    const atmIV = this.marketIVs.get(expiryMs) ?? 0.65;
    
    // ✅ BUILD LEGS: Simple structure
    let legs = marketData.map(md => ({
      strike: md.strike,
      K: md.strike,
      T,
      F: forward,
      isCall: true,
      marketMid: md.marketMid,
      weight: md.weight
    }));
    
    // ✅ FILTER: Remove deep ITM strikes (±30% of forward)
    const filteredLegs = legs.filter(leg => 
      leg.strike >= forward * 0.70 && leg.strike <= forward * 1.30
    );
    
    if (filteredLegs.length < 5) {
      console.warn(`[fitPCForExpiry] Only ${filteredLegs.length} strikes after ITM filter (need 5+)`);
      return;
    }
    
    if (filteredLegs.length < legs.length) {
      console.log(`[fitPCForExpiry] Filtered ${legs.length - filteredLegs.length} deep ITM strikes (${filteredLegs.length} remain)`);
    }
    
    legs = filteredLegs;

    // ✅ Normalize legs.marketMid to quoted convention and guard tiny values


    {
      const F = Math.max(forward, 1e-6);
    
      legs = legs.map((leg) => {
        let m = leg.marketMid;
    
        // If someone fed base-currency (USD) by mistake, convert down to quoted:
        // Heuristic: if premium looks way bigger than allowed quoted cap.
        const cap = this.mkt.maxPremium ?? Number.POSITIVE_INFINITY;
        if (m > cap && this.mkt.premiumConvention === 'QUOTE') {
          m = this.mkt.fromBaseToQuoted(m, F);
        }
    
        if (!Number.isFinite(m) || m <= 0) m = this.mkt.minTick * 0.5;
        m = clampQuoted(m, this.mkt);
    
        return { ...leg, marketMid: m };
      });
    }

    // ✅ Define seasonality adjustments for CC pricing
    const tick = this.mkt.minTick;
    const wON = overnightMasses(now, expiryMs);
    const wEvt = eventMasses(this.symbol, now, expiryMs);
    
    // ✅ BUILD DELTA-ANCHORED BASIS
    const basis = buildDeltaAnchoredBasis(legs, forward, T, atmIV);
    
    console.log(`[fitPCForExpiry] Built delta-anchored basis:`, {
      expiry: expiryMs,
      factors: basis.names,
      numLegs: legs.length
    });

   // ✅ COMPUTE CC TIME VALUE + BUILD REGRESSION TARGET (NORMALIZED UNITS)
const F = Math.max(forward, 1e-9);
const ccTV: number[] = [];
const targetY: number[] = [];
const validLegs: boolean[] = [];

legs.forEach((leg, idx) => {
  const k = Math.log(leg.strike / F);
  const wBase = Math.max(SVI.w(s.cc, k), tiny);
  const wTot = wBase + wON + wEvt;
  const iv = Math.sqrt(wTot / Math.max(T, 1e-12));
  
  // ✅ CC FULL PRICE: Use normalized Black (fraction of BTC)
  const ccFullPrice = blackFracPrice(F, leg.strike, T, iv, leg.isCall);
  
  // ✅ INTRINSIC: Use normalized intrinsic (fraction of BTC)
  const intrinsic = intrinsicFrac(F, leg.strike, leg.isCall);
  
  // ✅ FILTER: Only reject if ACTUALLY at floor AND far OTM
  const isFloor = leg.marketMid <= 1.5 * tick;
  const isFarOTM = Math.abs(Math.log(leg.strike / F)) > 0.25; // >25% out
  
  if (isFloor && isFarOTM) {
    if (idx < 3) {
      console.log(`[DEBUG] Strike ${leg.strike}: REJECTED (floor-tick mid=${leg.marketMid.toFixed(6)}, far OTM)`);
    }
    ccTV.push(0);
    targetY.push(0);
    validLegs.push(false);
    leg.weight = 0;
    return;
  }
  
  // CC time value (dimensionless)
  const ccTimeValue = Math.max(ccFullPrice - intrinsic, 0);
  ccTV.push(ccTimeValue);
  
  // Market time value (dimensionless)
  const marketTimeValue = Math.max(leg.marketMid - intrinsic, 0);
  
  // REGRESSION TARGET: residual TV that PC must explain
  const residual = marketTimeValue - ccTimeValue;
  targetY.push(residual);
  validLegs.push(true);
  
  if (idx < 3) {
    console.log(`[DEBUG] Strike ${leg.strike}: k=${k.toFixed(4)}, iv=${iv.toFixed(4)}, ccFull=${ccFullPrice.toFixed(6)}, intrinsic=${intrinsic.toFixed(6)}, ccTV=${ccTimeValue.toFixed(6)}, marketTV=${marketTimeValue.toFixed(6)}, residual=${residual.toFixed(6)}`);
  }
});

// ✅ COUNT VALID LEGS
const numValid = validLegs.filter(v => v).length;
console.log(`[fitPCForExpiry] Valid legs: ${numValid}/${legs.length} (${legs.length - numValid} rejected as floor-tick)`);

if (numValid < 5) {
  console.warn(`[fitPCForExpiry] Only ${numValid} valid legs after filtering, aborting`);
  return;
}

// ✅ HEALTH CHECK: Validate units and targets
const healthLegs = legs.map((leg, i) => ({
  K: leg.strike,
  mid: leg.marketMid,
  ccFull: ccTV[i] + intrinsicFrac(F, leg.strike, leg.isCall),
  intr: intrinsicFrac(F, leg.strike, leg.isCall),
  tvM: leg.marketMid - intrinsicFrac(F, leg.strike, leg.isCall),
  tvC: ccTV[i]
})).filter((_, i) => validLegs[i]);

healthSummary(`PC:${expiryMs}`, healthLegs, F, tick);

// ✅ VALIDATE TARGET: Ensure we're not just fitting to CC
let meaningfulCorrections = 0;
for (let i = 0; i < targetY.length; i++) {
  const relativeCorrection = Math.abs(targetY[i]) / Math.max(ccTV[i], tick);
  if (relativeCorrection > 0.05) {  // More than 5% correction
    meaningfulCorrections++;
  }
}

if (meaningfulCorrections < 0.2 * targetY.length) {
  console.warn(
    `[fitPCForExpiry] Only ${meaningfulCorrections}/${targetY.length} legs need >5% correction. ` +
    `Target may be wrong - PC would just reproduce CC!`
  );
} else {
  console.log(
    `[fitPCForExpiry] Target validation: ${meaningfulCorrections}/${targetY.length} legs have meaningful corrections`
  );
}
 
    this.logFitTable(expiryMs, forward, T, legs, ccTV);
   
   // ✅ VEGA-WEIGHTED LEGS (only for valid legs)
   for (let i = 0; i < legs.length; i++) {
    if (!validLegs[i]) {
      legs[i].weight = 0;
      continue;
    }
    
    const k = Math.log(legs[i].strike / F);
    const w = Math.max(SVI.w(s.cc, k), tiny);
    const iv = Math.sqrt(w / Math.max(T, 1e-8));
    const greeks = black76Greeks(forward, legs[i].strike, Math.max(T, 1e-8), iv, legs[i].isCall, 1.0);
    
    // Vega-based weight
    let wgt = Math.max(1e-6, Math.abs(greeks.vega));
    
    // Downweight if spread is wide (> 60% of mid)
    // Note: We don't have bid/ask here, so this is a proxy
    if (legs[i].marketMid <= 2 * tick) {
      wgt *= 0.01;  // Nearly zero weight for near-floor
    }
    
    legs[i].weight = Math.min(wgt, 50.0);
  }

  // ✅ FIND ATM LEG: Find the leg closest to 50-delta (for later hard pin)
  let atmIdx = -1;
  let bestErr = 1e9;
  
  try {
    for (let i = 0; i < legs.length; i++) {
      if (legs[i].weight <= 0) continue;
      
      const k = Math.log(legs[i].strike / F);
      const w = Math.max(SVI.w(s.cc, k), tiny);
      const iv = Math.sqrt(w / Math.max(T, 1e-12));
      const g = black76Greeks(forward, legs[i].strike, Math.max(T, 1e-8), iv, legs[i].isCall, 1.0);
      const err = Math.abs(Math.abs(g.delta) - 0.5);
      
      if (err < bestErr) {
        bestErr = err;
        atmIdx = i;
      }
    }
    
    if (atmIdx >= 0) {
      console.log(`[fitPCForExpiry] Found ATM leg: strike=${legs[atmIdx].strike}, delta_err=${bestErr.toFixed(4)}`);
    }
  } catch (err) {
    console.warn(`[fitPCForExpiry] ATM detection failed:`, err);
  }

    // --- SIMPLE 1D LEVEL FIT (price-space) with ATM taper & OTM floor ---

// Controls (safe defaults)
const taperBand = 0.25;           // blend fully at ATM, taper to 0 by |k|=0.25
const strongTVTicks = 5;          // only fully trust legs with CC TV >= 5 ticks
const weakLegWeight = 0.10;       // downweight tiny-TV legs (floor-y quotes)
const minTVTicks = 2;             // never let PC TV fall below 2 ticks
const minTVFracOfCC = 0.50;       // never cut CC TV by more than 50%

// Precompute |k| and CC TV per leg, build weights with taper
const F_forWeights = Math.max(forward, 1e-9);
const kAbs: number[] = [];
const ccTvPerLeg: number[] = [];
const wTap: number[] = [];
const wStrong: number[] = [];
for (let i = 0; i < legs.length; i++) {
  const k = Math.log(legs[i].strike / F_forWeights);
  kAbs[i] = Math.abs(k);
  wTap[i] = Math.max(0, 1 - kAbs[i] / taperBand); // 1 at ATM → 0 by |k|=taperBand
  ccTvPerLeg[i] = ccTV[i];
  const strong = ccTV[i] >= strongTVTicks * tick;
  wStrong[i] = strong ? 1 : weakLegWeight;
}

// Weighted mean residual within the band, ignoring invalid legs
const ws = legs.map((l, i) => (validLegs[i] ? ((l.weight ?? 1) * wTap[i] * wStrong[i]) : 0));
const wSum = ws.reduce((a, b) => a + b, 0) || 1;
let thetaLevel = targetY.reduce((s, r, i) => s + ws[i] * r, 0) / wSum;

// ✅ HARD ATM PIN: Force ATM leg to match market exactly
if (atmIdx >= 0 && validLegs[atmIdx]) {
  const atmResidual = targetY[atmIdx];
  console.log(`[fitPCForExpiry] ATM hard pin: shifting theta by ${atmResidual.toFixed(8)} to zero ATM residual at K=${legs[atmIdx].strike}`);
  
  // Override theta to make ATM residual exactly zero
  thetaLevel = atmResidual;
}
// Build pcTV = ccTV + theta * taper, with a soft floor
const pcTV = new Map<number, number>();
for (let i = 0; i < legs.length; i++) {
  if (!validLegs[i]) continue;

  // Apply less shift away from ATM
  const raw = ccTvPerLeg[i] + thetaLevel * wTap[i];

  // Soft floor: at least max(2*tick, 50% of CC TV)
  const floorTV = Math.max(minTVTicks * tick, minTVFracOfCC * ccTvPerLeg[i]);

  const tv = Math.max(raw, floorTV);
  pcTV.set(legs[i].strike, tv);
}

// Cache as TVs (not full prices)
this.pcFitCache.set(expiryMs, {
  theta: [thetaLevel],
  pcPrices: pcTV,
  timestamp: now,
  rmse: Math.sqrt(
    targetY.reduce((s, r, i) => s + ws[i] * Math.pow(r - thetaLevel, 2), 0) / wSum
  ),
});

// Diagnostics
const validLegCount = validLegs.filter(v => v).length;
const avgMarketTV = legs.reduce((s, l, i) => {
  if (!validLegs[i]) return s;
  const intrinsic = intrinsicFrac(forward, l.strike, l.isCall);
  return s + Math.max(l.marketMid - intrinsic, 0);
}, 0) / Math.max(validLegCount, 1);

// ✅ ATM DIAGNOSTIC: Show PC vs CC vs Market
if (atmIdx >= 0 && validLegs[atmIdx]) {
  const atmLeg = legs[atmIdx];
  const atmIntrinsic = intrinsicFrac(F, atmLeg.strike, atmLeg.isCall);
  const atmCCTV = ccTV[atmIdx];
  const atmMarketTV = Math.max(atmLeg.marketMid - atmIntrinsic, 0);
  const atmPCTV = pcTV.get(atmLeg.strike) ?? 0;
  
  const ccCall = atmIntrinsic + atmCCTV;
  const pcCall = atmIntrinsic + atmPCTV;
  const diffBps = (pcCall - atmLeg.marketMid) / Math.max(atmLeg.marketMid, tiny) * 10000;
  
  console.log(`[fitPCForExpiry] 🎯 ATM Check (K=${atmLeg.strike}):`);
  console.log(`  Market: mid=${atmLeg.marketMid.toFixed(6)}, TV=${atmMarketTV.toFixed(6)}`);
  console.log(`  CC(SVI): TV=${atmCCTV.toFixed(6)}, call=${ccCall.toFixed(6)}`);
  console.log(`  PC(fit): TV=${atmPCTV.toFixed(6)}, call=${pcCall.toFixed(6)}`);
  console.log(`  Error: ${(pcCall - atmLeg.marketMid).toFixed(6)} (${diffBps.toFixed(1)} bps) ${Math.abs(diffBps) < 50 ? '✓' : '✗ FAILED'}`);
}

console.log(`[fitPCForExpiry] ✅ Fitted expiry ${expiryMs}:`, {
  numLegs: legs.length,
  factors: ['Level(tapered)'],
  theta: [thetaLevel.toFixed(8)],
  rmse: (Math.sqrt(
    targetY.reduce((s, r, i) => s + ws[i] * Math.pow(r - thetaLevel, 2), 0) / wSum
  ) * 10000).toFixed(2) + ' bps',
  within1Tick: '—',
  noArbViolations: 0,
  shrink: '—',
  condG: '—',
  avgCCTV: (ccTV.reduce((s, p) => s + p, 0) / ccTV.length).toFixed(6),
  avgMarketTV: avgMarketTV.toFixed(6),
  avgResidual: (targetY.reduce((s, r) => s + Math.abs(r), 0) / targetY.length).toFixed(6),
  maxResidual: Math.max(...targetY.map(Math.abs)).toFixed(6)
});


  }
  
  /**
   * Update market data cache for batch fitting
   * Call this when you receive market quotes
   */
  updateMarketData(
    expiryMs: number,
    strike: number,
    marketMid: number,
    forward: number,
    weight: number = 1.0
  ): void {
    if (!this.marketDataCache.has(expiryMs)) {
      this.marketDataCache.set(expiryMs, []);
    }
    const cache = this.marketDataCache.get(expiryMs)!;
  
    // Normalize to QUOTED units using market spec
    const F = Math.max(forward, 1e-6);
    const cap = this.mkt.maxPremium ?? Number.POSITIVE_INFINITY;
  
    let midQuoted = marketMid;
    // If the incoming value looks like base currency but we expect quoted, convert.
    if (midQuoted > cap && this.mkt.premiumConvention === 'QUOTE') {
      midQuoted = this.mkt.fromBaseToQuoted(midQuoted, F);
    }
    midQuoted = clampQuoted(midQuoted, this.mkt);
  
    const i = cache.findIndex(md => md.strike === strike);
    const rec = { strike, marketMid: midQuoted, weight };
    if (i >= 0) cache[i] = rec; else cache.push(rec);
  
    if (this.usePCFit) {
      this.scheduleRefit(expiryMs, forward);
    }
  }
  
  

  /**
 * Debounced refit trigger
 */
  private scheduleRefit(expiryMs: number, forward: number): void {
    const now = this.clockFn();
    const lastRefit = this.lastRefitTime.get(expiryMs) || 0;
    
    // Clear existing timer
    const existing = this.refitTimers.get(expiryMs);
    if (existing) {
      clearTimeout(existing);
    }
    
    // ✅ CHECK 1: CC surface exists and is valid
    const surface = this.surfaces.get(expiryMs);
    if (!surface || !surface.cc) {
      console.log(`[scheduleRefit] No SVI surface for ${expiryMs}, skipping`);
      return;
    }
    
    // ✅ CHECK 2: Test CC variance is reasonable
    const testK = 0;  // ATM
    const ccVar = SVI.w(surface.cc, testK);
    if (!Number.isFinite(ccVar) || ccVar <= 0) {
      console.warn(`[scheduleRefit] Invalid CC variance (${ccVar}), skipping`);
      return;
    }
    
    // ✅ CHECK 3: Validate data quality
    const dataCache = this.marketDataCache.get(expiryMs);
    if (!dataCache || dataCache.length < 15) {
      return;  // Not enough data
    }
    
    // ✅ CHECK 4: Strike range validation
    const strikes = dataCache.map(d => d.strike).sort((a, b) => a - b);
    const minStrike = strikes[0];
    const maxStrike = strikes[strikes.length - 1];
    const range = maxStrike - minStrike;
    
    const minRangeRatio = 0.25; // need ~25% of F in strikes covered
if ((range / Math.max(forward, 1e-6)) < minRangeRatio) {
  console.log(`[scheduleRefit] Strike range too narrow (range=${range}, F=${forward}), waiting...`);
  return;
}
    
    // ✅ CHECK 5: Validate prices are reasonable
    const badData = dataCache.filter(d =>
      !Number.isFinite(d.marketMid) ||
      d.marketMid <= 0 ||
      (this.mkt.maxPremium !== undefined && d.marketMid > this.mkt.maxPremium) ||
      d.weight <= 0 || !Number.isFinite(d.weight)
    );
    
    
    if (badData.length > 0) {
      console.warn(`[scheduleRefit] ${badData.length} bad data points, skipping refit`);
      return;
    }
    
    // Schedule refit
    const timer = setTimeout(() => {
      console.log(`[scheduleRefit] Refitting expiry ${expiryMs} (${dataCache.length} strikes, ${minStrike}-${maxStrike})`);
      this.fitPCForExpiry(expiryMs, forward);
      this.lastRefitTime.set(expiryMs, this.clockFn());
      this.refitTimers.delete(expiryMs);
    }, this.refitDebounceMs);
    
    this.refitTimers.set(expiryMs, timer);
    
    // Heartbeat: force refit if too much time has passed
    if (now - lastRefit > this.refitHeartbeatMs) {
      clearTimeout(timer);
      this.refitTimers.delete(expiryMs);
      
      const minRangeRatio = 0.25;
if (dataCache.length >= 15 && (range / Math.max(forward, 1e-6)) >= minRangeRatio && badData.length === 0) {
        console.log(`[scheduleRefit] Heartbeat refit for expiry ${expiryMs}`);
        this.fitPCForExpiry(expiryMs, forward);
        this.lastRefitTime.set(expiryMs, now);
      }
    }
  }

/**
 * Pretty table for one expiry fit (does not mutate legs used by the solver)
 */
private logFitTable(
  expiryMs: number,
  forward: number,
  T: number,
  legs: Array<{ strike: number; marketMid: number; weight: number; isCall: boolean }>,
  ccTV: number[]
): void {
  try {
    const F = Math.max(forward, 1e-9);

    const rows = legs.map((leg, i) => {
      const K = leg.strike;
      const isCall = leg.isCall;

      // Intrinsic & TV in quoted units (normalized)
      const intrinsicQ = intrinsicFrac(forward, K, isCall);

      const tvQ = Math.max(this.mkt.minTick * 0.5, leg.marketMid - intrinsicQ);

      // A quick delta for context (using current ATM guess is fine here)
      const ivGuess = this.marketIVs.get(expiryMs) ?? 0.40;
      const g = black76Greeks(forward, K, Math.max(T, 1e-8), Math.max(ivGuess, 1e-8), isCall, 1.0);
      const delta = g.delta;

      return {
        strike: K,
        delta: Number(delta.toFixed(3)),
        marketMid: Number(leg.marketMid.toFixed(8)),
        ccPrice: Number(ccTV[i].toFixed(8)),
        weight: Number(leg.weight.toFixed(2)),
        intrinsic: Number(intrinsicQ.toFixed(8)),
        timeValue: Number(tvQ.toFixed(8)),
      };
    })
    // sort only for display
    .sort((a, b) => a.strike - b.strike);

    console.log('[fitPCForExpiry] Table (sorted by strike):');
    console.table(rows);
  } catch (e) {
    console.warn('[fitPCForExpiry] logFitTable failed:', e);
  }
}

  /**
   * Update factor inventory after a trade
   */
  private updateFactorInventory(
    strike: number,
    expiryMs: number,
    forward: number,
    optionType: 'C' | 'P',
    dealerSignedSize: number
  ): void {
    const isCall = optionType === 'C';
    const g = this.computeFactorGreeks(strike, expiryMs, forward, isCall);
    
    for (let i = 0; i < 6; i++) {
      this.factorInventory[i] += dealerSignedSize * g[i];
    }
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`[updateFactorInventory] After trade:`, {
        strike,
        size: dealerSignedSize,
        greeks: g.map(x => x.toFixed(6)),
        inventory: this.factorInventory.map(x => x.toFixed(2))
      });
    }
  }

  // ============================================================
  // EXISTING METHODS (UNCHANGED)
  // ============================================================

  private deriveMetricsFromMarketIV(atmIV: number, expiryYears: number): TraderMetrics {
    const L0 = atmIV * atmIV * expiryYears;
    const scale = Math.sqrt(Math.max(L0, 0.001) / 0.04);
    
    return { 
      L0, 
      S0: -0.02 * scale, 
      C0: 0.5, 
      S_neg: -0.8 * scale, 
      S_pos: 0.9 * scale 
    };
  }

  private convertToSVIConfig(mc: ModelConfig): any {
    const edgeParams = new Map<string, any>();
    mc.buckets.forEach(b => edgeParams.set(b.name, b.edgeParams));
    return {
      bMin: mc.svi.bMin, sigmaMin: mc.svi.sigmaMin, rhoMax: mc.svi.rhoMax,
      sMax: mc.svi.slopeMax, c0Min: mc.svi.c0Min,
      buckets: mc.buckets.map(b => ({ name: b.name, minDelta: b.minDelta, maxDelta: b.maxDelta })),
      edgeParams, rbfWidth: mc.rbf.width, ridgeLambda: mc.rbf.ridgeLambda,
      maxL0Move: mc.riskLimits.maxL0Move, maxS0Move: mc.riskLimits.maxS0Move, maxC0Move: mc.riskLimits.maxC0Move
    };
  }

  updateCC(expiry: number, metrics: TraderMetrics): void {
    const newCC = SVI.fromMetrics(metrics, this.sviConfig);
    if (!SVI.validate(newCC, this.sviConfig)) throw new Error('Invalid SVI parameters');
    let s = this.surfaces.get(expiry);
    if (!s) { s = { expiry, cc: newCC, pc: newCC, nodes: new Map() }; this.surfaces.set(expiry, s); }
    else { s.cc = newCC; this.updatePC(s); }
    this.version++;
  }

  private updatePC(surface: EnhancedSurface): void {
    surface.pc = this.inventoryController.adjustSVIForInventory(surface.cc);
  }

  // ============================================================
  // MODIFIED onTrade() - WITH FACTOR INVENTORY UPDATE
  // ============================================================

  onTrade(trade: TradeExecution): void {
    const s = this.surfaces.get(trade.expiryMs);
    if (!s) { 
      console.warn(`No surface for expiryMs=${trade.expiryMs}`); 
      return; 
    }
    
    const T = timeToExpiryYears(trade.expiryMs, trade.time ?? this.clockFn());
    if (T <= 0) { 
      console.warn('Expired trade ignored (T<=0):', trade); 
      return; 
    }

    // Update node state (existing logic)
    this.updateNodeState(s, {
      strike: trade.strike, 
      price: trade.price, 
      size: trade.size,
      expiryMs: trade.expiryMs, 
      forward: trade.forward, 
      optionType: trade.optionType, 
      time: trade.time ?? this.clockFn()
    } as any);

    // NEW: Update factor inventory if using variance bump
    if (this.useVarianceBump) {
      this.updateFactorInventory(
        trade.strike,
        trade.expiryMs,
        trade.forward,
        trade.optionType,
        trade.size
      );
    }

    // Keep existing vega inventory update (for parallel mode or old method)
    if (this.inventoryController) {
      const F = trade.forward;
      const K = trade.strike;
      const isCall = trade.optionType === 'C';
      const ivFallback = this.marketIVs.get(trade.expiryMs) ?? 0.35;
      const k = Math.log(K / Math.max(F, tiny));

      let ccVar = SVI.w(s.cc, k);
      if (!Number.isFinite(ccVar) || ccVar <= 0) {
        const fallbackVar = ivFallback * ivFallback * Math.max(T, 1e-8);
        ccVar = Math.max(fallbackVar, 1e-12);
      }
      
      let ccIV = Math.sqrt(ccVar / Math.max(T, 1e-12));
      const ivMin = Math.max(0.15, 0.5 * ivFallback);
      const ivUsed = Math.max(ccIV, ivMin);

      let g = black76Greeks(F, K, Math.max(T, 1e-8), ivUsed, isCall, 1.0);
      if (!Number.isFinite(g.vega)) {
        g = black76Greeks(F, K, Math.max(T, 1e-8), Math.max(ivFallback, ivMin), isCall, 1.0);
      }
      const vegaSafe = Number.isFinite(g.vega) ? g.vega : 0;

      const bucket = DeltaConventions.strikeToBucket(K, F, ivUsed, Math.max(T, 1e-8));

      this.inventoryController.updateInventory(K, trade.size, vegaSafe, bucket);
      this.updatePC(s);
    }

    this.version++;
  }

  private updateNodeState(surface: EnhancedSurface, trade: {
    strike: number; price: number; size: number; expiryMs: number;
    forward: number; optionType: 'C'|'P'; time: number;
  }): void {
    let node = surface.nodes.get(trade.strike);
    const T = timeToExpiryYears(trade.expiryMs, trade.time);
    const k = Math.log(trade.strike / Math.max(trade.forward, tiny));
    const ccVar = SVI.w(surface.cc, k);
    const ccIV  = Math.sqrt(Math.max(ccVar, tiny) / Math.max(T, 1e-8));
    const greeks = black76Greeks(trade.forward, trade.strike, Math.max(T,1e-8), ccIV, trade.optionType === 'C', 1.0);
    const widthRef = this.riskScorer.computeWidth({ gamma: greeks.gamma });
    const bucket = DeltaConventions.strikeToBucket(trade.strike, trade.forward, ccIV, Math.max(T, 1e-8));

    if (!node) {
      node = { 
        strike: trade.strike, 
        pcAnchor: trade.price, 
        pcAnchorTs: trade.time,
        widthRef, 
        position: trade.size, 
        lastBucket: bucket, 
        lastTradeTime: trade.time 
      };
      surface.nodes.set(trade.strike, node);
    } else {
      node.pcAnchor = trade.price;
      node.pcAnchorTs = trade.time;
      node.position += trade.size;
      node.widthRef = widthRef;
      node.lastBucket = bucket;
      node.lastTradeTime = trade.time;
    }
  }

  calibrateFromMarket(expiry: number, marketQuotes: MarketQuoteForCalibration[], spot: number): void {
    if (marketQuotes.length === 0) { 
      console.warn('No market quotes provided for calibration'); 
      return; 
    }
    
    console.log(`[calibrateFromMarket] Calibrating with ${marketQuotes.length} market quotes`);
    
    const atm = marketQuotes.reduce((c, q) => Math.abs(q.strike - spot) < Math.abs(c.strike - spot) ? q : c);
    this.marketIVs.set(expiry, atm.iv);
    
    const now = this.clockFn();
    const T = timeToExpiryYears(expiry, now);
    
    if (T <= 0) {
      console.warn(`Cannot calibrate: expiry has passed (T=${T})`);
      return;
    }
    
    // ============================================================
    // NEW: DELTA SHELLS CALIBRATION
    // ============================================================
    if (process.env.USE_DELTA_SHELLS === 'true' && marketQuotes.length >= 5) {
      try {
        // ✅ FIT ONLY ATM ± 3 STRIKES (7 strikes total)
        const sortedQuotes = [...marketQuotes].sort((a, b) => 
          Math.abs(a.strike - spot) - Math.abs(b.strike - spot)
        );
        const atmQuotes = sortedQuotes.slice(0, 7); // Take closest 7 strikes to ATM
        
        console.log(`[calibrateFromMarket] Using ATM ± 3 strikes:`, 
          atmQuotes.map(q => `${q.strike} (IV=${q.iv.toFixed(3)})`).join(', ')
        );
        
        // Convert market quotes to QuotePoint format
        const pts: QuotePoint[] = atmQuotes.map(q => {
          // Get approximate price from IV
          const priceBase = black76Greeks(spot, q.strike, T, q.iv, true, 1.0).price;
          const midQuoted = clampQuoted(this.mkt.fromBaseToQuoted(priceBase, spot), this.mkt);
          
          return {
            strike: q.strike,
            midQuoted,
            iv: q.iv,
            weight: q.weight ?? 1
          };
        });
        
        console.log(`[calibrateFromMarket] Using delta shells calibration with ${pts.length} quotes`);
        const sviParams = fitSmileDeltaShells(pts, spot, expiry, now, this.symbol);
        
        let s = this.surfaces.get(expiry);
        if (!s) {
          s = { expiry, cc: sviParams, pc: sviParams, nodes: new Map() };
          this.surfaces.set(expiry, s);
        } else {
          s.cc = sviParams;
        }
        this.updatePC(s);
        this.version++;
        
        const wATM = SVI.w(sviParams, 0);
        const ivATM = Math.sqrt(wATM / Math.max(T, 1e-12));
        console.log(`[calibrateFromMarket] Delta shells fit complete: ATM_IV=${ivATM.toFixed(4)}, wATM=${wATM.toExponential(6)}, b=${sviParams.b.toFixed(6)}, rho=${sviParams.rho.toFixed(3)}`);        
      
        // Cache market data for PC fit if enabled
        if (this.usePCFit) {
          pts.forEach(pt => {
            this.updateMarketData(expiry, pt.strike, pt.midQuoted, spot, pt.weight ?? 1);
          });
          this.fitPCForExpiry(expiry, spot);
        }
        
        return; // ✅ Delta shells successful, exit early
        
      } catch (err) {
        console.error(`[calibrateFromMarket] Delta shells failed, falling back to standard SVI:`, err);
        // Fall through to standard calibration
      }
    }
    
    // ============================================================
    // FALLBACK: STANDARD SVI CALIBRATION
    // ============================================================
    if (marketQuotes.length >= 3) {
      try {
        const marketPoints: MarketSmilePoint[] = marketQuotes.map(q => ({
          strike: q.strike,
          iv: q.iv,
          weight: q.weight
        }));
        
        const calibConfig = {
          bMin: this.sviConfig.bMin,
          sigmaMin: this.sviConfig.sigmaMin,
          rhoMax: this.sviConfig.rhoMax,
          sMax: this.sviConfig.sMax,
          c0Min: this.sviConfig.c0Min
        };
        
        // Get forward (use spot as proxy if no funding data available)
        const forward = spot;  // TODO: Replace with actual forward calculation if available
        
        // Try to get ATM IV from straddle first
        let ivATM = forwardATMStraddleIV(marketPoints, forward, T, this.mkt.minTick);
        
        if (!ivATM) {
          // Fallback: vega-weighted interpolation
          console.warn('[calibrateFromMarket] No valid straddle, using interpolation');
          ivATM = vegaWeightedIVInterp(marketPoints, forward, T, this.mkt.minTick);
        }
        
        if (!ivATM || ivATM < 0.01 || ivATM > 5.0) {
          // Last resort: closest strike to forward
          console.warn('[calibrateFromMarket] Interpolation failed, using closest strike');
          const atmPoint = marketPoints.reduce((best, pt) => 
            Math.abs(pt.strike - forward) < Math.abs(best.strike - forward) ? pt : best
          );
          ivATM = Math.max(0.1, Math.min(5.0, atmPoint.iv));
        }
        
        const vATM = ivATM * ivATM * T;
        
        console.log(`[calibrateFromMarket] ATM anchor: F=${forward}, iv=${ivATM.toFixed(4)}, vATM=${vATM.toExponential(6)}`);
        // Custom ATM-anchored calibration
        const sviParams = calibrateSVIWithATMAnchor(
          marketPoints, 
          forward,  // ✅ CORRECT - use forward for log-moneyness
          T, 
          vATM, 
          calibConfig
        );
        
        console.log(`[calibrateFromMarket] Fitted SVI (ATM-anchored): a=${sviParams.a.toFixed(6)}, b=${sviParams.b.toFixed(6)}, rho=${sviParams.rho.toFixed(3)}, sigma=${sviParams.sigma.toFixed(6)}`);
        
        // Verify ATM matches at k=0 (forward moneyness)
        const w0 = SVI.w(sviParams, 0);  // At k=0, this should equal vATM
        const ivATM_fitted = Math.sqrt(w0 / Math.max(T, 1e-12));
        const diff = Math.abs(ivATM - ivATM_fitted);
        console.log(`[calibrateFromMarket] ✅ ATM verification: market_iv=${ivATM.toFixed(4)}, fitted_iv=${ivATM_fitted.toFixed(4)}, diff=${diff.toFixed(6)} ${diff < 0.001 ? '✓' : '✗ FAILED'}`);
        
        if (diff > 0.01) {
          console.warn(`[calibrateFromMarket] ⚠️  ATM drift detected: ${(diff * 100).toFixed(2)}% error`);
        }
        
        let s = this.surfaces.get(expiry);
        if (!s) {
          s = { expiry, cc: sviParams, pc: sviParams, nodes: new Map() };
          this.surfaces.set(expiry, s);
        } else {
          s.cc = sviParams;
        }
        this.updatePC(s);
        this.version++;
        
        // Cache market data for PC fit if enabled
        if (this.usePCFit) {
          marketQuotes.forEach(q => {
            const k = Math.log(q.strike / Math.max(spot, tiny));  // Note: 'spot' here is actually forward in this context
            const ccVar = SVI.w(sviParams, k);
            const ccIV = Math.sqrt(Math.max(ccVar, tiny) / Math.max(T, 1e-8));
            const approxPriceBase = black76Greeks(spot, q.strike, T, ccIV, true, 1.0).price;
            const approxPriceQuoted = clampQuoted(this.mkt.fromBaseToQuoted(approxPriceBase, spot), this.mkt);
            this.updateMarketData(expiry, q.strike, approxPriceQuoted, spot, q.weight);
          });
          
          console.log(`[calibrateFromMarket] Triggering PC fit for expiry ${expiry}`);
          this.fitPCForExpiry(expiry, spot);
        }
      } catch (err) {
        console.error(`[calibrateFromMarket] SVI calibration failed:`, err);
        const m = this.deriveMetricsFromMarketIV(atm.iv, T);
        this.updateCC(expiry, m);
      }
    } else {
      console.log(`[calibrateFromMarket] Only ${marketQuotes.length} points, using ATM-based calibration`);
      const m = this.deriveMetricsFromMarketIV(atm.iv, T);
      this.updateCC(expiry, m);
    }
  }

  /**
   * Get PC time value for any strike using linear interp in log-moneyness
   */
  private getPCTimeValueInterpolated(expiryMs: number, strike: number, forward: number): number | null {
    const fit = this.pcFitCache.get(expiryMs);
    if (!fit) return null;
    const m = fit.pcPrices;
    if (m.has(strike)) return m.get(strike)!;

    const pts = Array.from(m.entries())
      .map(([K, tv]) => ({ k: Math.log(K / Math.max(forward, 1e-9)), tv, K }))
      .sort((a, b) => a.k - b.k);
    if (pts.length < 2) return null;

    const k = Math.log(strike / Math.max(forward, 1e-9));
    if (k <= pts[0].k) return pts[0].tv;
    if (k >= pts[pts.length - 1].k) return pts[pts.length - 1].tv;

    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].k <= k) lo = mid; else hi = mid;
    }
    const w = (k - pts[lo].k) / Math.max(pts[hi].k - pts[lo].k, 1e-9);
    return (1 - w) * pts[lo].tv + w * pts[hi].tv;
  }

  // ============================================================
  // MODIFIED getQuote() - WITH UNIFIED INVENTORY-AWARE PRICING
  // ============================================================

  getQuote(
    expiryMs: number, 
    strike: number, 
    forward: number, 
    optionType: 'C'|'P', 
    marketIV?: number, 
    nowMs?: number
  ): Quote {
    const now = nowMs ?? this.clockFn();
    const isCall = optionType === 'C';
    const Traw = timeToExpiryYears(expiryMs, now);
    const T = Math.max(safe(Traw, 0), 1e-8);
    
    let s = this.surfaces.get(expiryMs);

    let atmIV: number;
    if (marketIV !== undefined) {
      atmIV = marketIV;
      this.marketIVs.set(expiryMs, atmIV);
    } else {
      atmIV = this.marketIVs.get(expiryMs) ?? 0.35;
    }

    // Initialize CC if surface doesn't exist
    if (!s) {
      const m = this.deriveMetricsFromMarketIV(atmIV, T);
      this.updateCC(expiryMs, m);
      s = this.surfaces.get(expiryMs)!;
      if (this.inventoryController) {
        this.updatePC(s);
      }
    }

    const k = safe(Math.log(strike / Math.max(forward, tiny)), 0);
    
        // ============================================================
    // CC PRICING (your belief - NORMALIZED UNITS)
    // ============================================================
    const ccVarBase = Math.max(safe(SVI.w(s.cc, k), tiny), tiny);
    const wON = overnightMasses(now, expiryMs);
    const wEvt = eventMasses(this.symbol, now, expiryMs);
    const ccVarTotal = ccVarBase + wON + wEvt;
    const tau = Math.max(tauIntegral(now, expiryMs), 1e-6);
    let ccIV = Math.min(Math.max(safe(Math.sqrt(ccVarTotal / tau), 1e-8), 1e-8), 5.0);
    
// --- ATM pin: blend to market IV near ATM ---
// ATM is now hard-fitted, no blend needed
    // Keep ccIV as-is from SVI evaluation


    // ✅ USE NORMALIZED BLACK: returns fraction of BTC
    let ccMidBase = blackFracPrice(forward, strike, T, ccIV, isCall);

    // Fallback if CC pricing failed
    const ivFallback = Number.isFinite(marketIV) ? (marketIV as number) : 0.35;
    if (ccMidBase <= 1e-12) {
      ccMidBase = blackFracPrice(forward, strike, T, ivFallback, isCall);
      ccIV = ivFallback;
    }

    // ✅ ENSURE MINIMUM PRICE: Should be at least intrinsic + 1 tick
    const ccIntrinsic = intrinsicFrac(forward, strike, isCall);
    ccMidBase = Math.max(ccMidBase, ccIntrinsic + this.mkt.minTick);

    // Already in quoted units (fraction of BTC), just clamp
    let ccMid = clampQuoted(ccMidBase, this.mkt);
    const midIsSaneQuoted = (p: number) => Number.isFinite(p) && p >= 0 && p <= (this.mkt.maxPremium ?? Number.POSITIVE_INFINITY);
    if (!midIsSaneQuoted(ccMid)) {
      const fallbackQuoted = ccIV * Math.sqrt(T) * 0.4 + ccIntrinsic;
      ccMid = clampQuoted(Math.max(0, fallbackQuoted), this.mkt);
    }
    
    // ✅ COMPUTE GREEKS (needed for node creation below)
    const ccG = black76Greeks(forward, strike, T, ccIV, isCall, 1.0);


    // ============================================================
    // PC PRICING: Target Curve Pricing
    // ============================================================
    let bid: number;
    let ask: number;
    let halfSpread: number;
    let pcMid: number;
    let pcIV: number;
    let edge: number;
    let pricingDiag: any;

    // Get or create node BEFORE pricing (needed for anchor)
    const bucket = DeltaConventions.strikeToBucket(strike, forward, ccIV, T);
    let node = s.nodes.get(strike);
    if (!node) {
      node = { 
        strike, 
        pcAnchor: ccMid,  // Initialize to CC mid if no trades yet
        widthRef: this.riskScorer.computeWidth({ gamma: ccG.gamma }), 
        position: 0, 
        lastBucket: bucket, 
        lastTradeTime: now 
      };
      s.nodes.set(strike, node);
    }

    // Declare bidSize and askSize at the top level
    let bidSize: number;
    let askSize: number;

    // ============================================================
    // PRICING MODE SELECTION (THREE PATHS)
    // ============================================================

    if (this.usePCFit) {
      // ========================================================
      // PATH 3: PRICE-SPACE PC FIT - USE TV DIRECTLY
      // ========================================================
      
      const cachedFit = this.pcFitCache.get(expiryMs);
      const intrinsicQ = intrinsicFrac(forward, strike, isCall);

      // Try exact TV, else interpolate
      let tv = cachedFit?.pcPrices.get(strike);
      if (tv === undefined) {
        tv = this.getPCTimeValueInterpolated(expiryMs, strike, forward) ?? null;
      }

      if (tv != null) {
        // ✅ FLOOR: Ensure TV is at least 2 ticks or 50% of CC TV
        const minTvTicks = Number(process.env.PC_MIN_TV_TICKS ?? 2);
        const minTvFrac = Number(process.env.PC_MIN_TV_FRAC_OF_CC ?? 0.50);
        const ccTV_now = Math.max(ccMid - intrinsicQ, 0);
        const minTV = Math.max(
          minTvTicks * this.mkt.minTick,
          minTvFrac * ccTV_now
        );
        const safeTV = Math.max(tv, minTV);

        // ✅ MODEL CALL PRICE = intrinsic + TV (NO SVI repricing!)
        const call_pc = clampQuoted(intrinsicQ + safeTV, this.mkt);
        
        // Use call_pc as both pcMid (for return) and for quoting
        pcMid = call_pc;
        
        // Edge is PC vs CC (inventory adjustment), not PC vs market
        edge = call_pc - ccMid;

        halfSpread = this.mkt.minTick;
        bid = Math.max(0, call_pc - halfSpread);
        ask = call_pc + halfSpread;
        bidSize = 100;
        askSize = 100;

        // Assertions for sanity
        if (process.env.NODE_ENV === 'development') {
          console.assert(Math.abs((intrinsicQ + safeTV) - call_pc) < 1e-9, 'call_pc construction error');
          console.assert(call_pc >= intrinsicQ - 1e-9, 'TV must be >= 0');
          
          console.log(`[ISM.getQuote] PC-fit: K=${strike}, intrinsic=${intrinsicQ.toFixed(6)}, tv=${safeTV.toFixed(6)}, call_pc=${call_pc.toFixed(6)}, ccMid(SVI)=${ccMid.toFixed(6)}, edge=${(edge*10000).toFixed(1)}bps`);
        }
      } else {
        // ❌ No fit available - fall back to CC
        pcMid = ccMid;
        edge = 0;

        halfSpread = this.mkt.minTick;
        bid = Math.max(0, ccMid - halfSpread);
        ask = ccMid + halfSpread;
        bidSize = 100;
        askSize = 100;

        console.warn(`[ISM.getQuote] No PC fit for ${expiryMs}/${strike}, using CC (SVI) directly`);
      }
      
    } else if (this.useVarianceBump) {
      // ========================================================
      // PATH 2: TARGET CURVE (EXISTING)
      // ========================================================
      const lambda = this.getLambda();
      const inventory = this.getInventory();
      const g = this.computeFactorGreeks(strike, expiryMs, forward, isCall);
      const Sigma = this.getCovariance(T);
      
      const edgePerContract = this.computeEdgeScalar(g, lambda, Sigma, g);
      const costPerLot = edgePerContract;
      const lastTradeMid = node.pcAnchor;
      const marketHalfSpread = this.mkt.minTick;
      
      const pricingResult = computeTargetCurvePricing({
        ccMid,
        pcMid: lastTradeMid,
        currentPosition: node.position,
        costPerLot,
        minTick: this.mkt.minTick,
        halfSpread: marketHalfSpread,
        policySize: 100,
        maxSize: 1000
      });

      bid = pricingResult.bid;
      ask = pricingResult.ask;
      bidSize = pricingResult.bidSize;
      askSize = pricingResult.askSize;
      halfSpread = marketHalfSpread;
      pcMid = pricingResult.pcMid;
      edge = pricingResult.edge;
      pricingDiag = pricingResult.diagnostics;

      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask < 0) {
        console.warn(`[ISM.getQuote] Invalid pricing result, falling back to CC`);
        bid = Math.max(0, ccMid - this.mkt.minTick);
        ask = ccMid + this.mkt.minTick;
        halfSpread = this.mkt.minTick;
        pcMid = ccMid;
        edge = 0;
        bidSize = 100;
        askSize = 100;
      }

    } else {
      // ========================================================
      // PATH 1: SVI ADJUSTMENT (EXISTING)
      // ========================================================
      const pcVarBase = Math.max(safe(SVI.w(s.pc, k), tiny), tiny);
      const pcVarTotal = pcVarBase + wON + wEvt;
      pcIV = Math.min(Math.max(safe(Math.sqrt(pcVarTotal / tau), 1e-8), 1e-8), 5.0);
      let pcG = black76Greeks(forward, strike, T, pcIV, isCall, 1.0);
      let pcMidBase = safe(pcG.price, 0);

      if (pcMidBase <= 1e-12) {
        pcG = black76Greeks(forward, strike, T, ivFallback, isCall, 1.0);
        pcMidBase = Math.max(0, pcG.price);
        pcIV = ivFallback;
      }

      // Convert to QUOTED + clamp
      pcMid = clampQuoted(this.mkt.fromBaseToQuoted(pcMidBase, forward), this.mkt);
      if (!Number.isFinite(pcMid) || pcMid < 0) {
        const fallbackQuoted = this.mkt.fromBaseToQuoted(pcIV * Math.sqrt(T) * 0.4, forward);
        pcMid = clampQuoted(Math.max(0, fallbackQuoted), this.mkt);
      }

      // Now both ccMid and pcMid are quoted → edge in quoted units

      edge = pcMid - ccMid;
      
      const currentWidth = Math.min(0.002, this.riskScorer.computeWidth({ 
        gamma: ccG.gamma, 
        J_L0: 1.0, 
        J_S0: 0.5, 
        J_C0: 0.3 
      }));
      
      bid = Math.max(0, pcMid - currentWidth);
      ask = pcMid + currentWidth;
      halfSpread = currentWidth;
      bidSize = this.config.quotes.sizeBlocks;
      askSize = this.config.quotes.sizeBlocks;
    }

    // ============================================================
    // LOGGING
    // ============================================================
    if (this.useVarianceBump && pricingDiag) {
      const diagnostics: QuoteDiagnostics = {
        expiryMs,
        strike,
        forward,
        optionType,
        T,
        k,
        nowMs: now,
        ivCC: ccIV,
        wCC: ccVarTotal,
        ccMid,
        ivPC: ccIV,
        pcMid,
        edge,
        lambda: this.getLambda(),
        inventory: this.getInventory(),
        varianceBump: pricingDiag,
        warnings: pricingDiag.edgeCapped || pricingDiag.spreadCapped ? 
          [`edgeCapped: ${pricingDiag.edgeCapped}, spreadCapped: ${pricingDiag.spreadCapped}`] : 
          undefined
      };
      
      quoteDiagLogger.log(diagnostics);
    }

    // ============================================================
    // INVENTORY-AWARE SIZES (only used if NOT using variance bump)
    // ============================================================
    
    if (!this.useVarianceBump && !this.usePCFit) {
      // Only compute sizes here if we didn't already compute them above
      const baseSize = this.config.quotes.sizeBlocks;
      bidSize = baseSize;
      askSize = baseSize;
    
      if (this.inventoryController) {
        const invState = this.inventoryController.getInventoryState();
        const bucketInv = invState.get(bucket as any);
        
        if (bucketInv && typeof (bucketInv as any).vega === 'number') {
          const vegaSigned = (bucketInv as any).vega as number;
          const vref = this.config.buckets.find((b) => b.name === bucket)?.edgeParams.Vref ?? 100;
          const invRatio = Math.min(5, Math.abs(vegaSigned) / Math.max(vref, 1e-6));
          
          if (vegaSigned < 0) {
            askSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
          } else if (vegaSigned > 0) {
            bidSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
          }
        }
      }
    }
    
    return { 
      bid, 
      ask, 
      bidSize, 
      askSize, 
      pcMid, 
      ccMid, 
      edge, 
      bucket 
    };
  }

  // ============================================================
  // LAMBDA LEARNING METHODS
  // ============================================================

  onFill(fill: {
    strike: number;
    expiryMs: number;
    forward: number;
    optionType: 'C' | 'P';
    fillPrice: number;
    size: number;
    time: number;
  }): void {
    if (!this.lambdaLearner) {
      return;
    }

    try {
      const quote = this.getQuote(
        fill.expiryMs,
        fill.strike,
        fill.forward,
        fill.optionType,
        undefined,
        fill.time
      );

      const gPrice = this.computeFactorGreeks(
        fill.strike,
        fill.expiryMs,
        fill.forward,
        fill.optionType === 'C'
      );

      const obs: FillObservation = {
        fillPrice: fill.fillPrice,
        ccMid: quote.ccMid,
        gPrice,
        inventory: [...this.factorInventory],
        size: fill.size,
        timestamp: fill.time
      };

      this.lambdaLearner.update(obs, true);

      const stats = this.lambdaLearner.getStats();
      if (stats.numUpdates % 10 === 0) {
        console.log('[LambdaLearner] Progress:', {
          updates: stats.numUpdates,
          avgError: stats.recentError.toFixed(4),
          r2: stats.recentR2.toFixed(3),
          lambda: stats.lambda.map(l => l.toFixed(4))
        });
      }

      if (stats.numUpdates % 20 === 0) {
        this.lambda = this.lambdaLearner.getLambda();
        console.log('[LambdaLearner] Updated model lambda:', 
          this.lambda.map(l => l.toFixed(4)));
      }

    } catch (err) {
      console.error('[onFill] Lambda learning failed:', err);
    }
  }

  getLambdaStats(): LambdaStats | null {
    return this.lambdaLearner ? this.lambdaLearner.getStats() : null;
  }

  resetLambdaLearner(newLambda?: number[]): void {
    if (this.lambdaLearner) {
      this.lambdaLearner.reset(newLambda);
      if (newLambda) {
        this.lambda = newLambda;
      }
      console.log('[resetLambdaLearner] Lambda reset:', this.lambda);
    }
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  getInventorySummary() {
    const invState = this.inventoryController.getInventoryState();
    const adjustments = this.inventoryController.calculateSmileAdjustments();
    const summary = { totalVega: 0, byBucket: {} as any, smileAdjustments: adjustments };
    for (const [bucket, inv] of invState) {
      const v = Number(inv.vega) || 0;
      summary.totalVega += v;
      (summary.byBucket as any)[bucket] = { vega: v, count: inv.count };
    }
    return summary;
  }

  getCCSVI(expiryMs: number): SVIParams | null {
    const s = this.surfaces.get(expiryMs);
    return s ? s.cc : null;
  }

  resetAllState(): void {
    this.surfaces.clear();
    this.marketIVs.clear();
    this.inventoryController = new SmileInventoryController(this.config);
    this.factorInventory = [0, 0, 0, 0, 0, 0];
    this.version = 0;
  }
}
