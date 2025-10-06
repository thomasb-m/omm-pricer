/**
 * Integrated Dual Surface Model with Market Calibration
 * Auto-calibrates from actual market IVs instead of hardcoded defaults
 */

import {
  SVIParams,
  TraderMetrics,
  NodeState,
  SVI,
  RiskScorer
} from './dualSurfaceModel';
import { ModelConfig, getDefaultConfig } from './config/modelConfig';
import { SmileInventoryController } from './smileInventoryController';
import { DeltaConventions } from './pricing/blackScholes';
import { black76Greeks } from "../risk";
import { timeToExpiryYears } from "../utils/time";

const tiny = 1e-12;
const safe = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

export interface Quote {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  pcMid: number;
  ccMid: number;
  edge: number;
  bucket: string;
}

export interface TradeExecution {
  expiryMs: number;          // absolute expiry timestamp (ms)
  strike: number;
  forward: number;           // use the perp/forward, not spot
  optionType: 'C' | 'P';     // call or put
  price: number;
  size: number;              // signed from CUSTOMER perspective
  time: number;              // trade timestamp (ms)
}

export interface EnhancedSurface {
  expiry: number;
  cc: SVIParams;
  pc: SVIParams;
  nodes: Map<number, NodeState>;
}

export interface MarketQuoteForCalibration {
  strike: number;
  iv: number;
  weight?: number;
}

export class IntegratedSmileModel {
  private surfaces: Map<number, EnhancedSurface>;
  private inventoryController: SmileInventoryController;
  private riskScorer: RiskScorer;
  private config: ModelConfig;
  private sviConfig: any;
  private version: number;
  private marketIVs: Map<number, number>;

  constructor(product: 'BTC' | 'ETH' | 'SPX' = 'BTC') {
    this.config = getDefaultConfig(product);
    this.sviConfig = this.convertToSVIConfig(this.config);
    this.surfaces = new Map();
    this.inventoryController = new SmileInventoryController(this.config);
    this.riskScorer = new RiskScorer();
    this.version = 0;
    this.marketIVs = new Map();
  }

  private deriveMetricsFromMarketIV(atmIV: number, expiryYears: number): TraderMetrics {
    const L0 = atmIV * atmIV * expiryYears;
    return {
      L0,
      S0: -0.02,
      C0: 0.5,
      S_neg: -0.8,
      S_pos: 0.9
    };
  }

  private convertToSVIConfig(mc: ModelConfig): any {
    const edgeParams = new Map();
    mc.buckets.forEach(bucket => {
      edgeParams.set(bucket.name, bucket.edgeParams);
    });

    return {
      bMin: mc.svi.bMin,
      sigmaMin: mc.svi.sigmaMin,
      rhoMax: mc.svi.rhoMax,
      sMax: mc.svi.slopeMax,
      c0Min: mc.svi.c0Min,
      buckets: mc.buckets.map(b => ({
        name: b.name,
        minDelta: b.minDelta,
        maxDelta: b.maxDelta
      })),
      edgeParams,
      rbfWidth: mc.rbf.width,
      ridgeLambda: mc.rbf.ridgeLambda,
      maxL0Move: mc.riskLimits.maxL0Move,
      maxS0Move: mc.riskLimits.maxS0Move,
      maxC0Move: mc.riskLimits.maxC0Move
    };
  }

  updateCC(expiry: number, metrics: TraderMetrics): void {
    const newCC = SVI.fromMetrics(metrics, this.sviConfig);
    if (!SVI.validate(newCC, this.sviConfig)) {
      throw new Error('Invalid SVI parameters');
    }

    let surface = this.surfaces.get(expiry);
    if (!surface) {
      surface = { expiry, cc: newCC, pc: newCC, nodes: new Map() };
      this.surfaces.set(expiry, surface);
    } else {
      surface.cc = newCC;
      this.updatePC(surface);
    }
    this.version++;
  }

  private updatePC(surface: EnhancedSurface): void {
    surface.pc = this.inventoryController.adjustSVIForInventory(surface.cc);
  }

