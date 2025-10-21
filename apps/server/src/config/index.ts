// apps/server/src/config/index.ts
/**
 * Centralized configuration with validation and hashing
 * 
 * Safe defaults for Phase 2 Week 1 (conservative risk)
 * Tuning knobs exposed for Week 2
 */

import * as crypto from 'crypto';
import { SigmaConfig } from '../risk/SigmaService';
import { RiskConfig } from '../risk/FactorRisk';

export type AppConfig = {
  // Environment
  env: 'development' | 'staging' | 'production';
  apiPort: number;
  
  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logToFile: boolean;
  logPath?: string;
  
  // Database
  databaseUrl: string;
  
  // Risk parameters (FactorRisk)
  risk: RiskConfig;
  
  // Covariance estimation (SigmaService)
  sigma: SigmaConfig;
  
  // Quote engine
  quoting: {
    symbols: string[];
    tickMs: number;              // How often to requote
    
    // Microstructure vol per symbol (will be computed online)
    sigmaMD: Record<string, number>;
  };
  
  // Simulation (if using SimAdapter)
  simulation?: {
    enabled: boolean;
    seed: number;
    initialF: number;
    ouMean: number;
    ouTheta: number;
    ouSigma: number;
    tickMs: number;
    fillProbBase: number;
    fillProbSpreadDecay: number;
    fillProbSizeDecay: number;
    slippageBps: number;
    
    // Shock tests
    shockSchedule?: Array<{
      timeMs: number;
      deltaF?: number;
      deltaSkew?: number;
    }>;
  };
};

/**
 * Phase 2 Week 1: Safe defaults
 * - γ=1.0 (adjust after observing PnL vol)
 * - z=0, η=0, κ=0 (no model/noise/inv spreads yet)
 * - Day 6: turn on z=1.0, η=1.0, κ=0.5
 */
export const SAFE_DEFAULTS: AppConfig = {
  env: 'development',
  apiPort: 3000,
  
  logLevel: 'info',
  logToFile: false,
  
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/optionmm',
  
  risk: {
    gamma: 1.0,                // Week 1 Day 1-5
    z: 0.0,                    // Turn to 1.0 on Day 6
    eta: 0.0,                  // Turn to 1.0 on Day 6
    kappa: 0.0,                // Turn to 0.5 on Day 6
    L: 1.0,                    // Inventory limit (Λ-norm)
    ridgeEpsilon: 1e-5,
    feeBuffer: 0.50,           // $0.50 per contract + 1 tick
    qMax: 10,                  // Max 10 contracts per side
    minEdge: 0.10,             // Min $0.10 edge before quoting
  },
  
  sigma: {
    horizonMs: 1000,           // 1s factor shocks
    alpha: 0.05,               // EWMA decay
    ridgeEpsilon: 1e-5,
    minSamples: 50,            // Need 50 samples before Σ is "ready"
    
    // Multi-horizon blending (optional, Day 9)
    // blendHorizons: [
    //   { horizonMs: 250, weight: 0.5 },
    //   { horizonMs: 2000, weight: 0.5 },
    // ],
  },
  
  quoting: {
    symbols: [
      'BTC-25DEC25-50000-C',
      'BTC-25DEC25-50000-P',
      // Add more as needed
    ],
    tickMs: 1000,              // Requote every 1s
    sigmaMD: {
      'BTC-25DEC25-50000-C': 0.002,  // 20 bps microstructure vol
      'BTC-25DEC25-50000-P': 0.002,
    },
  },
  
  simulation: {
    enabled: true,
    seed: 42,
    initialF: 50000,
    ouMean: 50000,
    ouTheta: 0.1,
    ouSigma: 0.02,
    tickMs: 1000,
    fillProbBase: 0.1,
    fillProbSpreadDecay: 0.5,
    fillProbSizeDecay: 0.3,
    slippageBps: 1.0,
  },
};

/**
 * Phase 2 Week 2: Tuned config (after calibration)
 * Use this as a template after Day 8 γ calibration
 */
export const WEEK2_TUNED: Partial<AppConfig> = {
  risk: {
    gamma: 2.0,                // Adjusted after PnL vol calibration
    z: 1.0,                    // Model spread ON
    eta: 1.0,                  // Microstructure spread ON
    kappa: 0.5,                // Inventory widening ON
    L: 1.0,
    ridgeEpsilon: 1e-5,
    feeBuffer: 0.50,
    qMax: 10,
    minEdge: 0.10,
  },
  
  sigma: {
    horizonMs: 1000,
    alpha: 0.05,
    ridgeEpsilon: 1e-5,
    minSamples: 50,
    
    // Multi-horizon blending (Day 9)
    blendHorizons: [
      { horizonMs: 250, weight: 0.5 },
      { horizonMs: 2000, weight: 0.5 },
    ],
  },
};

