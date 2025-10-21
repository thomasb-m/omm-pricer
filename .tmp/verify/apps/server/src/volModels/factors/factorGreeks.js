"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.factorGreeksFiniteDiff = factorGreeksFiniteDiff;
const sviMapping_1 = require("./sviMapping");
const flags_1 = require("../flags");
const invariants_1 = require("./invariants");
// If needed, adjust this import to your project:
const pricing_1 = require("./pricing"); // <-- change path if your pricing helper lives elsewhere
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const stepAbs = (v, rel = 1e-3, abs = 1e-4) => Math.max(Math.abs(v) * rel, abs);
function bumpMetricsConstrained(m0, idx, h, cfg) {
    const m = { ...m0 };
    const rhoMax = cfg.rhoMax ?? 0.999;
    const bMin = cfg.bMin ?? 1e-8;
    const c0Min = cfg.c0Min ?? 1e-8;
    switch (idx) {
        case 0: // L0
            m.L0 += h;
            break;
        case 1: { // S0 — hold b fixed, change rho via wings
            const Ssum = m.S_pos + m.S_neg; // = 2b
            const b = Math.max(Ssum / 2, bMin);
            const S0_new = m.S0 + h;
            const rho_new = clamp(S0_new / b, -rhoMax, rhoMax);
            m.S_pos = b * (1 + rho_new);
            m.S_neg = b * (1 - rho_new);
            m.S0 = b * rho_new; // keep self-consistent
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
        (0, invariants_1.assertMetricsInvariants)(m);
    }
    return m;
}
function factorGreeksFiniteDiff(cc, strike, T, F, isCall, cfg, debug = false) {
    const Tpos = Math.max(T, 1e-8);
    const baseM = sviMapping_1.SVI.toMetrics(cc);
    if (process.env.NODE_ENV !== "production") {
        (0, invariants_1.assertMetricsInvariants)(baseM);
    }
    const priceFromMetrics = (m) => {
        const p = sviMapping_1.SVI.fromMetrics(m, cfg, { preserveBumps: true });
        return (0, pricing_1.priceFromCC)(p, strike, Tpos, F, isCall);
    };
    const basePrice = (0, pricing_1.priceFromCC)(cc, strike, Tpos, F, isCall);
    if (debug) {
        console.log(`[greeks] K=${strike} T=${Tpos.toFixed(6)} F=${F} P=${basePrice.toFixed(6)}`);
        console.log(`[greeks] Metrics:`, baseM);
    }
    // Step sizes
    const hL0 = stepAbs(baseM.L0);
    const hS0 = stepAbs(baseM.S0);
    const hC0 = stepAbs(baseM.C0);
    const hSneg = stepAbs(baseM.S_neg);
    const hSpos = stepAbs(baseM.S_pos);
    const hF = Math.max(Math.abs(F) * 1e-4, 1e-4);
    const bump = (idx, h) => bumpMetricsConstrained(baseM, idx, h, cfg);
    // Central differences (guarded by flag but we default true)
    const cd = (idx, h) => {
        const mp = bump(idx, +h);
        const mm = bump(idx, -h);
        return (priceFromMetrics(mp) - priceFromMetrics(mm)) / (2 * h);
    };
    const gL0 = flags_1.FLAGS.greeks_centralDiff ? cd(0, hL0) : (priceFromMetrics(bump(0, +hL0)) - basePrice) / hL0;
    const gS0 = flags_1.FLAGS.greeks_centralDiff ? cd(1, hS0) : (priceFromMetrics(bump(1, +hS0)) - basePrice) / hS0;
    const gC0 = flags_1.FLAGS.greeks_centralDiff ? cd(2, hC0) : (priceFromMetrics(bump(2, +hC0)) - basePrice) / hC0;
    const gSN = flags_1.FLAGS.greeks_centralDiff ? cd(3, hSneg) : (priceFromMetrics(bump(3, +hSneg)) - basePrice) / hSneg;
    const gSP = flags_1.FLAGS.greeks_centralDiff ? cd(4, hSpos) : (priceFromMetrics(bump(4, +hSpos)) - basePrice) / hSpos;
    // Forward (keep K fixed)
    const pFp = (0, pricing_1.priceFromCC)(cc, strike, Tpos, F + hF, isCall);
    const pFm = (0, pricing_1.priceFromCC)(cc, strike, Tpos, F - hF, isCall);
    const gF = (pFp - pFm) / (2 * hF);
    const clean = (x) => (Number.isFinite(x) ? x : 0);
    const out = [clean(gL0), clean(gS0), clean(gC0), clean(gSN), clean(gSP), clean(gF)];
    if (debug) {
        console.log(`[greeks] g = ${out.map(v => xfmt(v)).join(", ")}`);
    }
    return out;
}
const xfmt = (x) => Number.isFinite(x) ? x.toExponential(6) : "NaN";