  onTrade(trade: TradeExecution): void {
    const surface = this.surfaces.get(trade.expiryMs);
    if (!surface) { console.warn(`No surface for expiryMs=${trade.expiryMs}`); return; }
    const T = timeToExpiryYears(trade.expiryMs, trade.time ?? Date.now());
    if (T <= 0) { console.warn(`Expired trade ignored (T<=0):`, trade); return; }

    const isCall = trade.optionType === 'C';
    const F = trade.forward;
    const K = trade.strike;

    this.updateNodeState(surface, {
      strike: K,
      price: trade.price,
      size: trade.size,
      expiryMs: trade.expiryMs,
      forward: F,
      optionType: trade.optionType,
      time: trade.time ?? Date.now(),
    } as any);

    const k = Math.log(K / F);
    const ccVar = SVI.w(surface.cc, k);
    const ccIV  = Math.sqrt(ccVar / T);
    const greeks = black76Greeks(F, K, T, ccIV, isCall, 1.0);
    const bucket = DeltaConventions.strikeToBucket(K, F, ccIV, T);

    this.inventoryController.updateInventory(K, trade.size, greeks.vega, bucket);
    this.updatePC(surface);
    this.version++;
  }

  private updateNodeState(
    surface: EnhancedSurface,
    trade: {
      strike: number;
      price: number;
      size: number;
      expiryMs: number;
      forward: number;
      optionType: 'C'|'P';
      time: number;
    }
  ): void {
    let node = surface.nodes.get(trade.strike);

    const T = timeToExpiryYears(trade.expiryMs, trade.time);
    const k = Math.log(trade.strike / trade.forward);
    const ccVar = SVI.w(surface.cc, k);
    const ccIV  = Math.sqrt(ccVar / Math.max(T, 1e-8));
    const greeks = black76Greeks(trade.forward, trade.strike, Math.max(T, 1e-8), ccIV, trade.optionType === 'C', 1.0);
    const widthRef = this.riskScorer.computeWidth({ gamma: greeks.gamma });
    const bucket = DeltaConventions.strikeToBucket(trade.strike, trade.forward, ccIV, Math.max(T, 1e-8));

    if (!node) {
      node = {
        strike: trade.strike,
        pcAnchor: trade.price,
        widthRef,
        position: trade.size,
        lastBucket: bucket,
        lastTradeTime: trade.time
      };
      surface.nodes.set(trade.strike, node);
    } else {
      node.pcAnchor = trade.price;
      node.position += trade.size;
      node.widthRef = widthRef;
      node.lastBucket = bucket;
      node.lastTradeTime = trade.time;
    }
  }

  calibrateFromMarket(
    expiry: number,
    marketQuotes: MarketQuoteForCalibration[],
    spot: number
  ): void {
    if (marketQuotes.length === 0) { console.warn('No market quotes provided for calibration'); return; }
    const atmQuote = marketQuotes.reduce((closest, q) =>
      Math.abs(q.strike - spot) < Math.abs(closest.strike - spot) ? q : closest
    );
    this.marketIVs.set(expiry, atmQuote.iv);
    const metrics = this.deriveMetricsFromMarketIV(atmQuote.iv, expiry);
    this.updateCC(expiry, metrics);
  }

