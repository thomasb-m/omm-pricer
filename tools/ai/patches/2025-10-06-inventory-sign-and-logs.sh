#!/usr/bin/env bash
set -euo pipefail
# COMMIT: fix(inv): standardise dealer-signed size; robust vega + debug logs

######## 1) Overwrite IntegratedSmileModel.ts (dealer-signed + logs) ########
cat > apps/server/src/volModels/integratedSmileModel.ts <<'TS'
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
  size: number;      // ✅ DEALER-signed size (see header)
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

    // Keep node state fresh
    this.updateNodeState(s, {
      strike: trade.strike, price: trade.price, size: trade.size,
      expiryMs: trade.expiryMs, forward: trade.forward, optionType: trade.optionType, time: trade.time ?? Date.now()
    } as any);

    // Robust vega for inventory update
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
    // 🔎 Debug
    console.log(`[ISM.onTrade] bucket=${bucket} K=${K} size(dealer)=${trade.size} vega=${vegaSafe} product=${trade.size * vegaSafe}`);

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

    // Inventory-aware sizes (simple)
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
}
TS

######## 2) Overwrite SmileInventoryController.ts (numeric-safe + logs) ########
cat > apps/server/src/volModels/smileInventoryController.ts <<'TS'
/**
 * Smile-based Inventory Controller
 * Expects **DEALER-signed** size in updateInventory(size).
 * We accumulate bucket vega as: inv.vega += size * option_vega.
 */
import { SVIParams, SVI, TraderMetrics } from './dualSurfaceModel';
import { ModelConfig } from './config/modelConfig';

export interface SmileAdjustments {
  deltaL0: number;
  deltaS0: number;
  deltaC0: number;
  deltaSNeg: number;
  deltaSPos: number;
}

export interface InventoryBucket {
  vega: number;
  count: number;
  strikes: number[];
  edgeRequired?: number;
}

export class SmileInventoryController {
  private inventory: Map<string, InventoryBucket>;
  private config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
    this.inventory = new Map();
  }

  /** Update inventory after trade — expects DEALER-signed size */
  updateInventory(strike: number, size: number, vega: number, bucket: string): void {
    const s = Number(size) || 0;
    const v = Number(vega) || 0;

    let bucketInv = this.inventory.get(bucket);
    if (!bucketInv) {
      bucketInv = { vega: 0, count: 0, strikes: [], edgeRequired: 0 };
      this.inventory.set(bucket, bucketInv);
    }

    const deltaV = s * v;
    bucketInv.vega = (Number(bucketInv.vega) || 0) + deltaV;
    bucketInv.count = (Number(bucketInv.count) || 0) + 1;
    if (!bucketInv.strikes.includes(strike)) bucketInv.strikes.push(strike);

    // 🔎 Debug
    console.log(`[SIC.updateInv] bucket=${bucket} strike=${strike} size(dealer)=${s} vega=${v} Δvega=${deltaV} agg=${bucketInv.vega}`);
  }

  /** Map inventory to smile parameter adjustments */
  calculateSmileAdjustments(): SmileAdjustments {
    let deltaL0 = 0, deltaS0 = 0, deltaC0 = 0, deltaSNeg = 0, deltaSPos = 0;

    for (const [bucket, inv] of this.inventory) {
      const bucketVega = Number(inv.vega) || 0;
      if (Math.abs(bucketVega) < 1e-9) continue;

      const cfg = this.config.buckets.find(b => b.name === bucket);
      if (!cfg) continue;

      const E0    = Number(cfg.edgeParams?.E0)    || 0;
      const kappa = Number(cfg.edgeParams?.kappa) || 0;
      const gamma = Number(cfg.edgeParams?.gamma) || 1;
      const Vref  = Math.max(Number(cfg.edgeParams?.Vref) || 1, 1e-6);

      const normalized = Math.abs(bucketVega) / Vref;
      // Negative for SHORT (bucketVega < 0) -> wants higher prices
      const edgeRequired = -Math.sign(bucketVega) * (E0 + kappa * Math.pow(normalized, gamma));
      inv.edgeRequired = edgeRequired;

      const TICK_TO_VOL = 0.005;
      switch (bucket) {
        case 'atm':
          deltaL0 += edgeRequired * TICK_TO_VOL * 1.0;
          deltaC0 += Math.sign(bucketVega) * Math.abs(edgeRequired) * 0.0001;
          break;
        case 'rr25':
          if (bucketVega < 0) {
            deltaS0   += Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
            deltaL0   += Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
          } else {
            deltaS0   -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
            deltaL0   -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
          }
          break;
        case 'rr10':
          if (bucketVega < 0) {
            deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaS0   += Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
          } else {
            deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaS0   -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
          }
          break;
        case 'wings':
          deltaL0   += edgeRequired * TICK_TO_VOL * 0.1;
          deltaSNeg += -edgeRequired * TICK_TO_VOL * 0.4;
          deltaS0   += edgeRequired * TICK_TO_VOL * 0.1;
          break;
      }
    }

    return { deltaL0, deltaS0, deltaC0, deltaSNeg, deltaSPos };
  }

  /** Create PC from CC with backoff */
  adjustSVIForInventory(ccParams: SVIParams): SVIParams {
    const base = SVI.toMetrics(ccParams);
    const adj = this.calculateSmileAdjustments();

    const make = (scale: number) => {
      const m: TraderMetrics = {
        L0: Math.max(0.001, base.L0 + adj.deltaL0 * scale),
        S0: base.S0 + adj.deltaS0 * scale,
        C0: Math.max(0.1, base.C0 + adj.deltaC0 * scale),
        S_neg: base.S_neg + adj.deltaSNeg * scale,
        S_pos: base.S_pos + adj.deltaSPos * scale,
      };
      return SVI.fromMetrics(m, this.createSVIConfig());
    };

    let pc = make(1.0);
    if (!SVI.validate(pc, this.createSVIConfig())) {
      let s = 0.5;
      while (s > 1e-3) {
        pc = make(s);
        if (SVI.validate(pc, this.createSVIConfig())) break;
        s *= 0.5;
      }
      if (!SVI.validate(pc, this.createSVIConfig())) {
        console.warn('Adjusted SVI invalid; using CC.');
        return ccParams;
      }
    }
    return pc;
  }

  createSVIConfig(): any {
    return {
      bMin: this.config.svi.bMin,
      sigmaMin: this.config.svi.sigmaMin,
      rhoMax: this.config.svi.rhoMax,
      sMax: this.config.svi.slopeMax,
      c0Min: this.config.svi.c0Min,
      buckets: [],
      edgeParams: new Map(),
      rbfWidth: 0,
      ridgeLambda: 0,
      maxL0Move: 0,
      maxS0Move: 0,
      maxC0Move: 0
    };
  }

  getInventoryState(): Map<string, InventoryBucket> {
    return new Map(this.inventory);
  }

  getInventory() {
    const total = { vega: 0, gamma: 0, theta: 0 };
    const byBucket: any = {};
    for (const [bucket, inv] of this.inventory) {
      const v = Number(inv.vega) || 0;
      total.vega += v;
      byBucket[bucket] = { vega: v, count: inv.count };
    }
    return { total, totalVega: total.vega, byBucket, smileAdjustments: this.calculateSmileAdjustments() };
  }

  clearInventory(): void { this.inventory.clear(); }
}
TS

git add apps/server/src/volModels/integratedSmileModel.ts apps/server/src/volModels/smileInventoryController.ts
