/**
 * Finite-difference factor greeks g_i = ∂Price/∂θ_i
 * Self-contained: CC (SVI) -> Black-76 price.
 * Factors: [L0, S0, C0, S_neg, S_pos, F]
 */
import { FactorVec } from "./FactorSpace";
import { SVI, SVIParams, TraderMetrics } from "../dualSurfaceModel";
import { black76Greeks } from "../../risk";

const tiny = 1e-12;

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
  isCall: boolean,
  cfg: any,
  debug = false
): FactorVec {
  const Tpos = Math.max(T, 1e-8);

  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const chooseStepAbs = (v: number, rel = 1e-3, abs = 1e-4) =>
    Math.max(Math.abs(v) * rel, abs);

  function bumpMetrics(m0: TraderMetrics, idx: number, h: number): TraderMetrics {
    const m = { ...m0 };
    const rhoMax = cfg.rhoMax ?? 0.999;
    const bMin   = cfg.bMin   ?? 1e-8;
    const c0Min  = cfg.c0Min  ?? 1e-8;

    switch (idx) {
      case 0: {
        m.L0 += h;
        break;
      }
      case 1: {
        const Ssum = m.S_pos + m.S_neg;
        const b = Math.max(Ssum / 2, bMin);
        const S0_new = m.S0 + h;
        const rho_new = clamp(S0_new / b, -rhoMax, rhoMax);
        m.S_pos = b * (1 + rho_new);
        m.S_neg = b * (1 - rho_new);
        m.S0 = b * rho_new;
        break;
      }
      case 2: {
        m.C0 = Math.max(m.C0 + h, c0Min);
        break;
      }
      case 3: {
        m.S_neg = Math.max(m.S_neg + h, 0);
        const b = (m.S_pos + m.S_neg) / 2;
        const rho = (m.S_pos - m.S_neg) / Math.max(m.S_pos + m.S_neg, bMin * 2);
        m.S0 = b * rho;
        break;
      }
      case 4: {
        m.S_pos = Math.max(m.S_pos + h, 0);
        const b = (m.S_pos + m.S_neg) / 2;
        const rho = (m.S_pos - m.S_neg) / Math.max(m.S_pos + m.S_neg, bMin * 2);
        m.S0 = b * rho;
        break;
      }
    }
    return m;
  }

  const priceFromMetrics = (m: TraderMetrics) =>
    priceFromCC(SVI.fromMetrics(m, cfg, { preserveBumps: true }), strike, Tpos, F, isCall);

  const basePrice = priceFromCC(cc, strike, Tpos, F, isCall);
  const baseM = SVI.toMetrics(cc);

  const hL0 = chooseStepAbs(baseM.L0);
  const hS0 = chooseStepAbs(baseM.S0);
  const hC0 = chooseStepAbs(baseM.C0);
  const hSneg = chooseStepAbs(baseM.S_neg);
  const hSpos = chooseStepAbs(baseM.S_pos);
  const hF = Math.max(Math.abs(F) * 1e-4, 1e-4);

  const mL0p = bumpMetrics(baseM, 0, +hL0);
  const mL0m = bumpMetrics(baseM, 0, -hL0);
  const gL0 = (priceFromMetrics(mL0p) - priceFromMetrics(mL0m)) / (2 * hL0);

  const mS0p = bumpMetrics(baseM, 1, +hS0);
  const mS0m = bumpMetrics(baseM, 1, -hS0);
  const gS0 = (priceFromMetrics(mS0p) - priceFromMetrics(mS0m)) / (2 * hS0);

  const mC0p = bumpMetrics(baseM, 2, +hC0);
  const mC0m = bumpMetrics(baseM, 2, -hC0);
  const gC0 = (priceFromMetrics(mC0p) - priceFromMetrics(mC0m)) / (2 * hC0);

  const mSNp = bumpMetrics(baseM, 3, +hSneg);
  const mSNm = bumpMetrics(baseM, 3, -hSneg);
  const gSN = (priceFromMetrics(mSNp) - priceFromMetrics(mSNm)) / (2 * hSneg);

  const mSPp = bumpMetrics(baseM, 4, +hSpos);
  const mSPm = bumpMetrics(baseM, 4, -hSpos);
  const gSP = (priceFromMetrics(mSPp) - priceFromMetrics(mSPm)) / (2 * hSpos);

  const pFp = priceFromCC(cc, strike, Tpos, F + hF, isCall);
  const pFm = priceFromCC(cc, strike, Tpos, F - hF, isCall);
  const gF = (pFp - pFm) / (2 * hF);

  const clean = (x: number) => (Number.isFinite(x) ? x : 0);
  return [clean(gL0), clean(gS0), clean(gC0), clean(gSN), clean(gSP), clean(gF)];
}
