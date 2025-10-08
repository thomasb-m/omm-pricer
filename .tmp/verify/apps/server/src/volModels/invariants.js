"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertMetricsInvariants = assertMetricsInvariants;
function assertMetricsInvariants(m, eps = 1e-9) {
    const b = 0.5 * (m.S_pos + m.S_neg);
    const denom = Math.max(m.S_pos + m.S_neg, eps);
    const rho = (m.S_pos - m.S_neg) / denom;
    const S0_expected = b * rho;
    if (!Number.isFinite(b) || b <= 0) {
        throw new Error(`[metrics] invalid b: ${b}`);
    }
    if (!Number.isFinite(rho) || Math.abs(rho) >= 1) {
        throw new Error(`[metrics] invalid rho: ${rho}`);
    }
    if (Math.abs(m.S0 - S0_expected) > 1e-6) {
        throw new Error(`[metrics] S0 mismatch: S0=${m.S0}, b*rho=${S0_expected}`);
    }
}
