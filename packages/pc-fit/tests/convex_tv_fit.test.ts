import { describe, it, expect } from 'vitest';
import { fitConvexTV } from '../src/convex_tv_fit';
import type { FitInput } from '../src/types';

describe('fitConvexTV', () => {
  const options = {
    minTick: 0.0001,
    minTVTicks: 5,
    minTVFracOfCC: 0.05,
    maxOutlierTrimBps: 100,
    robustLoss: 'huber' as const,
    enforceCallConvexity: true,
    convexityTol: 1e-6,
    taperExp: 1.5
  };

  it('should handle graceful degradation (< 5 quotes)', () => {
    const input: FitInput = {
      legs: [
        { strike: 95, marketMid: 0.05, weight: 1 },
        { strike: 100, marketMid: 0.03, weight: 1 }
      ],
      forward: 100,
      ccTV: [0.048, 0.028],
      phi: [1, 1],
      options
    };

    const result = fitConvexTV(input);
    expect(result.degenerate).toBe(true);
    expect(result.theta).toBe(0);
    expect(result.usedCount).toBe(2);
  });

  it('should preserve convexity after floor application', () => {
    const strikes = [90, 95, 100, 105, 110];
    const input: FitInput = {
      legs: strikes.map(K => ({ strike: K, marketMid: 0.05, weight: 1 })),
      forward: 100,
      ccTV: [0.048, 0.042, 0.038, 0.042, 0.048],
      phi: [1, 1, 1, 1, 1],
      options
    };

    const result = fitConvexTV(input);
    
    const F = input.forward;
    for (let i = 1; i < strikes.length - 1; i++) {
      const K0 = strikes[i - 1], K1 = strikes[i], K2 = strikes[i + 1];
      const C0 = Math.max(0, F - K0) + result.tvFitted[i - 1];
      const C1 = Math.max(0, F - K1) + result.tvFitted[i];
      const C2 = Math.max(0, F - K2) + result.tvFitted[i + 1];
      
      const dK1 = K1 - K0, dK2 = K2 - K1;
      const dC1 = (C1 - C0) / dK1, dC2 = (C2 - C1) / dK2;
      const d2C = (dC2 - dC1) / ((dK1 + dK2) / 2);
      
      expect(d2C).toBeGreaterThanOrEqual(-options.convexityTol);
    }
  });

  it('should trim outliers correctly', () => {
    const strikes = [90, 95, 100, 105, 110];
    const input: FitInput = {
      legs: strikes.map((K, i) => ({ 
        strike: K, 
        marketMid: i === 2 ? 0.20 : 0.05,
        weight: 1 
      })),
      forward: 100,
      ccTV: [0.048, 0.042, 0.038, 0.042, 0.048],
      phi: [1, 1, 1, 1, 1],
      options
    };

    const result = fitConvexTV(input);
    expect(result.metadata.trimmedCount).toBeGreaterThan(0);
    expect(result.usedMask[2]).toBe(false);
  });

  it('should apply absolute floor in deep wings', () => {
    const strikes = [50, 75, 100, 125, 150];
    const input: FitInput = {
      legs: strikes.map(K => ({ strike: K, marketMid: 0.001, weight: 1 })),
      forward: 100,
      ccTV: [0.0001, 0.0005, 0.002, 0.0005, 0.0001],
      phi: [0, 0.5, 1, 0.5, 0],
      options: { ...options, minTVAbsFloorTicks: 1 }
    };

    const result = fitConvexTV(input);
    
    expect(result.tvFitted[0]).toBeGreaterThanOrEqual(options.minTick);
    expect(result.tvFitted[4]).toBeGreaterThanOrEqual(options.minTick);
  });

  it('should skip IRLS when all phi=0', () => {
    const strikes = [90, 95, 100, 105, 110];
    const input: FitInput = {
      legs: strikes.map(K => ({ strike: K, marketMid: 0.05, weight: 1 })),
      forward: 100,
      ccTV: [0.048, 0.042, 0.038, 0.042, 0.048],
      phi: [0, 0, 0, 0, 0],
      options
    };

    const result = fitConvexTV(input);
    expect(result.metadata.irlsIters).toBe(0);
    expect(result.theta).toBe(0);
  });

  it('should combine trim masks correctly', () => {
    const strikes = [90, 92, 95, 100, 105, 108, 110];
    const input: FitInput = {
      legs: strikes.map((K, i) => ({ 
        strike: K, 
        marketMid: i === 1 ? 0.15 : (i === 5 ? 0.18 : 0.05),
        weight: 1 
      })),
      forward: 100,
      ccTV: [0.048, 0.045, 0.042, 0.038, 0.042, 0.045, 0.048],
      phi: [1, 1, 1, 1, 1, 1, 1],
      options
    };

    const result = fitConvexTV(input);
    
    expect(result.usedMask[1]).toBe(false);
    expect(result.usedMask[5]).toBe(false);
    expect(result.metadata.trimmedCount).toBe(2);
  });
});
