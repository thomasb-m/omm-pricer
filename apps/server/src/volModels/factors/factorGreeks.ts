// apps/server/src/volModels/factorGreeks.ts
import type { SVIParams, TraderMetrics, Config } from "./sviMapping";
import { SVI } from "./sviMapping";
import { FLAGS } from "../flags";
import { assertMetricsInvariants } from "./invariants";
// If needed, adjust this import to your project:
import { priceFromCC } from "./pricing"; // <-- change path if your pricing helper lives elsewhere

export type FactorVec = [number, number, number, number, number, number]; // [L0,S0,C0,S_neg,S_pos,F]

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const stepAbs = (v: number, rel = 1e-3, abs = 1e-4) => Math.max(Math.abs(v) * rel, abs);

function bumpMetricsConstrained(m0: TraderMetrics, idx: number, h: number, cfg: Config): TraderMetrics {
  const m = { ...m0 };
  const rhoMax = cfg.rhoMax ?? 0.999;
  const bMin   = cfg.bMin   ?? 1e-8;
  const c0Min  = cfg.c0Min  ?? 1e-8;

  switch (idx) {
    case 0: // L0
      m.L0 += h;
      break;

    case 1: { // S0 — hold b fixed, change rho via wings
      const Ssum = m.S_pos + m.S_neg;           // = 2b
      const b = Math.max(Ssum / 2, bMin);
      const S0_new = m.S0 + h;
      const rho_new = clamp(S0_new / b, -rhoMax, rhoMax);
      m.S_pos = b * (1 + rho_new);
      m.S_neg = b * (1 - rho_new);
      m.S0    = b * rho_new; // keep self-consistent
      break;
    }

    case 2: // C0
      m.C0 = Math.max(m.C0 + h, c0Min);
      break;

    case 3: { // S_neg
      m.S_neg = Math.max(m.S_neg + h, 0);
      // keep S0 consistent with wings
      const Ssum = m.S_pos + m.S_neg;
      const b = Math.max(Ssum / 2, bMin);
      const rho = (m.S_pos - m.S_neg) / Math.max(Ssum, 2 * bMin);
      m.S0 = b * rho;
      break;
    }

    case 4: { // S_pos
      m.S_pos = Math.max(m.S_pos + h, 0);
      // keep S0 consistent with wings
      const Ssum = m.S_pos + m.S_neg;
      const b = Math.max(Ssum / 2, bMin);
      const rho = (m.S_pos - m.S_neg) / Math.max(Ssum, 2 * bMin);
      m.S0 = b * rho;
      break;
    }

    default:
      // F is handled separately
      break;
  }

  // Dev-only invariant check
  if (process.env.NODE_ENV !== "production") {
    assertMetricsInvariants(m);
  }

  return m;
}

export function factorGreeksFiniteDiff(
  cc: SVIParams,
  strike: number,
  T: number,
  F: number,
  isCall: boolean,
  cfg: Config,
  debug = false
): FactorVec {
  const Tpos = Math.max(T, 1e-8);

  const baseM = SVI.toMetrics(cc);
  if (process.env.NODE_ENV !== "production") {
    assertMetricsInvariants(baseM);
  }

  const priceFromMetrics = (m: TraderMetrics) => {
    const p = SVI.fromMetrics(m, cfg, { preserveBumps: true });
    return priceFromCC(p, strike, Tpos, F, isCall);
  };

  const basePrice = priceFromCC(cc, strike, Tpos, F, isCall);
  if (debug) {
    console.log(`[greeks] K=${strike} T=${Tpos.toFixed(6)} F=${F} P=${basePrice.toFixed(6)}`);
    console.log(`[greeks] Metrics:`, baseM);
  }

  // Step sizes
  const hL0   = stepAbs(baseM.L0);
  const hS0   = stepAbs(baseM.S0);
  const hC0   = stepAbs(baseM.C0);
  const hSneg = stepAbs(baseM.S_neg);
  const hSpos = stepAbs(baseM.S_pos);
  const hF    = Math.max(Math.abs(F) * 1e-4, 1e-4);

  const bump = (idx: number, h: number) =>
    bumpMetricsConstrained(baseM, idx, h, cfg);

  // Central differences (guarded by flag but we default true)
  const cd = (idx: number, h: number) => {
    const mp = bump(idx, +h);
    const mm = bump(idx, -h);
    return (priceFromMetrics(mp) - priceFromMetrics(mm)) / (2 * h);
  };

  const gL0 = FLAGS.greeks_centralDiff ? cd(0, hL0)   : (priceFromMetrics(bump(0, +hL0))  - basePrice) / hL0;
  const gS0 = FLAGS.greeks_centralDiff ? cd(1, hS0)   : (priceFromMetrics(bump(1, +hS0))  - basePrice) / hS0;
  const gC0 = FLAGS.greeks_centralDiff ? cd(2, hC0)   : (priceFromMetrics(bump(2, +hC0))  - basePrice) / hC0;
  const gSN = FLAGS.greeks_centralDiff ? cd(3, hSneg) : (priceFromMetrics(bump(3, +hSneg))- basePrice) / hSneg;
  const gSP = FLAGS.greeks_centralDiff ? cd(4, hSpos) : (priceFromMetrics(bump(4, +hSpos))- basePrice) / hSpos;

  // Forward (keep K fixed)
  const pFp = priceFromCC(cc, strike, Tpos, F + hF, isCall);
  const pFm = priceFromCC(cc, strike, Tpos, F - hF, isCall);
  const gF  = (pFp - pFm) / (2 * hF);

  const clean = (x: number) => (Number.isFinite(x) ? x : 0);
  const out: FactorVec = [clean(gL0), clean(gS0), clean(gC0), clean(gSN), clean(gSP), clean(gF)];

  if (debug) {
    console.log(`[greeks] g = ${out.map(v => xfmt(v)).join(", ")}`);
  }
  return out;
}

const xfmt = (x: number) => Number.isFinite(x) ? x.toExponential(6) : "NaN";
