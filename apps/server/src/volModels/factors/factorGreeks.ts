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
    if (i === 5) { // Forward F
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
