// packages/vol-core/src/black76.ts
// Minimal, robust Black-76 call pricing + vega + implied vol solver.
const SQRT2 = Math.SQRT2;
const SQRT2PI = Math.sqrt(2 * Math.PI);

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

// Abramowitz-Stegun erf approximation for stable norm CDF
function erf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / SQRT2));
}

export function d1(F: number, K: number, T: number, iv: number): number {
  return (Math.log(F / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
}

export function d2(F: number, K: number, T: number, iv: number): number {
  return d1(F, K, T, iv) - iv * Math.sqrt(T);
}

export function black76Call(F: number, K: number, T: number, iv: number, df: number = 1.0): number {
  if (T <= 0) return Math.max(F - K, 0) * df;
  const _d1 = d1(F, K, T, iv);
  const _d2 = _d1 - iv * Math.sqrt(T);
  return df * (F * normCdf(_d1) - K * normCdf(_d2));
}

export function vega(F: number, K: number, T: number, iv: number, df: number = 1.0): number {
  if (T <= 0) return 0;
  const _d1 = d1(F, K, T, iv);
  return df * F * Math.sqrt(T) * normPdf(_d1);
}

/**
 * Safe implied vol via bracketed Newton—falls back to bisection if needed.
 * Returns a non-negative IV; caps at ivMax.
 */
export function impliedVolFromPrice(
  targetPrice: number,
  F: number,
  K: number,
  T: number,
  df: number = 1.0,
  ivInit: number = 0.3,
  ivMax: number = 5.0,
  tol: number = 1e-10,
  maxIter: number = 100
): number {
  if (T <= 0) return 0;
  const intrinsic = Math.max(F - K, 0) * df;
  const minPrice = intrinsic;
  const maxPrice = df * F;

  const p = Math.min(Math.max(targetPrice, minPrice), maxPrice);

  let ivLo = 1e-8;
  let ivHi = Math.min(ivMax, 5.0);
  const priceAt = (vol: number) => black76Call(F, K, T, vol, df);
  while (priceAt(ivLo) > p && ivLo > 1e-12) ivLo *= 0.5;
  while (priceAt(ivHi) < p && ivHi < ivMax) ivHi *= 1.5;

  let iv = Math.min(Math.max(ivInit, ivLo), ivHi);

  for (let i = 0; i < maxIter; i++) {
    const price = priceAt(iv);
    const diff = price - p;
    if (Math.abs(diff) <= tol * (1 + p)) return Math.max(iv, 0);

    const v = vega(F, K, T, iv, df);
    if (v > 1e-12) {
      const step = diff / v;
      const cand = iv - step;
      if (cand > ivLo && cand < ivHi && Number.isFinite(cand)) {
        iv = cand;
        continue;
      }
    }
    if (diff > 0) ivHi = iv; else ivLo = iv;
    iv = 0.5 * (ivLo + ivHi);
  }
  return Math.max(iv, 0);
}
