"use strict";
// apps/server/src/volModels/sviMapping.ts
// Dual-compatible module exports (CJS + ESM)
Object.defineProperty(exports, "__esModule", { value: true });
exports.SVI = void 0;
exports.toMetrics = toMetrics;
exports.fromMetrics = fromMetrics;
exports.s0FromWings = s0FromWings;
// Example implementation placeholders
function toMetrics(svi) {
    var S0 = svi.b * svi.rho;
    var b = svi.b;
    var S_pos = b * (1 + svi.rho);
    var S_neg = b * (1 - svi.rho);
    return { S0: S0, C0: 0.5, L0: 0.5, S_pos: S_pos, S_neg: S_neg };
}
function fromMetrics(m, cfg) {
    var b = 0.5 * (m.S_pos + m.S_neg);
    var rho = (m.S_pos - m.S_neg) / Math.max(b * 2, 1e-12);
    return { a: 0.1, b: b, rho: rho, m: 0, sigma: 0.2 };
}
function s0FromWings(m) {
    var sum = m.S_pos + m.S_neg;
    var b = 0.5 * sum;
    var rho = (m.S_pos - m.S_neg) / Math.max(Math.abs(sum), 1e-12);
    return b * rho;
}
// Back-compat grouped export
exports.SVI = { toMetrics: toMetrics, fromMetrics: fromMetrics };
// Default export for interop between ESM and CJS
var defaultExport = { SVI: exports.SVI, toMetrics: toMetrics, fromMetrics: fromMetrics, s0FromWings: s0FromWings };
exports.default = defaultExport;
