import { SVIParams } from "@core-types";

/**
 * Evaluate raw SVI total variance and turn into implied vol at (k, T).
 * k = ln(K/F) log-moneyness; T in years.
 */
export function sviTotalVariance(k: number, p: SVIParams): number {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.sqrt(x * x + p.sigma * p.sigma));
}

export function sviIV(k: number, T: number, p: SVIParams): number {
  const w = Math.max(1e-12, sviTotalVariance(k, p));
  return Math.sqrt(w / Math.max(1e-12, T));
}
