export * from './FactorRisk';
export * from './FactorSpace';
export * from './SigmaService';
export * from './factorGreeksLoader';
export * from './factors';

type Greeks = {
  price: number;
  delta: number;
  vega: number;
  gamma: number;
  theta: number;
};

const SQRT2PI = Math.sqrt(2 * Math.PI);
const phi = (x: number) => Math.exp(-0.5 * x * x) / SQRT2PI;
const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

function erf(x: number) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-x*x);
  return sign * y;
}

export function black76Greeks(F: number, K: number, T: number, sigma: number, isCall: boolean, df = 1): Greeks {
  if (!Number.isFinite(F) || !Number.isFinite(K) || F <= 0 || K <= 0) {
    return { price: NaN, delta: NaN, vega: NaN, gamma: NaN, theta: NaN };
  }
  if (T <= 0 || sigma <= 0) {
    const intrinsic = Math.max((isCall ? F - K : K - F), 0);
    return { price: df * intrinsic, delta: isCall ? df : -df, vega: 0, gamma: 0, theta: 0 };
  }
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sT;
  const d2 = d1 - sT;
  const callPrice = df * (F * Phi(d1) - K * Phi(d2));
  const putPrice = df * (K * Phi(-d2) - F * Phi(-d1));
  const price = isCall ? callPrice : putPrice;
  const delta = isCall ? df * Phi(d1) : df * (Phi(d1) - 1);
  const vega = df * F * phi(d1) * Math.sqrt(T);
  const gamma = df * phi(d1) / (F * sT);
  const r = df > 0 && T > 0 ? -Math.log(df) / T : 0;
  const undiscounted = isCall ? (F * Phi(d1) - K * Phi(d2)) : (K * Phi(-d2) - F * Phi(-d1));
  const thetaUndisc = -(F * phi(d1) * sigma) / (2 * Math.sqrt(T));
  const theta = (-r * df) * undiscounted + df * thetaUndisc;
  return { price, delta, vega, gamma, theta };
}
