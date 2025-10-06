#!/usr/bin/env bash
set -euo pipefail
# COMMIT: fix(trade,greeks): robust vega in onTrade + self-contained finite-diff factor greeks

# 1) Replace factorGreeks with self-contained implementation
cat > apps/server/src/volModels/factors/factorGreeks.ts <<'TS'
/**
 * Finite-difference factor greeks g_i = ∂Price/∂θ_i
 * Self-contained: CC (SVI) -> Black-76 price.
 * Factors: [L0, S0, C0, S_neg, S_pos, F]
 */
import { FactorVec } from "./FactorSpace";
import { SVI, SVIParams } from "../dualSurfaceModel";
import { black76Greeks } from "../../risk";

const tiny = 1e-12;
const EPS: FactorVec = [1e-4, 1e-4, 1e-3, 1e-4, 1e-4, 1e-4];

function priceFromCC(cc: SVIParams, strike: number, T: number, F: number, isCall: boolean): number {
  const Tpos = Math.max(T, 1e-8);
  const k = Math.log(strike / Math.max(F, tiny));
  let w = SVI.w(cc, k);
  if (!Number.isFinite(w) || w <= 0) {
    const iv0 = 0.35;
    w = Math.max(iv0 * iv0 * Tpos, tiny);
  }
  let iv = Math.sqrt(w / Tpos);
  if (!Number.isFinite(iv) || iv <= 0) iv = 0.35;
  const g = black76Greeks(F, strike, Tpos, iv, isCall, 1.0);
  return Number.isFinite(g.price) ? g.price : 0;
}

export function factorGreeksFiniteDiff(
  cc: SVIParams,
  strike: number,
  T: number,
  F: number,
  isCall: boolean
): FactorVec {
  const Tpos = Math.max(T, 1e-8);
  const base = priceFromCC(cc, strike, Tpos, F, isCall);

  function bumpParam(i: number, h: number): number {
    if (i === 5) { // F
      const pF = priceFromCC(cc, strike, Tpos, F + h, isCall);
      return (pF - base) / h;
    }
    const m0 = SVI.toMetrics(cc);
    switch (i) {
      case 0: m0.L0   += h; break;
      case 1: m0.S0   += h; break;
      case 2: m0.C0   += h; break;
      case 3: m0.S_neg+= h; break;
      case 4: m0.S_pos+= h; break;
    }
    const cfg = { bMin: 0, sigmaMin: 1e-6, rhoMax: 0.999, sMax: 5, c0Min: 0.01,
                  buckets: [], edgeParams: new Map(), rbfWidth: 0, ridgeLambda: 0,
                  maxL0Move: 0, maxS0Move: 0, maxC0Move: 0 };
    const bumped = SVI.fromMetrics(m0, cfg);
    const pb = priceFromCC(bumped, strike, Tpos, F, isCall);
    return (pb - base) / h;
  }

  const g0 = bumpParam(0, EPS[0]);
  const g1 = bumpParam(1, EPS[1]);
  const g2 = bumpParam(2, EPS[2]);
  const g3 = bumpParam(3, EPS[3]);
  const g4 = bumpParam(4, EPS[4]);
  const g5 = bumpParam(5, EPS[5]);

  return [
    Number.isFinite(g0) ? g0 : 0,
    Number.isFinite(g1) ? g1 : 0,
    Number.isFinite(g2) ? g2 : 0,
    Number.isFinite(g3) ? g3 : 0,
    Number.isFinite(g4) ? g4 : 0,
    Number.isFinite(g5) ? g5 : 0,
  ];
}
TS

# 2) Overwrite IntegratedSmileModel with robust onTrade (vega fallback) + existing mid fallbacks
cat > apps/server/src/volModels/integratedSmileModel.ts <<'TS'
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
  size: number;      // signed from CUSTOMER perspective
  time: number;
}
export interface EnhancedSurface {
  expiry: number;
  cc: SVIParams;
  pc: SVIParams;
  nodes: Map<number, NodeState>;
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

  constructor(product: 'BTC'|'ETH'|'SPX' = 'BTC') {
    this.config = getDefaultConfig(product);
    this.sviConfig = this.convertToSVIConfig(this.config);
    this.inventoryController = new SmileInventoryController(this.config);
    this.riskScorer = new RiskScorer();
  }

