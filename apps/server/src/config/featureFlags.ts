// apps/server/src/config/featureFlags.ts
/**
 * Feature Flags & Configuration System
 * 
 * Allows A/B testing different risk parameters via command line:
 *   --config=week1-baseline  (default)
 *   --config=debug           (verbose explanations)
 *   --config=minimal         (isolate core logic)
 */

// Match the REAL interfaces from SigmaService and FactorRisk
export interface RiskConfig {
  gamma: number;               // Risk aversion scaling
  z: number;                   // Z-score for inventory bounds
  eta: number;                 // Microstructure noise multiplier
  kappa: number;               // Inventory widening multiplier
  L: number;                   // Inventory limit in Λ-norm
  ridgeEpsilon: number;        // Ridge on Λ
  feeBuffer: number;           // Fee cushion per contract
  qMax: number;                // Max size per side
  minEdge: number;             // Minimum edge to quote
}

export interface SigmaConfig {
  horizonMs: number;           // Time window for Δf
  alpha: number;               // EWMA decay
  ridgeEpsilon: number;        // Ridge regularization
  minSamples: number;          // Min samples before ready
}

export interface SimConfig {
  fillProbability: number;     // Chance of fill per tick
  minFillQty: number;          // Minimum fill quantity (prevent dust)
}

export interface FeatureConfig {
  name: string;
  version: string;
  numTicks: number;
  risk: RiskConfig;
  sigma: SigmaConfig;
  sim: SimConfig;
  features: {
    useModelSpread: boolean;
    useMicrostructure: boolean;
    useInventoryWidening: boolean;
    useInventorySkew: boolean;
    explainDecisions: boolean;
  };
}

// ============================================================================
// Pre-defined Configurations
// ============================================================================

const CONFIGS: Record<string, FeatureConfig> = {
  'week1-baseline': {
    name: 'Week 1 Baseline',
    version: '1.0.0',
    numTicks: 20,
    risk: {
      gamma: 0.01,
      z: 2.0,
      eta: 0.5,
      kappa: 0.01,           // ← FIXED: Was 0.001 (too small for size calc)
      L: 100.0,              // Inventory limit
      ridgeEpsilon: 0.01,    // Ridge regularization
      feeBuffer: 0.10,
      qMax: 10.0,            // Max 10 contracts per side
      minEdge: 0.01,
    },
    sigma: {
      horizonMs: 1000,       // 1 second horizon
      alpha: 0.1,            // EWMA decay
      ridgeEpsilon: 0.01,    // Ridge for Σ
      minSamples: 10,
    },
    sim: {
      fillProbability: 0.3,
      minFillQty: 0.01,      // ← NEW: Prevent dust fills
    },
    features: {
      useModelSpread: true,
      useMicrostructure: true,
      useInventoryWidening: true,
      useInventorySkew: true,
      explainDecisions: false,
    },
  },
  
  'debug': {
    name: 'Debug Mode',
    version: '1.0.0-debug',
    numTicks: 20,
    risk: {
      gamma: 0.01,
      z: 2.0,
      eta: 0.5,
      kappa: 0.01,           // ← FIXED
      L: 100.0,
      ridgeEpsilon: 0.01,
      feeBuffer: 0.10,
      qMax: 10.0,
      minEdge: 0.01,
    },
    sigma: {
      horizonMs: 1000,
      alpha: 0.1,
      ridgeEpsilon: 0.01,
      minSamples: 10,
    },
    sim: {
      fillProbability: 0.3,
      minFillQty: 0.01,      // ← NEW
    },
    features: {
      useModelSpread: true,
      useMicrostructure: true,
      useInventoryWidening: true,
      useInventorySkew: true,
      explainDecisions: true,  // ← Enable verbose explanations
    },
  },
  
  'minimal': {
    name: 'Minimal (Isolate Core)',
    version: '1.0.0-minimal',
    numTicks: 20,
    risk: {
      gamma: 0.01,
      z: 2.0,
      eta: 0.5,
      kappa: 0.01,           // ← FIXED
      L: 100.0,
      ridgeEpsilon: 0.01,
      feeBuffer: 0.10,
      qMax: 10.0,
      minEdge: 0.01,
    },
    sigma: {
      horizonMs: 1000,
      alpha: 0.1,
      ridgeEpsilon: 0.01,
      minSamples: 10,
    },
    sim: {
      fillProbability: 0.3,
      minFillQty: 0.01,      // ← NEW
    },
    features: {
      useModelSpread: false,        // Disable all features
      useMicrostructure: false,
      useInventoryWidening: false,
      useInventorySkew: false,
      explainDecisions: false,
    },
  },
};

// ============================================================================
// Config Loader
// ============================================================================

export function loadConfigFromArgs(): FeatureConfig {
  const args = process.argv.slice(2);
  const configArg = args.find(arg => arg.startsWith('--config='));
  const configName = configArg ? configArg.split('=')[1] : 'week1-baseline';
  
  const config = CONFIGS[configName];
  if (!config) {
    console.error(`❌ Unknown config: ${configName}`);
    console.error(`Available configs: ${Object.keys(CONFIGS).join(', ')}`);
    process.exit(1);
  }
  
  return config;
}