  getQuote(
    expiryMs: number,
    strike: number,
    forward: number,
    optionType: 'C' | 'P',
    marketIV?: number
  ): Quote {
    const isCall = optionType === 'C';

    // 1) Time to expiry (guard)
    const Traw = timeToExpiryYears(expiryMs);
    const T = Math.max(safe(Traw, 0), 1e-8);

    // 2) Ensure surface exists / is calibrated
    let surface = this.surfaces.get(expiryMs);
    let atmIV: number;
    let shouldRecalibrate = false;

    if (marketIV !== undefined) {
      atmIV = marketIV;
      const cached = this.marketIVs.get(expiryMs);
      if (!cached || Math.abs(atmIV - cached) > 0.01) {
        this.marketIVs.set(expiryMs, atmIV);
        shouldRecalibrate = true;
      }
    } else if (this.marketIVs.has(expiryMs)) {
      atmIV = this.marketIVs.get(expiryMs)!;
    } else {
      atmIV = 0.35;
    }

    if (!surface || shouldRecalibrate) {
      const initialMetrics = this.deriveMetricsFromMarketIV(atmIV, T);
      this.updateCC(expiryMs, initialMetrics);
      surface = this.surfaces.get(expiryMs)!;
      this.updatePC(surface);
    }

    // 3) Log-moneyness
    const k = safe(Math.log(strike / Math.max(forward, tiny)), 0);

    // 4) CC price via Black-76 (no proxy mids)
let ccVar = safe(SVI.w(surface.cc, k), tiny);
ccVar = Math.max(ccVar, tiny);

let ccIV = safe(Math.sqrt(ccVar / T), 1e-8);
ccIV = Math.max(ccIV, 1e-8);

let ccG = black76Greeks(forward, strike, T, ccIV, isCall, 1.0);
let ccMid = safe(ccG.price, 0);

// 5) PC price via Black-76 (inventory-adjusted SVI)
let pcVar = safe(SVI.w(surface.pc, k), tiny);
pcVar = Math.max(pcVar, tiny);

let pcIV = safe(Math.sqrt(pcVar / T), 1e-8);
pcIV = Math.max(pcIV, 1e-8);

let pcG = black76Greeks(forward, strike, T, pcIV, isCall, 1.0);
let pcMid = safe(pcG.price, 0);

// --- Fallback if mids collapsed to ~0 (e.g., SVI mapping oddities) ---
const ivFallback = Number.isFinite(marketIV) ? (marketIV as number) : 0.35;
if (ccMid <= 1e-12) {
  ccG = black76Greeks(forward, strike, T, ivFallback, isCall, 1.0);
  ccMid = Math.max(0, ccG.price);
  ccIV = ivFallback;
}
if (pcMid <= 1e-12) {
  pcG = black76Greeks(forward, strike, T, ivFallback, isCall, 1.0);
  pcMid = Math.max(0, pcG.price);
  pcIV = ivFallback;
}

// sanity clamps: non-negative, finite, bounded
const midIsSane = (p: number) =>
  Number.isFinite(p) && p >= 0 && p <= Math.max(forward, strike) * 2;

if (!midIsSane(ccMid)) ccMid = Math.max(0, forward * ccIV * Math.sqrt(T) * 0.4);
if (!midIsSane(pcMid)) pcMid = Math.max(0, forward * pcIV * Math.sqrt(T) * 0.4);

    // 6) Bucket for sizing/inventory
    const bucket = DeltaConventions.strikeToBucket(strike, forward, ccIV, T);

    // 7) Node ensure/update (anchor/widthRef)
    let node = surface.nodes.get(strike);
    if (!node) {
      node = {
        strike,
        pcAnchor: pcMid,
        widthRef: this.riskScorer.computeWidth({ gamma: ccG.gamma }),
        position: 0,
        lastBucket: bucket,
        lastTradeTime: Date.now(),
      };
      surface.nodes.set(strike, node);
    }

    // 8) Width from risk scorer
    const currentWidth = this.riskScorer.computeWidth({
      gamma: pcG.gamma,
      J_L0: 1.0,
      J_S0: 0.5,
      J_C0: 0.3,
    });

    // 9) Cash quotes
    const bid = Math.max(0, pcMid - currentWidth);
    const ask = pcMid + currentWidth;

    // 10) Edge = pcMid - ccMid
    const edge = pcMid - ccMid;

    // 11) Size logic (inventory-aware)
    const baseSize = this.config.quotes.sizeBlocks;
    const invState = this.inventoryController.getInventoryState();
    const bucketInv = invState.get(bucket as any);

    let bidSize = baseSize;
    let askSize = baseSize;

    if (bucketInv && typeof (bucketInv as any).vega === 'number') {
      const vegaSigned = (bucketInv as any).vega as number;
      const vref =
        this.config.buckets.find((b) => b.name === bucket)?.edgeParams.Vref ?? 100;
      const invRatio = Math.min(5, Math.abs(vegaSigned) / Math.max(vref, 1e-6));

      if (vegaSigned < 0) {
        // short vega → discourage more selling
        askSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
      } else if (vegaSigned > 0) {
        bidSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
      }
    }

    return { bid, ask, bidSize, askSize, pcMid, ccMid, edge, bucket };
  }

  getInventorySummary() {
    const invState = this.inventoryController.getInventoryState();
    const adjustments = this.inventoryController.calculateSmileAdjustments();
    const summary = { totalVega: 0, byBucket: {} as any, smileAdjustments: adjustments };
    for (const [bucket, inv] of invState) {
      summary.totalVega += inv.vega;
      (summary.byBucket as any)[bucket] = { vega: inv.vega, count: inv.count };
    }
    return summary;
  }

  // Expose Core Curve SVI for callers that need factor greeks off CC
  getCCSVI(expiryMs: number) {
    const s = this.surfaces.get(expiryMs);
    return s ? s.cc : null;
  }
}
