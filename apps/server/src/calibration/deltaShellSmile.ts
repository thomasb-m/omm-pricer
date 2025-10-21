// src/calibration/deltaShellSmile.ts
import { SVI, type SVIParams, type TraderMetrics } from '../volModels/dualSurfaceModel';
import { timeToExpiryYears } from '../utils/time';
import { black76Greeks } from '../risk/index.js';
import { getMarketSpec } from '../markets/index';

export interface QuotePoint {
  strike: number;
  midQuoted: number;     // mid premium in quoted units (e.g. BTC)
  iv?: number;           // optional market IV (used only for ATM L0 if present)
  weight?: number;
}

export interface DeltaShellCfg {
  shellStep?: number;     // go 50Δ, 49/51, 48/52, ... (default 0.01)
  minDelta?: number;      // stop when putΔ < minDelta or callΔ > 1-minDelta (default 0.20)
  huberK?: number;        // robust loss threshold in quoted premium (default market.minTick * 6)
  grids?: Array<{ s0: number; c0: number; span: number }>;
  wingDeltaCutoff?: number; // default 0.15
  wingGrid?: number;        // default 17
  sNegRange?: [number, number]; // default [-1.5, -0.05]
  sPosRange?: [number, number]; // default [0.05, 1.5]
}

const DEF: Required<DeltaShellCfg> = {
  shellStep: 0.01,
  minDelta: 0.20,
  huberK: 0, // will be set from market spec
  grids: [
    { s0: 15, c0: 15, span: 0.25 }, // coarse
    { s0: 9,  c0: 9,  span: 0.12 }, // medium
    { s0: 7,  c0: 7,  span: 0.06 }, // fine
  ],
  wingDeltaCutoff: 0.15,
  wingGrid: 17,
  sNegRange: [-1.5, -0.05],
  sPosRange: [0.05, 1.5],
};

function huber(r: number, k: number) {
  const a = Math.abs(r);
  return a <= k ? 0.5 * r * r : k * (a - 0.5 * k);
}

function intrinsicQuoted(F: number, K: number, isCall: boolean, mkt = getMarketSpec('BTC')) {
  const base = isCall ? Math.max(F - K, 0) : Math.max(K - F, 0);
  return mkt.fromBaseToQuoted(base, Math.max(F, 1e-9));
}

function timeValueQuoted(midQuoted: number, intrQuoted: number, mkt = getMarketSpec('BTC')) {
  return Math.max(mkt.minTick * 0.5, midQuoted - intrQuoted);
}

function callDelta76(F: number, K: number, T: number, iv: number) {
  return Math.max(0, Math.min(1, black76Greeks(F, K, Math.max(T,1e-8), Math.max(iv,1e-8), true, 1).delta));
}

function modelTimeValueQuoted(F: number, K: number, T: number, iv: number, isCall: boolean, mkt = getMarketSpec('BTC')) {
  const g = black76Greeks(F, K, Math.max(T,1e-8), Math.max(iv,1e-8), isCall, 1);
  const priceBase = Math.max(0, g.price);
  const priceQ = mkt.fromBaseToQuoted(priceBase, Math.max(F, 1e-9));
  const intrQ  = intrinsicQuoted(F, K, isCall, mkt);
  return Math.max(mkt.minTick * 0.5, priceQ - intrQ);
}

