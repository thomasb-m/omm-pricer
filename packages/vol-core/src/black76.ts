// Robust Black-76 (call) + implied vol, no reliance on Math.erf

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Fast erf approximation (Abramowitz–Stegun 7.1.26) */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x: number): number {
  if (x > 10) return 1;
  if (x < -10) return 0;
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Black-76 call price. F = forward, K = strike, T = year-frac, iv = vol, df = discount factor */
export function black76Call(F: number, K: number, T: number, iv: number, df = 1): number {
  if (!isFinite(F) || !isFinite(K) || F <= 0 || K <= 0 || !isFinite(df) || df <= 0) return NaN;
  if (T <= 0 || iv <= 0) {
    // At expiry (or zero vol) → intrinsic on forward measure
    const intrinsic = Math.max(F - K, 0);
    return df * intrinsic;
  }
  const volT = iv * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * iv * iv * T) / volT;
  const d2 = d1 - volT;
  return df * (F * normCdf(d1) - K * normCdf(d2));
}

/** Vega for Black-76 (call/put identical) */
function black76Vega(F: number, K: number, T: number, iv: number, df = 1): number {
  if (T <= 0 || iv <= 0) return 0;
  const volT = iv * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * iv * iv * T) / volT;
  return df * F * normPdf(d1) * Math.sqrt(T);
}

/**
 * Implied vol from call price for Black-76 (hybrid Newton / bisection).
 * Returns NaN if inputs inconsistent (e.g., price below intrinsic or above very-high-vol price).
 */
export function impliedVolFromPrice(price: number, F: number, K: number, T: number, df = 1, guess = 0.2): number {
  if (!isFinite(price) || price < 0 || !isFinite(F) || !isFinite(K) || F <= 0 || K <= 0 || !isFinite(T) || T < 0 || !isFinite(df) || df <= 0) {
    return NaN;
  }
  // Lower bound is near intrinsic at tiny vol
  const intrinsic = df * Math.max(F - K, 0);
  const epsP = 1e-12 * (1 + Math.abs(price));
  if (price <= intrinsic + epsP || T === 0) return 0; // effectively zero vol

  // Bracket price(monotone in vol)
  let lo = 1e-9, hi = 1.0;
  let plo = black76Call(F, K, T, lo, df);
  if (plo > price) return 0; // numerical safety
  let phi = black76Call(F, K, T, hi, df);
  let guard = 0;
  while (phi < price && guard++ < 60) {
    hi *= 2;
    phi = black76Call(F, K, T, hi, df);
    if (hi > 10) break; // 1000% vol hard cap
  }
  if (phi + epsP < price) return NaN; // cannot bracket target

  // Start from a guess inside the bracket
  let v = Math.min(Math.max(guess, lo), hi);
  let p = black76Call(F, K, T, v, df);

  // Hybrid loop
  const tolP = 1e-12 * (1 + price);
  const tolV = 1e-12;
  for (let i = 0; i < 100; i++) {
    const err = p - price;
    if (Math.abs(err) <= tolP) return v;

    const veg = black76Vega(F, K, T, v, df);
    let stepNewton = 0;
    let usedNewton = false;
    if (veg > 1e-14 && isFinite(veg)) {
      stepNewton = err / veg;
      let vNext = v - stepNewton;
      if (isFinite(vNext) && vNext > lo && vNext < hi) {
        v = vNext;
        usedNewton = true;
      }
    }
    if (!usedNewton) {
      // Bisection
      const mid = 0.5 * (lo + hi);
      v = mid;
    }

    // Keep bracket updated
    p = black76Call(F, K, T, v, df);
    if (!isFinite(p)) return NaN;
    if (p > price) {
      hi = v;
    } else {
      lo = v;
    }
    if (hi - lo < tolV) return 0.5 * (lo + hi);
  }

  // Final safeguard: return mid of bracket
  return 0.5 * (lo + hi);
}

export const __internals = { erf, normCdf, normPdf, black76Vega };
