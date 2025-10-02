/**
 * Finite-difference factor greeks g_i = ∂P/∂θ_i
 * Safe, slow prototype; replace with closed-form SVI partials later.
 *
 * Factors: [L0, S0, C0, S_neg, S_pos, F]
 * Returns: dPrice/dθ_i (price units per absolute factor unit)
 */
import { FactorVec } from "./FactorSpace";
import { SVI, SVIParams } from "../dualSurfaceModel";
import { black76Greeks } from "../../risk";

const EPS: FactorVec = [1e-4, 1e-4, 1e-3, 1e-4, 1e-4, 1e-6];

// Local helper: price from CC SVI at (K, T, F, isCall)
function priceFromSVI(cc: SVIParams, strike: number, T: number, F: number, isCall: boolean): number {
  const tiny = 1e-12;
  const k = Math.log(strike / Math.max(F, tiny));
  const varCC = Math.max(SVI.w(cc, k), tiny);
  const iv = Math.max(Math.sqrt(varCC / Math.max(T, tiny)), 1e-8);
  return black76Greeks(F, strike, Math.max(T, tiny), iv, isCall, 1.0).price;
}

export function factorGreeksFiniteDiff(
  cc: SVIParams,
  strike: number,
  T: number,
  F: number,
  isCall: boolean
): FactorVec {
  // Base price from CC
  const base = priceFromSVI(cc, strike, T, F, isCall);

  // Map factor → small transform in metric space
  const m0 = SVI.toMetrics(cc);

  function bump(i: number): number {
    // F bump handled separately (i === 5)
    if (i === 5) {
      const bumpedF = F + EPS[5];
      return priceFromSVI(cc, strike, T, bumpedF, isCall) - base;
    }

    const m = { ...m0 };
    switch (i) {
      case 0: m.L0    += EPS[0]; break;
      case 1: m.S0    += EPS[1]; break;
      case 2: m.C0    += EPS[2]; break;
      case 3: m.S_neg += EPS[3]; break;
      case 4: m.S_pos += EPS[4]; break;
      default: break;
    }

    const bumped = SVI.fromMetrics(m, {
      bMin: 0, sigmaMin: 1e-6, rhoMax: 0.999, sMax: 5, c0Min: 0.01,
      buckets: [], edgeParams: new Map(), rbfWidth: 0, ridgeLambda: 0,
      maxL0Move: 0, maxS0Move: 0, maxC0Move: 0
    });

    return priceFromSVI(bumped, strike, T, F, isCall) - base;
  }

  const g0 = bump(0) / EPS[0];
  const g1 = bump(1) / EPS[1];
  const g2 = bump(2) / EPS[2];
  const g3 = bump(3) / EPS[3];
  const g4 = bump(4) / EPS[4];
  const g5 = bump(5) / EPS[5];

  return [g0, g1, g2, g3, g4, g5];
}
