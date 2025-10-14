/**
 * Integrated Dual Surface Model with Market Calibration
 * Convention: TradeExecution.size is **DEALER-signed**
 *   - Customer BUY  => dealer SELL  => size = -|q|
 *   - Customer SELL => dealer BUY   => size = +|q|
 */
import {
  SVIParams, TraderMetrics, NodeState, SVI, RiskScorer
} from './dualSurfaceModel';
import { ModelConfig, getDefaultConfig } from './config/modelConfig';
import { SmileInventoryController } from './smileInventoryController';
import { DeltaConventions } from './pricing/blackScholes';
import { black76Greeks } from "../risk";
import { overnightMasses } from "../pricing/seasonality";
import { eventMasses } from "../pricing/eventTable";
import { timeToExpiryYears } from "../utils/time";
import { calibrateSVI, MarketSmilePoint } from "./sviCalibration";
import { totalVariance } from "../pricing/totalVariance";
import { tauIntegral } from "../pricing/seasonality";
import { factorGreeksFiniteDiff } from './factors/factorGreeks';
import { 
  computeVarianceBump, 
  validateVarianceBump,
  type VarianceBumpParams,
  type VarianceBumpResult 
} from './inventory/varianceBump';

import { 
  quoteDiagLogger, 
  type QuoteDiagnostics 
} from './inventory/quoteDiagnostics';

import { 
  LambdaLearner, 
  LambdaLearnerFactory,
  type FillObservation,
  type LambdaStats
} from './inventory/lambdaLearner';

import { 
  computeInventoryAwarePricing,
  type InventoryPricingInput,
  type InventoryPricingOutput 
} from './inventory/inventoryPricing';

import { 
  computeTargetCurvePricing,
  type TargetCurvePricingInput,
  type TargetCurvePricingOutput 
} from './inventory/targetCurvePricing';

import { fitPC } from '../calibration/fitPC';
import { buildDeltaAnchoredBasis } from '../risk/factors/buildDeltaAnchoredBasis';

