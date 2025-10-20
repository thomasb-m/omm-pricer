// src/utils/variance.ts
import { tauIntegral } from "../pricing/seasonality";

export function ivFromTotalVariance(nowMs: number, expiryMs: number, wTotal: number): number {
  const tau = Math.max(tauIntegral(nowMs, expiryMs), 1e-6);
  return Math.sqrt(Math.max(wTotal, 0) / tau);
}
