import { SVIParams } from "@core-types";
import { EPS_TV, EPS_T, EPS_CONVEXITY, MAX_WING_SLOPE } from "./constants.js";
import type { KRel } from "./conventions.js";

export interface SVIValidation {
  valid: boolean;
  errors: string[];
}

function sviTotalVarianceRaw(k: KRel, p: SVIParams): number {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.sqrt(x * x + p.sigma * p.sigma));
}

export function validateSVIParams(p: SVIParams): SVIValidation {
  const errors: string[] = [];

  if (p.b < 0) errors.push(`b must be ≥ 0, got ${p.b}`);
  if (Math.abs(p.rho) >= 1) errors.push(`|ρ| must be < 1, got ${p.rho}`);
  if (p.sigma <= 0) errors.push(`σ must be > 0, got ${p.sigma}`);

  const leftSlope = p.b * (1 - p.rho);
  const rightSlope = p.b * (1 + p.rho);

  if (leftSlope < 0) errors.push(`Left wing slope ${leftSlope.toFixed(4)} < 0`);
  if (rightSlope < 0) errors.push(`Right wing slope ${rightSlope.toFixed(4)} < 0`);
  if (leftSlope > MAX_WING_SLOPE) errors.push(`Left wing slope > ${MAX_WING_SLOPE}`);
  if (rightSlope > MAX_WING_SLOPE) errors.push(`Right wing slope > ${MAX_WING_SLOPE}`);

  // Convexity check
  const kGrid: KRel[] = [];
  for (let k = -2; k <= 2; k += 0.1) {
    kGrid.push(k as KRel);
  }

  for (let i = 1; i < kGrid.length - 1; i++) {
    const k0 = kGrid[i - 1];
    const k1 = kGrid[i];
    const k2 = kGrid[i + 1];

    const w0 = sviTotalVarianceRaw(k0, p);
    const w1 = sviTotalVarianceRaw(k1, p);
    const w2 = sviTotalVarianceRaw(k2, p);

    const d2w = (w2 - 2 * w1 + w0) / Math.pow(k1 - k0, 2);

    if (d2w < -EPS_CONVEXITY) {
      errors.push(`Convexity violation at k=${k1.toFixed(2)}`);
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export function sviTotalVariance(k: KRel, p: SVIParams): number {
  const w = sviTotalVarianceRaw(k, p);

  if (w < -1e-10) {
    console.warn(`Negative w=${w.toFixed(6)} at k=${k.toFixed(4)}`);
  }

  return Math.max(EPS_TV, w);
}

export function sviIV(k: KRel, T: number, p: SVIParams): number {
  const w = sviTotalVariance(k, p);
  return Math.sqrt(w / Math.max(EPS_T, T));
}