export function fitSmileDeltaShells(
  quotes: QuotePoint[],
  forward: number,
  expiryMs: number,
  nowMs: number,
  symbol: 'BTC'|'ETH'|'SPX' = 'BTC',
  cfg: DeltaShellCfg = {}
): SVIParams {
  const C = { ...DEF, ...cfg };
  const mkt = getMarketSpec(symbol);
  const huberK = C.huberK || mkt.minTick * 6;

  const T = Math.max(timeToExpiryYears(expiryMs, nowMs), 1e-8);

  // ✅ SVI parameter constraints to prevent pathological fits
  const sviConfig = {
    bMin: 0.001,
    sigmaMin: 0.10,
    rhoMax: 0.95,  // Prevent rho=-0.999!
    sMax: 2.0,
    c0Min: 0.1
  };

  const rows = quotes.map(q => {
    const w = q.weight ?? 1;
    return {
      strike: q.strike,
      midQ: Math.max(mkt.minTick * 0.5, q.midQuoted),
      w,
    };
  }).sort((a,b)=>a.strike-b.strike);

  if (rows.length === 0) throw new Error('fitSmileDeltaShells: no quotes');

  // Step 1: ATM lock (50Δ)
  let atmIdx = 0;
  for (let i=1;i<rows.length;i++) {
    if (Math.abs(rows[i].strike - forward) < Math.abs(rows[atmIdx].strike - forward)) atmIdx = i;
  }
  const atmStrike = rows[atmIdx].strike;

  // Use the provided IV if available, otherwise use a reasonable default
  const providedIV = quotes[atmIdx].iv;
  const ivATMguess = providedIV 
    ? Math.min(2.0, Math.max(0.20, providedIV))  // Use market IV!
    : 0.50;  // Reasonable default for crypto

  const L0 = ivATMguess * ivATMguess * T;

  console.log(`[fitSmileDeltaShells] ATM anchor: strike=${atmStrike}, IV=${ivATMguess.toFixed(4)}, L0=${L0.toFixed(6)}`);

  let metrics: TraderMetrics = { L0, S0: -0.03, C0: 0.55, S_neg: -0.6, S_pos: 0.6 };

  function ivSVI(k: number) {
    const w = SVI.w(SVI.fromMetrics(metrics, sviConfig), k);
    return Math.sqrt(Math.max(w, 1e-12) / Math.max(T, 1e-12));
  }
  function kOf(K: number) { return Math.log(K / Math.max(forward, 1e-12)); }

  // Step 2: grow shells
  let target = 0.49;
  const used = new Set<number>();
  used.add(atmStrike);

  let fitSet: Array<{ K:number; tvQ:number; isCall:boolean; w:number }> = [];

  function pickNearestByDelta(targetDelta: number, isCall: boolean) {
    let best: { idx:number; dErr:number } | null = null;
    for (let i=0;i<rows.length;i++) {
      const K = rows[i].strike;
      if (used.has(K)) continue;
      if (isCall && K <= forward) continue;
      if (!isCall && K >= forward) continue;

      const k = kOf(K);
      const iv = ivSVI(k);
      const dC = callDelta76(forward, K, T, iv);
      const dTarget = isCall ? (1 - targetDelta) : targetDelta;
      const dErr = Math.abs(dC - dTarget);
      if (!best || dErr < best.dErr) best = { idx: i, dErr };
    }
    return best?.idx ?? -1;
  }

  function refitS0C0() {
    const baseS0 = metrics.S0, baseC0 = metrics.C0;
    const lockedL0 = metrics.L0;  // ✅ LOCK L0!
    let best = { S0: baseS0, C0: baseC0, loss: Number.POSITIVE_INFINITY };

    for (const g of C.grids) {
      const s0Lo = baseS0 - g.span, s0Hi = baseS0 + g.span;
      const c0Lo = baseC0 - g.span, c0Hi = baseC0 + g.span;
      for (let i=0;i<g.s0;i++) {
        const S0 = s0Lo + (s0Hi - s0Lo) * (i/(Math.max(1,g.s0-1)));
        for (let j=0;j<g.c0;j++) {
          const C0 = c0Lo + (c0Hi - c0Lo) * (j/(Math.max(1,g.c0-1)));
          const test = { L0: lockedL0, S0, C0, S_neg: metrics.S_neg, S_pos: metrics.S_pos };  // ✅ USE LOCKED L0!
          const svi = SVI.fromMetrics(test, sviConfig);
          let loss = 0;
          for (const r of fitSet) {
            const k = kOf(r.K);
            const iv = Math.sqrt(Math.max(SVI.w(svi, k),1e-12)/Math.max(T,1e-12));
            const tvM = modelTimeValueQuoted(forward, r.K, T, iv, r.isCall, mkt);
            const res = tvM - r.tvQ;
            loss += r.w * huber(res, huberK);
          }
          if (loss < best.loss) best = { S0, C0, loss };
        }
      }
      metrics.S0 = best.S0;
      metrics.C0 = best.C0;
      metrics.L0 = lockedL0;  // ✅ RESTORE LOCKED L0!
    }
  }

  while (target >= C.minDelta) {
    const putIdx  = pickNearestByDelta(target, false);
    const callIdx = pickNearestByDelta(target, true);

    if (putIdx < 0 || callIdx < 0) break;

    const putK  = rows[putIdx].strike;
    const callK = rows[callIdx].strike;

    const pIntr = intrinsicQuoted(forward, putK,  false, mkt);
    const cIntr = intrinsicQuoted(forward, callK, true,  mkt);
    const pTV   = timeValueQuoted(rows[putIdx].midQ,  pIntr, mkt);
    const cTV   = timeValueQuoted(rows[callIdx].midQ, cIntr, mkt);

    fitSet.push({ K: putK,  tvQ: pTV, isCall: false, w: rows[putIdx].w });
    fitSet.push({ K: callK, tvQ: cTV, isCall: true,  w: rows[callIdx].w });

    used.add(putK); 
    used.add(callK);

    refitS0C0();

    target -= C.shellStep;
  }

  // Step 3: Wings
  const core = SVI.fromMetrics(metrics, sviConfig);
  const wingTargets = rows.map(r => {
    const k = kOf(r.strike);
    const iv = Math.sqrt(Math.max(SVI.w(core, k),1e-12)/Math.max(T,1e-12));
    const dC = callDelta76(forward, r.strike, T, iv);
    return { ...r, dC };
  }).filter(r => r.dC <= C.wingDeltaCutoff || r.dC >= 1 - C.wingDeltaCutoff);

  if (wingTargets.length >= 2) {
    let best = { S_neg: metrics.S_neg, S_pos: metrics.S_pos, loss: Number.POSITIVE_INFINITY };
    for (let i=0;i<C.wingGrid;i++) {
      const S_neg = C.sNegRange[0] + (C.sNegRange[1] - C.sNegRange[0]) * (i/Math.max(1,C.wingGrid-1));
      for (let j=0;j<C.wingGrid;j++) {
        const S_pos = C.sPosRange[0] + (C.sPosRange[1] - C.sPosRange[0]) * (j/Math.max(1,C.wingGrid-1));
        const test = { ...metrics, S_neg, S_pos };
        const svi  = SVI.fromMetrics(test, sviConfig);
        let loss = 0;
        for (const r of wingTargets) {
          const isCall = r.strike >= forward;
          const intrQ  = intrinsicQuoted(forward, r.strike, isCall, mkt);
          const tvObs  = timeValueQuoted(r.midQ, intrQ, mkt);
          const iv     = Math.sqrt(Math.max(SVI.w(svi, kOf(r.strike)),1e-12)/Math.max(T,1e-12));
          const tvMod  = modelTimeValueQuoted(forward, r.strike, T, iv, isCall, mkt);
          loss += huber(tvMod - tvObs, huberK);
        }
        if (loss < best.loss) best = { S_neg, S_pos, loss };
      }
    }
    metrics.S_neg = best.S_neg;
    metrics.S_pos = best.S_pos;
  }

  // Force L0 to stay at the locked value
  metrics.L0 = L0;
  return SVI.fromMetrics(metrics, sviConfig);
}