  private deriveMetricsFromMarketIV(atmIV: number, expiryYears: number): TraderMetrics {
    const L0 = atmIV * atmIV * expiryYears;
    return { L0, S0: -0.02, C0: 0.5, S_neg: -0.8, S_pos: 0.9 };
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

  onTrade(trade: TradeExecution): void {
    const s = this.surfaces.get(trade.expiryMs);
    if (!s) { console.warn(`No surface for expiryMs=${trade.expiryMs}`); return; }
    const T = timeToExpiryYears(trade.expiryMs, trade.time ?? Date.now());
    if (T <= 0) { console.warn('Expired trade ignored (T<=0):', trade); return; }

    // Maintain node state
    this.updateNodeState(s, {
      strike: trade.strike, price: trade.price, size: trade.size,
      expiryMs: trade.expiryMs, forward: trade.forward, optionType: trade.optionType, time: trade.time ?? Date.now()
    } as any);

    // Robust IV/vega
    const F = trade.forward, K = trade.strike, isCall = trade.optionType === 'C';
    const ivFallback = this.marketIVs.get(trade.expiryMs) ?? 0.35;
    const k = Math.log(K / Math.max(F, tiny));

    let ccVar = SVI.w(s.cc, k);
    if (!Number.isFinite(ccVar) || ccVar <= 0) ccVar = Math.max(ivFallback*ivFallback*Math.max(T,1e-8), 1e-12);
    let ccIV = Math.sqrt(ccVar / Math.max(T,1e-12));
    if (!Number.isFinite(ccIV) || ccIV <= 0) ccIV = Math.max(ivFallback, 1e-8);

    let g = black76Greeks(F, K, Math.max(T,1e-8), ccIV, isCall, 1.0);
    if (!Number.isFinite(g.vega)) g = black76Greeks(F, K, Math.max(T,1e-8), Math.max(ivFallback,1e-8), isCall, 1.0);
    const vegaSafe = Number.isFinite(g.vega) ? g.vega : 0;

    const bucket = DeltaConventions.strikeToBucket(K, F, ccIV, Math.max(T,1e-8));
    this.inventoryController.updateInventory(K, trade.size, vegaSafe, bucket);

    this.updatePC(s);
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
      node = { strike: trade.strike, pcAnchor: trade.price, widthRef, position: trade.size, lastBucket: bucket, lastTradeTime: trade.time };
      surface.nodes.set(trade.strike, node);
    } else {
      node.pcAnchor = trade.price;
      node.position += trade.size;
      node.widthRef = widthRef;
      node.lastBucket = bucket;
      node.lastTradeTime = trade.time;
    }
  }

  calibrateFromMarket(expiry: number, marketQuotes: MarketQuoteForCalibration[], spot: number): void {
    if (marketQuotes.length === 0) { console.warn('No market quotes provided for calibration'); return; }
    const atm = marketQuotes.reduce((c, q) => Math.abs(q.strike - spot) < Math.abs(c.strike - spot) ? q : c);
    this.marketIVs.set(expiry, atm.iv);
    const m = this.deriveMetricsFromMarketIV(atm.iv, expiry);
    this.updateCC(expiry, m);
  }

