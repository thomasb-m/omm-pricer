// Black-76 pricing functions for Deribit BTC Options

// Math helpers
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function N(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function n(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ===================== Black-76 Pricing =====================

export interface Black76Params {
  F: number;        // Futures price (USD)
  K: number;        // Strike price (USD)
  T: number;        // Time to expiry (years)
  sigma: number;    // Implied volatility
  isCall: boolean;  // Call or Put
  df?: number;      // Discount factor (default 1.0 for futures)
}

export interface Black76Result {
  price: number;    // Option price in BTC
  delta: number;    // Delta in BTC per BTC
  gamma: number;    // Gamma per $1 move
  vega: number;     // Vega in BTC per vol-pt
  theta: number;    // Theta in BTC per day
  d1: number;       // d1 from Black-76
  d2: number;       // d2 from Black-76
}

/**
 * Black-76 option pricing for futures options
 * @param params Black-76 parameters
 * @returns Option price and Greeks in BTC
 */
export function black76Price(params: Black76Params): number {
  const { F, K, T, sigma, isCall, df = 1.0 } = params;
  
  const sT = Math.max(1e-12, sigma * Math.sqrt(Math.max(T, 1e-12)));
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sT;
  const d2 = d1 - sT;
  
  if (isCall) {
    return df * (F * N(d1) - K * N(d2));
  }
  return df * (K * N(-d2) - F * N(-d1));
}

/**
 * Black-76 Greeks calculation
 * @param params Black-76 parameters
 * @returns Greeks in BTC terms
 */
export function black76Greeks(params: Black76Params): Black76Result {
  const { F, K, T, sigma, isCall, df = 1.0 } = params;
  
  const sT = Math.max(1e-12, sigma * Math.sqrt(Math.max(T, 1e-12)));
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sT;
  const d2 = d1 - sT;
  const pdf = n(d1);
  
  const vega = df * F * pdf * Math.sqrt(Math.max(T, 1e-12));
  const gamma = df * pdf / (F * sT);
  const delta = (isCall ? 1 : -1) * df * N((isCall ? 1 : -1) * d1);
  
  // Simplified theta calculation
  const theta = -df * F * pdf * sigma / (2 * Math.sqrt(T)) - 
                (isCall ? 1 : -1) * df * F * N((isCall ? 1 : -1) * d1) * 0.01;
  
  return {
    price: black76Price(params),
    delta,
    gamma,
    vega,
    theta,
    d1,
    d2
  };
}

// ===================== SVI Smile Model =====================

export interface SviParams {
  a: number;      // Level parameter
  b: number;      // Volatility of volatility
  rho: number;     // Correlation parameter
  m: number;      // Mean reversion level
  s: number;      // Volatility of log-moneyness
}

export interface VolNudges {
  parallelBps: number;        // Parallel vol shift in bps
  skewBps: number;            // Skew adjustment in bps
  curvatureBps: number;       // Curvature adjustment in bps
}

/**
 * SVI total variance function
 * @param k Log-moneyness (ln(K/F))
 * @param params SVI parameters
 * @returns Total variance
 */
export function sviTotalVariance(k: number, params: SviParams): number {
  const { a, b, rho, m, s } = params;
  const x = k - m;
  return a + b * (rho * x + Math.sqrt(x * x + s * s));
}

/**
 * SVI implied volatility
 * @param k Log-moneyness (ln(K/F))
 * @param T Time to expiry
 * @param params SVI parameters
 * @returns Implied volatility
 */
export function sviImpliedVolatility(k: number, T: number, params: SviParams): number {
  const w = sviTotalVariance(k, params);
  return Math.sqrt(Math.max(1e-12, w / Math.max(T, 1e-12)));
}

/**
 * Apply global vol nudges to SVI model
 * @param k Log-moneyness (ln(K/F))
 * @param T Time to expiry
 * @param sviParams SVI parameters
 * @param nudges Global vol nudges
 * @returns Adjusted implied volatility
 */
export function applyVolNudges(
  k: number, 
  T: number, 
  sviParams: SviParams, 
  nudges: VolNudges
): number {
  const baseIV = sviImpliedVolatility(k, T, sviParams);
  
  const parallelShift = nudges.parallelBps / 10000;
  const skewShift = (nudges.skewBps / 10000) * k;
  const curvatureShift = (nudges.curvatureBps / 10000) * k * k;
  
  return Math.max(0.001, baseIV + parallelShift + skewShift + curvatureShift);
}

// ===================== Quote Model =====================

export interface QuoteParams {
  baseBps: number;           // Base spread in vol bps
  wDelta: number;             // Risk weight for delta
  wGamma: number;             // Risk weight for gamma
  wVega: number;              // Risk weight for vega
  maxDSigmaBps: number;       // Cap on vol add
  minWidthBtc: number;        // Min width in BTC
  maxWidthBtc: number;         // Max width in BTC
}

export interface QuoteResult {
  modelVol: number;          // SVI model volatility
  midBtc: number;            // Mid price in BTC
  bidBtc: number;            // Bid price in BTC
  askBtc: number;            // Ask price in BTC
  midUsd: number;            // Mid price in USD
  bidUsd: number;            // Bid price in USD
  askUsd: number;            // Ask price in USD
  greeks: Black76Result;
  dSigmaTot: number;         // Total vol add in bps
  widthBtc: number;          // Quote width in BTC
  appliedCaps: {
    dSigmaCapped: boolean;
    widthCapped: boolean;
  };
}

/**
 * Calculate option quotes using SVI model and risk adjustments
 * @param F Futures price (USD)
 * @param K Strike price (USD)
 * @param T Time to expiry (years)
 * @param isCall Call or Put
 * @param sviParams SVI parameters
 * @param volNudges Global vol nudges
 * @param quoteParams Quote parameters
 * @param indexPrice BTC index price (USD)
 * @param qty Number of contracts
 * @returns Quote result
 */
export function calculateQuotes(
  F: number,
  K: number,
  T: number,
  isCall: boolean,
  sviParams: SviParams,
  volNudges: VolNudges,
  quoteParams: QuoteParams,
  indexPrice: number,
  qty: number = 1
): QuoteResult {
  // 1. Model vol from SVI
  const k = Math.log(K / F);
  const modelVol = applyVolNudges(k, T, sviParams, volNudges);
  
  // 2. Mid price in BTC
  const midBtc = black76Price({ F, K, T, sigma: modelVol, isCall });
  
  // 3. Greeks in BTC terms
  const greeks = black76Greeks({ F, K, T, sigma: modelVol, isCall });
  
  // 4. Risk add (vol bps)
  const deltaRisk = quoteParams.wDelta * Math.pow(greeks.delta * qty, 2);
  const gammaRisk = quoteParams.wGamma * Math.pow(greeks.gamma * qty, 2);
  const vegaRisk = quoteParams.wVega * Math.pow(greeks.vega * qty, 2);
  const dSigmaRisk = Math.min(quoteParams.maxDSigmaBps / 10000, deltaRisk + gammaRisk + vegaRisk);
  
  // 5. Total vol add (bps)
  const dSigmaTot = (quoteParams.baseBps / 10000) + dSigmaRisk;
  
  // 6. Width in BTC
  const vegaEff = Math.max(1e-8, Math.abs(greeks.vega) * Math.max(1, Math.abs(qty)));
  const widthBtc = Math.max(quoteParams.minWidthBtc, Math.min(quoteParams.maxWidthBtc, vegaEff * dSigmaTot));
  
  // 7. Bid/Ask in BTC
  const bidBtc = midBtc - 0.5 * widthBtc;
  const askBtc = midBtc + 0.5 * widthBtc;
  
  // 8. USD mirrors
  const midUsd = midBtc * indexPrice;
  const bidUsd = bidBtc * indexPrice;
  const askUsd = askBtc * indexPrice;
  
  return {
    modelVol,
    midBtc,
    bidBtc,
    askBtc,
    midUsd,
    bidUsd,
    askUsd,
    greeks,
    dSigmaTot: dSigmaTot * 10000, // Convert back to bps
    widthBtc,
    appliedCaps: {
      dSigmaCapped: dSigmaRisk < (deltaRisk + gammaRisk + vegaRisk),
      widthCapped: widthBtc === quoteParams.maxWidthBtc
    }
  };
}

// ===================== Risk Calculations =====================

/**
 * Calculate portfolio risk metrics
 * @param positions Array of positions
 * @param marks Current marks
 * @returns Risk metrics
 */
export function calculatePortfolioRisk(
  positions: Array<{
    instrument: string;
    side: "LONG" | "SHORT";
    qty: number;
  }>,
  marks: Record<string, {
    mark_iv: number;
    F: number;
    T_years: number;
  }>
): {
  totalDelta: number;
  totalGamma: number;
  totalVega: number;
  totalTheta: number;
  totalPv: number;
} {
  let totalDelta = 0;
  let totalGamma = 0;
  let totalVega = 0;
  let totalTheta = 0;
  let totalPv = 0;

  positions.forEach(pos => {
    const mark = marks[pos.instrument];
    if (!mark) return;

    const strike = parseFloat(pos.instrument.split('-')[2]);
    const isCall = pos.instrument.includes('-C');
    const signedQty = pos.side === 'LONG' ? pos.qty : -pos.qty;
    
    const greeks = black76Greeks({
      F: mark.F,
      K: strike,
      T: mark.T_years,
      sigma: mark.mark_iv,
      isCall
    });
    
    totalDelta += greeks.delta * signedQty;
    totalGamma += greeks.gamma * signedQty;
    totalVega += greeks.vega * signedQty;
    totalTheta += greeks.theta * signedQty;
    totalPv += greeks.price * signedQty;
  });

  return {
    totalDelta,
    totalGamma,
    totalVega,
    totalTheta,
    totalPv
  };
}
