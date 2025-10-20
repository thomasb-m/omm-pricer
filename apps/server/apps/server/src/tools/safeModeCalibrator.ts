/**
 * Safe Mode Calibrator - Standalone (no imports)
 */

const tiny = 1e-12;

interface Quote {
  strike: number;
  bid: number;
  ask: number;
  weight?: number;
}

interface SafeModeInput {
  F: number;
  T: number;
  minTick: number;
  quotes: Quote[];
}

interface SVIParams {
  a: number;
  b: number;
  rho: number;
  sigma: number;
  m: number;
}

// Inline Black-76 implementation
function black76Greeks(
  F: number,
  K: number,
  T: number,
  sigma: number,
  isCall: boolean,
  r: number = 0
): { price: number; delta: number; gamma: number; vega: number; theta: number } {
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  
  const nd1 = 0.5 * (1 + erf(d1 / Math.sqrt(2)));
  const nd2 = 0.5 * (1 + erf(d2 / Math.sqrt(2)));
  const nprime_d1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  
  const discount = Math.exp(-r * T);
  
  let price: number;
  let delta: number;
  
  if (isCall) {
    price = discount * (F * nd1 - K * nd2);
    delta = discount * nd1;
  } else {
    price = discount * (K * (1 - nd2) - F * (1 - nd1));
    delta = discount * (nd1 - 1);
  }
  
  const vega = discount * F * nprime_d1 * Math.sqrt(T);
  const gamma = discount * nprime_d1 / (F * sigma * Math.sqrt(T));
  const theta = isCall
    ? -discount * (F * nprime_d1 * sigma / (2 * Math.sqrt(T))) - r * K * discount * nd2
    : -discount * (F * nprime_d1 * sigma / (2 * Math.sqrt(T))) + r * K * discount * (1 - nd2);
  
  return { price, delta, gamma, vega, theta };
}

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  
  return sign * y;
}

function sviVariance(params: SVIParams, k: number): number {
  const { a, b, rho, sigma, m } = params;
  const kShifted = k - m;
  return a + b * (Math.sqrt(kShifted * kShifted + sigma * sigma) + rho * kShifted);
}

function cleanMid(bid: number, ask: number, minTick: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = 0.5 * (bid + ask);
  if (mid <= 1.5 * minTick) return null;
  return mid;
}

function blackIV(F: number, K: number, T: number, price: number, isCall: boolean): number {
  let iv = 0.3;
  
  for (let i = 0; i < 20; i++) {
    const greeks = black76Greeks(F, K, T, iv, isCall, 0);
    const diff = greeks.price - price;
    
    if (Math.abs(diff) < 1e-10) break;
    if (Math.abs(greeks.vega) < 1e-10) break;
    
    iv = iv - diff / greeks.vega;
    iv = Math.max(0.01, Math.min(5.0, iv));
  }
  
  return iv;
}

function calibrateATMAnchoredSVI(
  quotes: Array<{ strike: number; mid: number; iv: number; weight: number }>,
  F: number,
  T: number
): SVIParams {
  const atmQuote = quotes.reduce((best, q) => 
    Math.abs(q.strike - F) < Math.abs(best.strike - F) ? q : best
  );
  
  const vATM = atmQuote.iv * atmQuote.iv * T;
  
  let b = 0.10;
  let rho = -0.25;
  let sigma = 0.20;
  
  function objective(params: [number, number, number]): number {
    const [bTry, rhoTry, sigmaTry] = params;
    const a = vATM - bTry * sigmaTry;
    
    let error = 0;
    let wSum = 0;
    
    const wSVI0 = a + bTry * sigmaTry;
    const W0 = 1e6;
    error += W0 * Math.pow(wSVI0 - vATM, 2);
    wSum += W0;
    
    for (const q of quotes) {
      const k = Math.log(q.strike / Math.max(F, tiny));
      const wSVI = a + bTry * (Math.sqrt(k * k + sigmaTry * sigmaTry) + rhoTry * k);
      const wMarket = q.iv * q.iv * T;
      const w = q.weight;
      
      error += w * Math.pow(wSVI - wMarket, 2);
      wSum += w;
    }
    
    return error / Math.max(wSum, 1);
  }
  
  const lr = 0.01;
  const maxIter = 200;
  
  for (let iter = 0; iter < maxIter; iter++) {
    const eps = 1e-6;
    const f0 = objective([b, rho, sigma]);
    
    const gb = (objective([b + eps, rho, sigma]) - f0) / eps;
    const gr = (objective([b, rho + eps, sigma]) - f0) / eps;
    const gs = (objective([b, rho, sigma + eps]) - f0) / eps;
    
    b = Math.max(0.01, b - lr * gb);
    rho = Math.max(-0.99, Math.min(0.99, rho - lr * gr));
    sigma = Math.max(0.01, sigma - lr * gs);
  }
  
  const a = vATM - b * sigma;
  return { a, b, rho, m: 0, sigma };
}

