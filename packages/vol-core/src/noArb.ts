import type { SVIParams } from "@core-types";
import { black76Call } from "./black76";
import { sviIV, sviTotalVariance } from "./smile";
import { kRel, asKRel } from "./conventions";
import {
  CONVEXITY_TOL,
  BUTTERFLY_TOL,
  CAL_W_REL_BPS,
  EPS_W_ABS,
  MAX_WING_SLOPE,
} from "./constants";

// Variance convexity on uniform k-grid
export function checkVarianceConvexityGrid(
  p: SVIParams,
  kMin = -2.5,
  kMax = 2.5,
  step = 0.1,
  tol = CONVEXITY_TOL
): Array<{ k: number; d2w: number }> {
  const ks: number[] = [];
  for (let k = kMin; k <= kMax + 1e-12; k += step) ks.push(k);
  const out: Array<{ k: number; d2w: number }> = [];
  for (let i = 1; i < ks.length - 1; i++) {
    const w0 = sviTotalVariance(asKRel(ks[i - 1]), p);
    const w1 = sviTotalVariance(asKRel(ks[i]), p);
    const w2 = sviTotalVariance(asKRel(ks[i + 1]), p);
    const d2 = (w2 - 2 * w1 + w0) / (step * step);
    if (d2 < -tol) out.push({ k: ks[i], d2w: d2 });
  }
  return out;
}

// Variance butterflies at market strikes (weights in K, w evaluated in k)
export function checkButterflies(
  strikes: number[],
  F: number,
  p: SVIParams,
  tolerance = BUTTERFLY_TOL
): Array<{ K: number; value: number; violates: boolean }> {
  if (strikes.length < 3) return [];
  const Ks = [...strikes].sort((a, b) => a - b);
  const res: Array<{ K: number; value: number; violates: boolean }> = [];
  for (let i = 1; i < Ks.length - 1; i++) {
    const K1 = Ks[i - 1], K2 = Ks[i], K3 = Ks[i + 1];
    const w1 = sviTotalVariance(asKRel(Math.log(K1 / F)), p);
    const w2 = sviTotalVariance(asKRel(Math.log(K2 / F)), p);
    const w3 = sviTotalVariance(asKRel(Math.log(K3 / F)), p);
    const w1w = (K3 - K2) / (K3 - K1);
    const w3w = (K2 - K1) / (K3 - K1);
    const bf = w1 * w1w - w2 + w3 * w3w; // should be ≥ 0
    res.push({ K: K2, value: bf, violates: bf < -tolerance });
  }
  return res;
}

// Call price convexity in K (non-uniform 3-point stencil)
export function checkCallConvexityK(
  F: number,
  T: number,
  p: SVIParams,
  Ks: number[],
  df = 1.0,
  tol = 0
): Array<{ K: number; d2C: number }> {
  if (Ks.length < 3) return [];
  const sorted = [...Ks].sort((a, b) => a - b);
  const C = sorted.map((K) => black76Call(F, K, T, sviIV(kRel(F, K), T, p), df));
  const out: Array<{ K: number; d2C: number }> = [];
  for (let i = 1; i < sorted.length - 1; i++) {
    const K0 = sorted[i - 1], K1 = sorted[i], K2 = sorted[i + 1];
    const h1 = K1 - K0, h2 = K2 - K1;
    // Correct non-uniform stencil:
    // d²C/dK² = 2 * [(C2-C1)/(h2(h1+h2)) - (C1-C0)/(h1(h1+h2))]
    const d2 = 2 * ((C[i + 1] - C[i]) / (h2 * (h1 + h2)) - (C[i] - C[i - 1]) / (h1 * (h1 + h2)));
    if (d2 < -tol) out.push({ K: K1, d2C: d2 });
  }
  return out;
}

export interface StaticArbCheck {
  passed: boolean;
  wingSlopes: { left: number; right: number; leftOK: boolean; rightOK: boolean };
  varConvexity: Array<{ k: number; d2w: number }>;
  wButterflies: Array<{ K: number; value: number; violates: boolean }>;
  callConvexity: Array<{ K: number; d2C: number }>;
}

export function checkStaticArbitrage(
  strikes: number[],
  F: number,
  T: number,
  p: SVIParams
): StaticArbCheck {
  const left = p.b * (1 - p.rho);
  const right = p.b * (1 + p.rho);
  const wingOK = left >= 0 && left <= MAX_WING_SLOPE && right >= 0 && right <= MAX_WING_SLOPE;
  const varConv = checkVarianceConvexityGrid(p);
  const wBf = checkButterflies(strikes, F, p);
  const callConv = checkCallConvexityK(F, T, p, strikes);
  const passed = wingOK && varConv.length === 0 && !wBf.some(b => b.violates) && callConv.length === 0;
  return {
    passed,
    wingSlopes: { left, right, leftOK: left >= 0 && left <= MAX_WING_SLOPE, rightOK: right >= 0 && right <= MAX_WING_SLOPE },
    varConvexity: varConv,
    wButterflies: wBf,
    callConvexity: callConv,
  };
}

// Calendar arbitrage in k-space ONLY
export function checkCalendarByK(
  F1: number, T1: number, p1: SVIParams,
  F2: number, T2: number, p2: SVIParams,
  kGrid: number[],
  relTolBps = CAL_W_REL_BPS,
  absFloor = EPS_W_ABS
): Array<{ k: number; w1: number; w2: number; relErrBps: number }> {
  if (!(T2 > T1)) return [];
  const out: Array<{ k: number; w1: number; w2: number; relErrBps: number }> = [];
  for (const k of kGrid) {
    const w1 = sviTotalVariance(asKRel(k), p1);
    const w2 = sviTotalVariance(asKRel(k), p2);
    const relBps = Math.abs((w2 - w1) / Math.max(absFloor, Math.abs(w1))) * 1e4;
    if (w1 > w2 && relBps > relTolBps) out.push({ k, w1, w2, relErrBps: relBps });
  }
  return out;
}
