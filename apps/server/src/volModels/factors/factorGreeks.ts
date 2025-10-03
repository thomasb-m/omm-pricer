/**
 * Finite-difference factor greeks g_i = ∂Price/∂θ_i
 * Safe, slow prototype; replace with closed-form SVI partials later.
 */
import { FactorVec } from "./FactorSpace";
import { SVI, SVIParams } from "../dualSurfaceModel";
import { black76Greeks } from "../../risk";

/**
 * Price from SVI CC parameters at (K, T, F, isCall) using Black-76.
 * Vega convention: per absolute vol unit (consistent with black76Greeks).
 */
function priceFromSVI(cc: SVIParams, strike: number, T: number, F: number, isCall: boolean): number {
  const tiny = 1e-12;
  const k = Math.log(Math.max(strike, tiny) / Math.max(F, tiny));
  let varCC = SVI.w(cc, k);
  if (!Number.isFinite(varCC) || varCC <= 0) varCC = tiny;
  const iv = Math.sqrt(varCC / Math.max(T, tiny));
  const g = black76Greeks(F, strike, Math.max(T, tiny), Math.max(iv, tiny), isCall, 1.0);
  return g.price;
}

const EPS: FactorVec = [1e-4, 1e-4, 1e-3, 1e-4, 1e-4, 1e-6];

/**
 * Returns g = [∂P/∂L0, ∂P/∂S0, ∂P/∂C0, ∂P/∂S_neg, ∂P/∂S_pos, ∂P/∂F]
 */
export function factorGreeksFiniteDiff(
  cc: SVIParams,
  strike: number,
  T: number,
  F: number,
  isCall: boolean
): FactorVec {
  const base = priceFromSVI(cc, strike, T, F, isCall);

  const m0 = SVI.toMetrics(cc);
  const sviCfg = {
    bMin: 0, sigmaMin: 1e-6, rhoMax: 0.999, sMax: 5, c0Min: 0.01,
    buckets: [], edgeParams: new Map(), rbfWidth: 0, ridgeLambda: 0,
    maxL0Move: 0, maxS0Move: 0, maxC0Move: 0
  };

  function bumpParam(i: number): number {
    const m = { ...m0 };
    switch (i) {
      case 0: m.L0    += EPS[0]; break;
      case 1: m.S0    += EPS[1]; break;
      case 2: m.C0    += EPS[2]; break;
      case 3: m.S_neg += EPS[3]; break;
      case 4: m.S_pos += EPS[4]; break;
      case 5: // F bump handled separately
        return (priceFromSVI(cc, strike, T, F + EPS[5], isCall) - base) / EPS[5];
    }
    const bumped = SVI.fromMetrics(m, sviCfg);
    const pb = priceFromSVI(bumped, strike, T, F, isCall);
    const dP = (pb - base);
    const eps = EPS[i as 0|1|2|3|4];
    return dP / eps;
  }

  const g0 = bumpParam(0);
  const g1 = bumpParam(1);
  const g2 = bumpParam(2);
  const g3 = bumpParam(3);
  const g4 = bumpParam(4);
  const g5 = bumpParam(5);

  // Return as [L0, S0, C0, S_neg, S_pos, F]
  return [g0, g1, g2, g3, g4, g5];
}
