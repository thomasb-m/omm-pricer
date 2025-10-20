const SQRT_2PI = Math.sqrt(2 * Math.PI);

function cnd(x: number): number {
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937, 
        a4 = -1.821255978, a5 = 1.330274429;
  const L = Math.abs(x);
  const k = 1.0 / (1.0 + 0.2316419 * L);
  const poly = ((((a5 * k + a4) * k + a3) * k + a2) * k + a1) * k;
  const approx = 1.0 - (Math.exp(-L * L / 2) / SQRT_2PI) * poly;
  return x >= 0 ? approx : 1 - approx;
}

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

export function black76Call(
  forward: number,
  strike: number,
  T: number,
  vol: number,
  df = 1.0
): number {
  if (T <= 0 || vol <= 0) {
    return Math.max(df * (forward - strike), 0);
  }
  const sigmaSqrtT = vol * Math.sqrt(T);
  const d1 = (Math.log(forward / strike)) / sigmaSqrtT + 0.5 * sigmaSqrtT;
  const d2 = d1 - sigmaSqrtT;
  return df * (forward * cnd(d1) - strike * cnd(d2));
}

export function black76Put(
  forward: number,
  strike: number,
  T: number,
  vol: number,
  df = 1.0
): number {
  const call = black76Call(forward, strike, T, vol, df);
  return call - df * (forward - strike);
}

export function vegaForward(
  forward: number,
  strike: number,
  T: number,
  vol: number,
  df = 1.0
): number {
  if (T <= 0 || vol <= 0) return 0;
  const sigmaSqrtT = vol * Math.sqrt(T);
  const d1 = (Math.log(forward / strike)) / sigmaSqrtT + 0.5 * sigmaSqrtT;
  return df * forward * Math.sqrt(T) * pdf(d1);
}

export function impliedVolFromPrice(
  isCall: boolean,
  price: number,
  forward: number,
  strike: number,
  T: number,
  df = 1.0
): number {
  const intrinsic = Math.max(
    df * (isCall ? forward - strike : strike - forward),
    0
  );
  const tv = price - intrinsic;
  if (tv <= 0) return 1e-6;

  let lo = 1e-6, hi = 5.0;
  const f = (sigma: number) =>
    (isCall
      ? black76Call(forward, strike, T, sigma, df)
      : black76Put(forward, strike, T, sigma, df)) - price;

  let flo = f(lo), fhi = f(hi);
  
  for (let i = 0; i < 20 && flo * fhi > 0; i++) {
    if (fhi < 0) hi *= 2; else lo /= 2;
    flo = f(lo); fhi = f(hi);
    if (hi > 10 || lo < 1e-12) break;
  }

  let mid = 0;
  for (let i = 0; i < 60; i++) {
    mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (Math.abs(fm) < 1e-10) break;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } 
    else { lo = mid; flo = fm; }
  }

  let sigma = mid;
  for (let i = 0; i < 10; i++) {
    const priceAtSigma = isCall
      ? black76Call(forward, strike, T, sigma, df)
      : black76Put(forward, strike, T, sigma, df);
    const diff = priceAtSigma - price;
    const veg = vegaForward(forward, strike, T, sigma, df);
    if (Math.abs(diff) < 1e-12 || veg === 0) break;
    sigma = Math.max(1e-9, sigma - diff / veg);
  }

  return Math.max(1e-9, Math.min(sigma, 10));
}