function runSafeMode(input: SafeModeInput): void {
  const { F, T, minTick, quotes } = input;
  
  console.log(`\n[SafeMode] Running calibration check:`);
  console.log(`  Forward: ${F.toFixed(2)}`);
  console.log(`  Time to expiry: ${T.toFixed(4)} years`);
  console.log(`  Min tick: ${minTick.toExponential(2)}`);
  console.log(`  Quotes: ${quotes.length} strikes\n`);
  
  const cleanQuotes = quotes
    .map(q => {
      const mid = cleanMid(q.bid, q.ask, minTick);
      if (!mid) return null;
      
      const intrinsic = Math.max(0, F - q.strike);
      const tv = Math.max(0, mid - intrinsic);
      const iv = blackIV(F, q.strike, T, mid, true);
      
      return {
        strike: q.strike,
        mid,
        iv,
        intrinsic,
        tv,
        weight: q.weight ?? 1
      };
    })
    .filter((q): q is NonNullable<typeof q> => q !== null);
  
  if (cleanQuotes.length < 3) {
    console.error(`[SafeMode] ❌ Only ${cleanQuotes.length} valid quotes`);
    return;
  }
  
  console.log(`[SafeMode] ✓ ${cleanQuotes.length} clean quotes`);
  
  const svi = calibrateATMAnchoredSVI(cleanQuotes, F, T);
  
  console.log(`[SafeMode] ✓ Calibrated SVI:`);
  console.log(`  a=${svi.a.toFixed(6)}, b=${svi.b.toFixed(6)}, rho=${svi.rho.toFixed(3)}, sigma=${svi.sigma.toFixed(6)}`);
  
  const w0 = sviVariance(svi, 0);
  const ivATM = Math.sqrt(w0 / Math.max(T, tiny));
  const atmQuote = cleanQuotes.reduce((best, q) => 
    Math.abs(q.strike - F) < Math.abs(best.strike - F) ? q : best
  );
  
  console.log(`\n[SafeMode] 🎯 ATM Check (K=${atmQuote.strike}):`);
  console.log(`  Market IV: ${atmQuote.iv.toFixed(4)}`);
  console.log(`  Fitted IV: ${ivATM.toFixed(4)}`);
  console.log(`  Diff: ${Math.abs(atmQuote.iv - ivATM).toFixed(6)} ${Math.abs(atmQuote.iv - ivATM) < 0.001 ? '✓' : '✗'}`);
  
  const results = cleanQuotes.map(q => {
    const k = Math.log(q.strike / Math.max(F, tiny));
    const w = sviVariance(svi, k);
    const iv = Math.sqrt(w / Math.max(T, tiny));
    const greeks = black76Greeks(F, q.strike, T, iv, true, 0);
    const ccPrice = greeks.price;
    const diff = ccPrice - q.mid;
    const diffBps = (diff / Math.max(q.mid, tiny)) * 10000;
    
    return {
      strike: q.strike,
      marketMid: Number(q.mid.toFixed(6)),
      ccPrice: Number(ccPrice.toFixed(6)),
      intrinsic: Number(q.intrinsic.toFixed(6)),
      tv_market: Number(q.tv.toFixed(6)),
      tv_cc: Number(Math.max(0, ccPrice - q.intrinsic).toFixed(6)),
      diff: Number(diff.toFixed(6)),
      diff_bps: Number(diffBps.toFixed(1))
    };
  });
  
  console.log(`\n[SafeMode] 📊 Comparison Table:\n`);
  console.table(results);
  
  const maxError = Math.max(...results.map(r => Math.abs(r.diff_bps)));
  const atmError = results.find(r => r.strike === atmQuote.strike)?.diff_bps ?? 0;
  
  console.log(`\n[SafeMode] Summary:`);
  console.log(`  ATM error: ${Math.abs(atmError).toFixed(1)} bps ${Math.abs(atmError) < 50 ? '✓' : '✗'}`);
  console.log(`  Max error: ${maxError.toFixed(1)} bps ${maxError < 100 ? '✓' : '✗'}`);
  console.log(`  Status: ${Math.abs(atmError) < 50 && maxError < 100 ? '✅ PASS' : '❌ FAIL'}\n`);
}

// Test with sample data
const testInput: SafeModeInput = {
  F: 97000,
  T: 0.0274,
  minTick: 0.00005,
  quotes: [
    { strike: 95000, bid: 0.0280, ask: 0.0285 },
    { strike: 96000, bid: 0.0220, ask: 0.0225 },
    { strike: 97000, bid: 0.0170, ask: 0.0175 },
    { strike: 98000, bid: 0.0130, ask: 0.0135 },
    { strike: 99000, bid: 0.0095, ask: 0.0100 },
  ]
};

runSafeMode(testInput);