/**
 * Compute deterministic hash of config
 * Used for golden tests and run tracking
 */
export function hashConfig(config: AppConfig): string {
  // Sort keys recursively
  const sortObj = (obj: any): any => {
    if (Array.isArray(obj)) {
      return obj.map(sortObj);
    }
    if (obj !== null && typeof obj === 'object') {
      return Object.keys(obj)
        .sort()
        .reduce((result, key) => {
          result[key] = sortObj(obj[key]);
          return result;
        }, {} as any);
    }
    return obj;
  };
  
  const sorted = sortObj(config);
  const json = JSON.stringify(sorted);
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * Validate config (throws on invalid)
 */
export function validateConfig(config: AppConfig): void {
  // Risk validation
  if (config.risk.gamma <= 0) {
    throw new Error('risk.gamma must be positive');
  }
  if (config.risk.z < 0 || config.risk.eta < 0 || config.risk.kappa < 0) {
    throw new Error('risk.z, eta, kappa must be non-negative');
  }
  if (config.risk.L <= 0) {
    throw new Error('risk.L must be positive');
  }
  if (config.risk.qMax <= 0) {
    throw new Error('risk.qMax must be positive');
  }
  
  // Sigma validation
  if (config.sigma.horizonMs <= 0) {
    throw new Error('sigma.horizonMs must be positive');
  }
  if (config.sigma.alpha <= 0 || config.sigma.alpha >= 1) {
    throw new Error('sigma.alpha must be in (0, 1)');
  }
  if (config.sigma.minSamples < 1) {
    throw new Error('sigma.minSamples must be at least 1');
  }
  
  // Blending validation
  if (config.sigma.blendHorizons) {
    const totalWeight = config.sigma.blendHorizons.reduce((s, h) => s + h.weight, 0);
    if (Math.abs(totalWeight - 1.0) > 1e-6) {
      throw new Error(`sigma.blendHorizons weights must sum to 1.0, got ${totalWeight}`);
    }
  }
  
  // Quoting validation
  if (config.quoting.symbols.length === 0) {
    throw new Error('quoting.symbols must not be empty');
  }
  if (config.quoting.tickMs <= 0) {
    throw new Error('quoting.tickMs must be positive');
  }
}

/**
 * Load config from environment and merge with defaults
 */
export function loadConfig(): AppConfig {
  const config: AppConfig = {
    ...SAFE_DEFAULTS,
    
    // Override from env
    env: (process.env.NODE_ENV as any) || 'development',
    apiPort: parseInt(process.env.API_PORT || '3000'),
    databaseUrl: process.env.DATABASE_URL || SAFE_DEFAULTS.databaseUrl,
    
    // Allow override of key risk params via env (for testing)
    risk: {
      ...SAFE_DEFAULTS.risk,
      gamma: parseFloat(process.env.RISK_GAMMA || String(SAFE_DEFAULTS.risk.gamma)),
      z: parseFloat(process.env.RISK_Z || String(SAFE_DEFAULTS.risk.z)),
      eta: parseFloat(process.env.RISK_ETA || String(SAFE_DEFAULTS.risk.eta)),
      kappa: parseFloat(process.env.RISK_KAPPA || String(SAFE_DEFAULTS.risk.kappa)),
    },
  };
  
  validateConfig(config);
  
  return config;
}

/**
 * Config evolution schedule (for systematic tuning)
 * 
 * Week 1:
 * - Day 1-5: SAFE_DEFAULTS (γ=1.0, z=0, η=0, κ=0)
 * - Day 6-7: Turn on z=1.0, η=1.0, κ=0.5
 * 
 * Week 2:
 * - Day 8: Calibrate γ to target PnL vol
 * - Day 9: Add multi-horizon blending
 * - Day 10: Run shock tests
 */
export const CONFIG_SCHEDULE = {
  week1: {
    day1to5: SAFE_DEFAULTS,
    day6to7: {
      ...SAFE_DEFAULTS,
      risk: {
        ...SAFE_DEFAULTS.risk,
        z: 1.0,
        eta: 1.0,
        kappa: 0.5,
      },
    },
  },
  week2: WEEK2_TUNED,
};