  getQuote(expiryMs: number, strike: number, forward: number, optionType: 'C'|'P', marketIV?: number): Quote {
    const isCall = optionType === 'C';
    const Traw = timeToExpiryYears(expiryMs);
    const T = Math.max(safe(Traw, 0), 1e-8);
    let s = this.surfaces.get(expiryMs);

    let atmIV: number; let recal = false;
    if (marketIV !== undefined) {
      atmIV = marketIV;
      const cached = this.marketIVs.get(expiryMs);
      if (!cached || Math.abs(atmIV - cached) > 0.01) { this.marketIVs.set(expiryMs, atmIV); recal = true; }
    } else atmIV = this.marketIVs.get(expiryMs) ?? 0.35;

    if (!s || recal) {
      const m = this.deriveMetricsFromMarketIV(atmIV, T);
      this.updateCC(expiryMs, m);
      s = this.surfaces.get(expiryMs)!;
      this.updatePC(s);
    }

    const k = safe(Math.log(strike / Math.max(forward, tiny)), 0);

    // CC mid
    let ccVar = Math.max(safe(SVI.w(s.cc, k), tiny), tiny);
    let ccIV = Math.max(safe(Math.sqrt(ccVar / T), 1e-8), 1e-8);
    let ccG = black76Greeks(forward, strike, T, ccIV, isCall, 1.0);
    let ccMid = safe(ccG.price, 0);

    // PC mid
    let pcVar = Math.max(safe(SVI.w(s.pc, k), tiny), tiny);
    let pcIV = Math.max(safe(Math.sqrt(pcVar / T), 1e-8), 1e-8);
    let pcG = black76Greeks(forward, strike, T, pcIV, isCall, 1.0);
    let pcMid = safe(pcG.price, 0);

    // Fallback mids if collapsed
    const ivFallback = Number.isFinite(marketIV) ? (marketIV as number) : 0.35;
    if (ccMid <= 1e-12) { ccG = black76Greeks(forward, strike, T, ivFallback, isCall, 1.0); ccMid = Math.max(0, ccG.price); ccIV = ivFallback; }
    if (pcMid <= 1e-12) { pcG = black76Greeks(forward, strike, T, ivFallback, isCall, 1.0); pcMid = Math.max(0, pcG.price); pcIV = ivFallback; }

    const midIsSane = (p: number) => Number.isFinite(p) && p >= 0 && p <= Math.max(forward, strike) * 2;
    if (!midIsSane(ccMid)) ccMid = Math.max(0, forward * ccIV * Math.sqrt(T) * 0.4);
    if (!midIsSane(pcMid)) pcMid = Math.max(0, forward * pcIV * Math.sqrt(T) * 0.4);

    const bucket = DeltaConventions.strikeToBucket(strike, forward, ccIV, T);

    let node = s.nodes.get(strike);
    if (!node) {
      node = { strike, pcAnchor: pcMid, widthRef: this.riskScorer.computeWidth({ gamma: ccG.gamma }), position: 0, lastBucket: bucket, lastTradeTime: Date.now() };
      s.nodes.set(strike, node);
    }

    const currentWidth = this.riskScorer.computeWidth({ gamma: pcG.gamma, J_L0: 1.0, J_S0: 0.5, J_C0: 0.3 });
    const bid = Math.max(0, pcMid - currentWidth);
    const ask = pcMid + currentWidth;
    const edge = pcMid - ccMid;

    // inventory-aware sizes (optional simple rule)
    const baseSize = this.config.quotes.sizeBlocks;
    const invState = this.inventoryController.getInventoryState();
    const bucketInv = invState.get(bucket as any);
    let bidSize = baseSize, askSize = baseSize;
    if (bucketInv && typeof (bucketInv as any).vega === 'number') {
      const vegaSigned = (bucketInv as any).vega as number;
      const vref = this.config.buckets.find((b) => b.name === bucket)?.edgeParams.Vref ?? 100;
      const invRatio = Math.min(5, Math.abs(vegaSigned) / Math.max(vref, 1e-6));
      if (vegaSigned < 0) askSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
      else if (vegaSigned > 0) bidSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
    }

    return { bid, ask, bidSize, askSize, pcMid, ccMid, edge, bucket };
  }

  getInventorySummary() {
    const invState = this.inventoryController.getInventoryState();
    const adjustments = this.inventoryController.calculateSmileAdjustments();
    const summary = { totalVega: 0, byBucket: {} as any, smileAdjustments: adjustments };
    for (const [bucket, inv] of invState) {
      summary.totalVega += (Number(inv.vega) || 0);
      (summary.byBucket as any)[bucket] = { vega: (Number(inv.vega) || 0), count: inv.count };
    }
    return summary;
  }

  getCCSVI(expiryMs: number): SVIParams | null {
    const s = this.surfaces.get(expiryMs);
    return s ? s.cc : null;
  }
}
TS

git add apps/server/src/volModels/factors/factorGreeks.ts apps/server/src/volModels/integratedSmileModel.ts
