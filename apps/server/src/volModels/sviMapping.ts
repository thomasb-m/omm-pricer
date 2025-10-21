// apps/server/src/volModels/sviMapping.ts
// Dual-compatible module exports (CJS + ESM)

export type SVIParams = { a: number; b: number; rho: number; m: number; sigma: number };
export type TraderMetrics = { S0: number; C0: number; L0: number; S_pos: number; S_neg: number };
export type Config = Record<string, any>;

// Example implementation placeholders
export function toMetrics(svi: SVIParams): TraderMetrics {
  const S0 = svi.b * svi.rho;
  const b = svi.b;
  const S_pos = b * (1 + svi.rho);
  const S_neg = b * (1 - svi.rho);
  return { S0, C0: 0.5, L0: 0.5, S_pos, S_neg };
}

export function fromMetrics(m: TraderMetrics, cfg: Config): SVIParams {
  const b = 0.5 * (m.S_pos + m.S_neg);
  const rho = (m.S_pos - m.S_neg) / Math.max(b * 2, 1e-12);
  return { a: 0.1, b, rho, m: 0, sigma: 0.2 };
}

export function s0FromWings(m: TraderMetrics): number {
  const sum = m.S_pos + m.S_neg;
  const b = 0.5 * sum;
  const rho = (m.S_pos - m.S_neg) / Math.max(Math.abs(sum), 1e-12);
  return b * rho;
}

// Back-compat grouped export
export const SVI = { toMetrics, fromMetrics };

// Default export for interop between ESM and CJS
const defaultExport = { SVI, toMetrics, fromMetrics, s0FromWings };
export default defaultExport;
