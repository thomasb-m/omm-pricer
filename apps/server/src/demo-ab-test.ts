// apps/server/src/demo-ab-test.ts
/**
 * A/B Test Demo: Compare two configurations
 * 
 * Usage:
 *   npx ts-node src/demo-ab-test.ts
 */

import { ABTestRunner } from './testing/ABTestRunner';
import { FeatureConfig } from './config/featureFlags';
import { Instrument } from './risk/factorGreeksLoader';
import { PriceFn, Theta } from './risk/FactorSpace';

// ============================================================================
// Define Configurations to Test
// ============================================================================

const configA: FeatureConfig = {
  name: 'Baseline (Current)',
  version: '1.0.0-baseline',
  numTicks: 100,
  risk: {
    gamma: 0.01,
    z: 2.0,
    eta: 0.5,
    kappa: 0.01,
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
    minFillQty: 0.01,
  },
  features: {
    useModelSpread: true,
    useMicrostructure: true,
    useInventoryWidening: true,
    useInventorySkew: true,
    explainDecisions: false,
  },
};

const configB: FeatureConfig = {
  ...configA,
  name: 'Aggressive Risk',
  version: '1.0.0-aggressive',
  risk: {
    ...configA.risk,
    gamma: 0.02,      // 2x risk aversion
    z: 3.0,           // 1.5x model spread
    kappa: 0.02,      // 2x inventory widening
  },
};

// ============================================================================
// Instrument Universe
// ============================================================================

const instruments: Instrument[] = [
  {
    symbol: 'BTC-25DEC25-50000-C',
    strike: 50000,
    expiryMs: Date.parse('2025-12-25'),
    isCall: true,
  },
  {
    symbol: 'BTC-25DEC25-52000-C',
    strike: 52000,
    expiryMs: Date.parse('2025-12-25'),
    isCall: true,
  },
];

// ============================================================================
// Pricing Function
// ============================================================================

const priceFn: PriceFn<Instrument> = (theta: Theta, inst: Instrument) => {
  const [L0, S0, C0, Sneg, Spos, F] = theta;
  const K = inst.strike;
  const m = Math.log(K / F);
  const t = Math.max(0.01, (inst.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000));
  
  let iv = L0 + S0 * m + C0 * m * m;
  if (m < 0) iv += Sneg * m * m;
  if (m > 0) iv += Spos * m * m;
  iv = Math.max(0.05, Math.min(2.0, iv));
  
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(F / K) + 0.5 * iv * iv * t) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  
  const norm = (x: number) => {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return 0.5 * (1.0 + sign * y);
  };
  
  const callPrice = F * norm(d1) - K * norm(d2);
  return Math.max(0, callPrice * 1.01);
};

// ============================================================================
// Run A/B Test
// ============================================================================

async function main() {
  console.log('🚀 Starting A/B Test Comparison\n');
  console.log(`Config A: ${configA.name}`);
  console.log(`  γ=${configA.risk.gamma}, z=${configA.risk.z}, κ=${configA.risk.kappa}`);
  console.log(`\nConfig B: ${configB.name}`);
  console.log(`  γ=${configB.risk.gamma}, z=${configB.risk.z}, κ=${configB.risk.kappa}`);
  console.log(`\nRunning ${configA.numTicks} ticks with seed=42 for reproducibility...\n`);
  
  const result = await ABTestRunner.runComparison(
    { name: configA.name, config: configA },
    { name: configB.name, config: configB },
    100,  // ticks
    instruments,
    priceFn,
    42    // seed for reproducibility
  );
  
  console.log(ABTestRunner.formatResults(result));
  
  // Additional insights
  console.log('💡 INSIGHTS\n');
  
  if (result.winner !== 'TIE') {
    const winner = result.winner === 'A' ? result.configA : result.configB;
    const loser = result.winner === 'A' ? result.configB : result.configA;
    
    console.log(`✅ ${winner.configName} outperformed with:`);
    console.log(`   • ${((winner.netPnL - loser.netPnL) / Math.abs(loser.netPnL) * 100).toFixed(1)}% better PnL`);
    console.log(`   • ${winner.totalTrades} trades vs ${loser.totalTrades}`);
    console.log(`   • ${(winner.fillRate * 100).toFixed(1)}% fill rate vs ${(loser.fillRate * 100).toFixed(1)}%`);
  } else {
    console.log('🤝 Both configurations performed similarly');
    console.log('   Consider other factors like:');
    console.log('   • Risk tolerance (inventory util)');
    console.log('   • Operational complexity');
    console.log('   • Latency sensitivity');
  }
  
  console.log('\n✨ Test complete!\n');
}

main().catch(console.error);