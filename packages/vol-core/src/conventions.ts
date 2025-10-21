export const CONVENTIONS = {
  K_CONVENTION: "ln(K/F)" as const,
  SVI_FAMILY: "svi_raw" as const,
  T_UNIT: "years" as const,
  IV_UNIT: "ann_stdev" as const,
  W_UNIT: "total_variance" as const,
  PRICE_UNIT: "pv" as const,
} as const;

// Branded type for moneyness
export type KRel = number & { __brand: "k_ln_K_over_F" };

/**
 * Compute forward log-moneyness: k = ln(K/F)
 * This is the ONLY way to compute k in the codebase.
 */
export function kRel(F: number, K: number): KRel {
  if (F <= 0 || K <= 0) {
    throw new Error(`Invalid inputs for kRel: F=${F}, K=${K}`);
  }
  return Math.log(K / F) as KRel;
}

export function isValidKRel(k: number): boolean {
  return Number.isFinite(k);
}

// Helper: convert raw ln(K/F) to branded KRel
export const asKRel = (k: number): KRel => k as KRel;