const tiny = 1e-12;
const safe = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);

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

  constructor(product: 'BTC'|'ETH'|'SPX' = 'BTC', clockFn?: () => number) {
    this.symbol = product;
    this.config = getDefaultConfig(product);
    this.sviConfig = this.convertToSVIConfig(this.config);
    this.inventoryController = new SmileInventoryController(this.config);
    this.riskScorer = new RiskScorer();
    if (clockFn) this.clockFn = clockFn;
    
    // Initialize from environment
    this.parallelMode = process.env.PARALLEL_MODE === 'true';
    this.useVarianceBump = process.env.USE_VARIANCE_BUMP === 'true';
    this.usePCFit = process.env.USE_PC_FIT === 'true';
    
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
    
    // Build legs array for fitPC
    const legs = marketData.map(md => {
      const strike = md.strike;
      const k = Math.log(strike / Math.max(forward, tiny));
      
      // Get CC price
      const ccVarBase = Math.max(safe(SVI.w(s.cc, k), tiny), tiny);
      const wON = overnightMasses(now, expiryMs);
      const wEvt = eventMasses(this.symbol, now, expiryMs);
      const ccVarTotal = ccVarBase + wON + wEvt;
      const tau = Math.max(tauIntegral(now, expiryMs), 1e-6);
      const ccIV = Math.min(Math.max(safe(Math.sqrt(ccVarTotal / tau), 1e-8), 1e-8), 5.0);
      
      // Determine option type (assume calls for now, or use heuristic)
      const isCall = strike >= forward;
      
      return {
        strike,
        K: strike,
        T,
        F: forward,
        isCall,
        marketMid: md.marketMid,
        weight: md.weight
      };
    });
    
    // Get CC prices
    const ccPrices = legs.map(leg => {
      const ccG = black76Greeks(leg.F, leg.strike, leg.T, 
        this.marketIVs.get(expiryMs) ?? 0.35, leg.isCall, 1.0);
      return ccG.price;
    });
    
    // Build delta-anchored basis
    const atmIV = this.marketIVs.get(expiryMs) ?? 0.65;
    const basis = buildDeltaAnchoredBasis(legs, forward, T, atmIV);
    
    console.log(`[fitPCForExpiry] Built delta-anchored basis:`, {
      expiry: expiryMs,
      factors: basis.names,
      numLegs: legs.length
    });
    
    // Diagnostic logging
    console.log('[fitPCForExpiry] Input validation:', {
      numLegs: legs.length,
      marketMids: legs.map(l => l.marketMid.toFixed(6)),
      ccPrices: ccPrices.map(p => p.toFixed(6)),
      weights: legs.map(l => l.weight.toFixed(2))
    });

    // Call fitPC
    // Scale caps by sqrt(T) - shorter dates need tighter caps
    const capScale = Math.min(1.0, Math.sqrt(T) * 2);
    const fitResult = fitPC({
    legs,
    ccPrices,
    factorGreeks: basis.Phi,
    ridge: 1e-4,
    thetaMax: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01].map(c => c * capScale)
});
    
    // Cache result
    const pcPrices = new Map<number, number>();
    legs.forEach((leg, i) => {
      pcPrices.set(leg.strike, fitResult.pcPrices[i]);
    });
    
    this.pcFitCache.set(expiryMs, {
      theta: fitResult.theta,
      pcPrices,
      timestamp: now,
      rmse: fitResult.rmse
    });
    
    console.log(`[fitPCForExpiry] Fitted expiry ${expiryMs}:`, {
      numLegs: legs.length,
      factors: basis.names,
      theta: fitResult.theta.map(t => t.toFixed(6)),
      rmse: fitResult.rmse.toFixed(6),
      within1Tick: (fitResult.within1TickPct * 100).toFixed(1) + '%',
      noArbViolations: fitResult.noArbViolations.length,
      shrink: fitResult.shrinkApplied.toFixed(3)
    });
  }
  
  /**
   * Update market data cache for batch fitting
   * Call this when you receive market quotes
   */
  updateMarketData(expiryMs: number, strike: number, marketMid: number, forward: number, weight: number = 1.0): void {
    if (!this.marketDataCache.has(expiryMs)) {
      this.marketDataCache.set(expiryMs, []);
    }
    
    const cache = this.marketDataCache.get(expiryMs)!;
    
    // Update or add
    const existing = cache.findIndex(md => md.strike === strike);
    if (existing >= 0) {
      cache[existing] = { strike, marketMid, weight };
    } else {
      cache.push({ strike, marketMid, weight });
    }
    
    // Trigger debounced refit
    if (this.usePCFit) {
      this.scheduleRefit(expiryMs, forward);  // Use actual forward!
    }
  }

  /**
 * Debounced refit trigger
 */
  private scheduleRefit(expiryMs: number, forward: number): void {
    const now = this.clockFn();
    const lastRefit = this.lastRefitTime.get(expiryMs) || 0;
    
    // NEW: Check if SVI surface exists first
    const surface = this.surfaces.get(expiryMs);
    if (!surface || !surface.cc) {
      console.log(`[scheduleRefit] No SVI surface for ${expiryMs}, skipping refit`);
      return;
    }
    
    // Clear existing timer
    const existing = this.refitTimers.get(expiryMs);
    if (existing) {
      clearTimeout(existing);
    }
    
    // Validate data quality
    const dataCache = this.marketDataCache.get(expiryMs);
    if (!dataCache || dataCache.length < 15) {
      return;  // Not enough data
    }
    
    // Check strike range
    const strikes = dataCache.map(d => d.strike).sort((a, b) => a - b);
    const minStrike = strikes[0];
    const maxStrike = strikes[strikes.length - 1];
    const range = maxStrike - minStrike;
    
    if (range < 30000) {
      console.log(`[scheduleRefit] Strike range too narrow (${range}), waiting...`);
      return;
    }
    
    // NEW: Validate prices are reasonable
    const badData = dataCache.filter(d => 
      !Number.isFinite(d.marketMid) || 
      d.marketMid <= 0 || 
      d.marketMid > forward ||  // Option can't be worth more than spot
      d.weight <= 0 ||
      !Number.isFinite(d.weight)
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
      
      if (dataCache.length >= 15 && range >= 30000 && badData.length === 0) {
        console.log(`[scheduleRefit] Heartbeat refit for expiry ${expiryMs}`);
        this.fitPCForExpiry(expiryMs, forward);
        this.lastRefitTime.set(expiryMs, now);
      }
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
        
        const sviParams = calibrateSVI(marketPoints, spot, T, calibConfig);
        if (sviParams.sigma < calibConfig.sigmaMin) {
          console.log(`[calibrateFromMarket] sigma=${sviParams.sigma.toFixed(6)} below minimum, adjusting to ${calibConfig.sigmaMin}`);
          sviParams.sigma = calibConfig.sigmaMin;
        }
        console.log(`[calibrateFromMarket] Fitted SVI: a=${sviParams.a.toFixed(6)}, b=${sviParams.b.toFixed(6)}, rho=${sviParams.rho.toFixed(3)}, sigma=${sviParams.sigma.toFixed(6)}`);
        
        let s = this.surfaces.get(expiry);
        if (!s) {
          s = { expiry, cc: sviParams, pc: sviParams, nodes: new Map() };
          this.surfaces.set(expiry, s);
        } else {
          s.cc = sviParams;
        }
        this.updatePC(s);
        this.version++;
        
        // Cache market data for PC fit
        if (this.usePCFit) {
          marketQuotes.forEach(q => {
            const weight = q.weight ?? 1.0;
            // Convert IV to approximate price for caching
            const k = Math.log(q.strike / Math.max(spot, tiny));
            const ccVar = SVI.w(sviParams, k);
            const ccIV = Math.sqrt(Math.max(ccVar, tiny) / Math.max(T, 1e-8));
            const approxPrice = black76Greeks(spot, q.strike, T, ccIV, q.strike >= spot, 1.0).price;
            
            this.updateMarketData(expiry, q.strike, approxPrice, weight);
          });
          
          // Trigger PC fit for this expiry
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
    // CC PRICING (unchanged - your belief)
    // ============================================================
    const ccVarBase = Math.max(safe(SVI.w(s.cc, k), tiny), tiny);
    const wON = overnightMasses(now, expiryMs);
    const wEvt = eventMasses(this.symbol, now, expiryMs);
    const ccVarTotal = ccVarBase + wON + wEvt;
    const tau = Math.max(tauIntegral(now, expiryMs), 1e-6);
    let ccIV = Math.min(Math.max(safe(Math.sqrt(ccVarTotal / tau), 1e-8), 1e-8), 5.0);
    let ccG = black76Greeks(forward, strike, T, ccIV, isCall, 1.0);
    let ccMid = safe(ccG.price, 0);

    // Fallback if CC pricing failed
    const ivFallback = Number.isFinite(marketIV) ? (marketIV as number) : 0.35;
    if (ccMid <= 1e-12) { 
      ccG = black76Greeks(forward, strike, T, ivFallback, isCall, 1.0); 
      ccMid = Math.max(0, ccG.price); 
      ccIV = ivFallback; 
    }

    // Final sanity check on ccMid
    const midIsSane = (p: number) => Number.isFinite(p) && p >= 0 && p <= Math.max(forward, strike) * 2;
    if (!midIsSane(ccMid)) {
      ccMid = Math.max(0, ccIV * Math.sqrt(T) * 0.4);
    }

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
      // PATH 3: PRICE-SPACE PC FIT (NEW!)
      // ========================================================
      
      const cachedFit = this.pcFitCache.get(expiryMs);
      
      if (cachedFit && cachedFit.pcPrices.has(strike)) {
        // ✅ Use fitted PC price from cache
        pcMid = cachedFit.pcPrices.get(strike)!;
        edge = pcMid - ccMid;
        halfSpread = 0.0001;
        bid = Math.max(0, pcMid - halfSpread);
        ask = pcMid + halfSpread;
        bidSize = 100;
        askSize = 100;
        
        console.log(`[ISM.getQuote] PC-fit: strike=${strike}, pcMid=${pcMid.toFixed(6)}, edge=${edge.toFixed(6)}`);
        
      } else {
        // ❌ No fit available - use CC
        console.warn(`[ISM.getQuote] No PC fit for ${expiryMs}/${strike}, using CC`);
        pcMid = ccMid;
        edge = 0;
        halfSpread = 0.0001;
        bid = Math.max(0, ccMid - halfSpread);
        ask = ccMid + halfSpread;
        bidSize = 100;
        askSize = 100;
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
      const marketHalfSpread = 0.0001;
      
      const pricingResult = computeTargetCurvePricing({
        ccMid,
        pcMid: lastTradeMid,
        currentPosition: node.position,
        costPerLot,
        minTick: 0.0001,
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
        bid = Math.max(0, ccMid - 0.0001);
        ask = ccMid + 0.0001;
        halfSpread = 0.0001;
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
      pcMid = safe(pcG.price, 0);

      if (pcMid <= 1e-12) {
        pcG = black76Greeks(forward, strike, T, ivFallback, isCall, 1.0);
        pcMid = Math.max(0, pcG.price);
        pcIV = ivFallback;
      }

      if (!midIsSane(pcMid)) {
        pcMid = Math.max(0, pcIV * Math.sqrt(T) * 0.4);
      }

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