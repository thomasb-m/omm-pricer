/**
 * SVI Calibration - Fit SVI parameters to market smile
 */
import { SVIParams, SVI } from './dualSurfaceModel';

export interface MarketSmilePoint {
  strike: number;
  iv: number;          // implied volatility (decimal, e.g. 0.45)
  weight?: number;     // optional weight for fitting
}

export interface CalibrationConfig {
  bMin: number;
  sigmaMin: number;
  rhoMax: number;
  sMax: number;
  c0Min: number;
}

/**
 * Calibrate SVI parameters to market smile using least squares
 */
export function calibrateSVI(
  marketPoints: MarketSmilePoint[],
  forward: number,
  T: number,  // time to expiry in years
  config: CalibrationConfig
): SVIParams {
  if (marketPoints.length === 0) {
    throw new Error('Cannot calibrate SVI: no market points provided');
  }

  // Convert strikes to log-moneyness and IVs to total variance
  const points = marketPoints.map(p => ({
    k: Math.log(p.strike / forward),
    w: p.iv * p.iv * T,  // total variance
    weight: p.weight ?? 1.0
  }));

  // Find ATM point (closest to k=0)
  const atmPoint = points.reduce((best, p) => 
    Math.abs(p.k) < Math.abs(best.k) ? p : best
  );

  /// Initial guess based on ATM and simple heuristics
  const L0_init = atmPoint.w;
  const a_init = L0_init * 0.875;
  const b_init = Math.max(0.01, L0_init * 0.5);  // ✅ Higher minimum
  const sigma_init = Math.max(0.05, 0.15);       // ✅ START AT 0.05, not sigmaMin!
  const rho_init = 0.0;

  // Simple gradient-free optimization using Nelder-Mead-like approach
  // For production, consider using a proper optimization library
  let bestParams: SVIParams = { a: a_init, b: b_init, rho: rho_init, sigma: sigma_init, m: 0 };
  let bestError = computeError(bestParams, points);

  // Grid search over key parameters
  const aRange = linspace(L0_init * 0.5, L0_init * 1.2, 5);
  const bRange = linspace(config.bMin, Math.min(L0_init, 0.1), 5);
  const sigmaRange = linspace(Math.max(config.sigmaMin, 0.05), 0.5, 5);  // ✅ START AT 0.05, not sigmaMin!
  const rhoRange = linspace(-Math.min(config.rhoMax, 0.9), Math.min(config.rhoMax, 0.9), 7);  // ✅ Use config.rhoMax

  for (const a of aRange) {
    for (const b of bRange) {
      for (const sigma of sigmaRange) {
        for (const rho of rhoRange) {
          const params: SVIParams = { a, b, rho, sigma, m: 0 };
          
          // Check no-arbitrage constraints
          if (!isValid(params, config)) continue;
          
          const error = computeError(params, points);
          if (error < bestError) {
            bestError = error;
            bestParams = params;
          }
        }
      }
    }
  }

  // Refine best solution with local search
  bestParams = localRefine(bestParams, points, config, 3);

  return bestParams;
}

function computeError(
  params: SVIParams,
  points: Array<{ k: number; w: number; weight: number }>
): number {
  let sumSqError = 0;
  let sumWeight = 0;

  for (const p of points) {
    const predicted = SVI.w(params, p.k);
    const error = (predicted - p.w) * p.weight;
    sumSqError += error * error;
    sumWeight += p.weight;
  }

  return sumWeight > 0 ? Math.sqrt(sumSqError / sumWeight) : Infinity;
}

function isValid(params: SVIParams, config: CalibrationConfig): boolean {
  if (params.b < config.bMin || params.sigma < config.sigmaMin) return false;
  if (Math.abs(params.rho) > config.rhoMax) return false;
  
  const L0 = params.a + params.b * params.sigma;
  if (L0 < 0) return false;
  
  const sLeft = params.b * (1 - params.rho);
  const sRight = params.b * (1 + params.rho);
  if (sLeft <= 0 || sRight <= 0) return false;
  if (sLeft > config.sMax || sRight > config.sMax) return false;
  
  return true;
}

function localRefine(
  params: SVIParams,
  points: Array<{ k: number; w: number; weight: number }>,
  config: CalibrationConfig,
  iterations: number
): SVIParams {
  let current = { ...params };
  let currentError = computeError(current, points);
  const step = 0.1;

  for (let iter = 0; iter < iterations; iter++) {
    let improved = false;

    // Try small perturbations
    for (const key of ['a', 'b', 'rho', 'sigma'] as const) {
      const delta = step * Math.abs(current[key] || 0.01);
      
      for (const sign of [-1, 1]) {
        const test = { ...current, [key]: current[key] + sign * delta };
        
        if (!isValid(test, config)) continue;
        
        const testError = computeError(test, points);
        if (testError < currentError) {
          current = test;
          currentError = testError;
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return current;
}

function linspace(start: number, end: number, num: number): number[] {
  const result: number[] = [];
  const step = (end - start) / (num - 1);
  for (let i = 0; i < num; i++) {
    result.push(start + step * i);
  }
  return result;
}
