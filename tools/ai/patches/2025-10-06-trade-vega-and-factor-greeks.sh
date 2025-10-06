#!/usr/bin/env bash
set -euo pipefail
# COMMIT: fix(trade,greeks): robust vega in onTrade + working finite-diff factor greeks

############################################
# 1) Robust vega in IntegratedSmileModel.onTrade
############################################
perl -0777 -i -pe '
  s|onTrade\(trade: TradeExecution\): void \{([\s\S]*?)this\.version\+\+;[\s]*\}|onTrade(trade: TradeExecution): void \{
    const surface = this.surfaces.get(trade.expiryMs);
    if (!surface) { console.warn(\`No surface for expiryMs=\${trade.expiryMs}\`); return; }

    const T = timeToExpiryYears(trade.expiryMs, trade.time ?? Date.now());
    if (T <= 0) { console.warn("Expired trade ignored (T<=0):", trade); return; }

    const isCall = trade.optionType === "C";
    const F = trade.forward;
    const K = trade.strike;

    // Keep node state up to date (anchor, width, last bucket)
    this.updateNodeState(surface, {
      strike: K,
      price: trade.price,
      size: trade.size,
      expiryMs: trade.expiryMs,
      forward: F,
      optionType: trade.optionType,
      time: trade.time ?? Date.now(),
    } as any);

    // --- Robust IV for greeks
    const ivFallback = (this.marketIVs.get(trade.expiryMs) ?? 0.35);
    const k = Math.log(K / Math.max(F, 1e-12));

    let ccVar = SVI.w(surface.cc, k);
    if (!Number.isFinite(ccVar) || ccVar <= 0) ccVar = Math.max((ivFallback*ivFallback)*Math.max(T,1e-8), 1e-12);

    let ccIV = Math.sqrt(ccVar / Math.max(T,1e-12));
    if (!Number.isFinite(ccIV) || ccIV <= 0) ccIV = Math.max(ivFallback, 1e-8);

    let greeks = black76Greeks(F, K, Math.max(T,1e-8), ccIV, isCall, 1.0);
    if (!Number.isFinite(greeks.vega)) {
      greeks = black76Greeks(F, K, Math.max(T,1e-8), Math.max(ivFallback,1e-8), isCall, 1.0);
    }
    const vegaSafe = Number.isFinite(greeks.vega) ? greeks.vega : 0;

    // Put-delta convention bucket
    const bucket = DeltaConventions.strikeToBucket(K, F, ccIV, Math.max(T,1e-8));

    // Update smile inventory using signed customer size * vega
    this.inventoryController.updateInventory(K, trade.size, vegaSafe, bucket);

    // Recompute PC from updated inventory
    this.updatePC(surface);
    this.version++;
  }|s
' apps/server/src/volModels/integratedSmileModel.ts

############################################
# 2) Replace factorGreeks with self-contained, working finite-diff
############################################
cat > apps/server/src/volModels/factors/factorGreeks.ts <<'TS'
/**
 * Finite-difference factor greeks g_i = ∂Price/∂θ_i
 * Self-contained: prices via CC SVI -> Black-76.
 * Factors: [L0, S0, C0, S_neg, S_pos, F]
 */
import { FactorVec } from "./FactorSpace";
import { SVI, SVIParams } from "../dualSurfaceModel";
import { black76Greeks } from "../../risk";

const tiny = 1e-12;

// finite-diff steps (tuned for stability)
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

  // helper to bump metrics then reprice
  function bumpParam(i: number, h: number): number {
    if (i === 5) {
      // Forward factor (F)
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

git add apps/server/src/volModels/integratedSmileModel.ts apps/server/src/volModels/factors/factorGreeks.ts
