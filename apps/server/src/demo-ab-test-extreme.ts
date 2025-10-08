// apps/server/src/demo-ab-test-extreme.ts
/**
 * A/B Test Demo: Extreme comparison
 * Ultra Conservative vs Ultra Aggressive
 * 
 * Usage:
 *   npx ts-node src/demo-ab-test-extreme.ts
 */

import { ABTestRunner } from './testing/ABTestRunner';
import { FeatureConfig } from './config/featureFlags';
import { Instrument } from './risk/factorGreeksLoader';
import { PriceFn, Theta } from './risk/FactorSpace';
import { DebugAPI } from './api/DebugAPI';
import { SigmaService } from './risk/SigmaService';
import { FactorRisk } from './risk/FactorRisk';
import { d } from './risk/factors';

// ============================================================================
// Define EXTREME Configurations
// ============================================================================

const configConservative: FeatureConfig = {
  name: '🛡️ Ultra Conservative',
  version: '1.0.0-conservative',
  numTicks: 500,  // More ticks to see divergence
  risk: {
    gamma: 0.05,        // 5x risk aversion (very cautious)
    z: 5.0,             // 2.5x model spread (wide quotes)
    eta: 1.0,           // 2x microstructure noise
    kappa: 0.05,        // 5x inventory widening (widens fast)
    L: 50.0,            // Lower inventory limit (half)
    ridgeEpsilon: 0.01,
    feeBuffer: 0.15,    // Higher fees (1.5x)
    qMax: 5.0,          // Smaller max size (half)
    minEdge: 0.05,      // Higher min edge (5x)
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

const configAggressive: FeatureConfig = {
  name: '⚡ Ultra Aggressive',
  version: '1.0.0-aggressive',
  numTicks: 500,
  risk: {
    gamma: 0.001,       // 10x less risk averse (YOLO mode)
    z: 0.5,             // Half model spread (tight quotes)
    eta: 0.1,           // 5x less microstructure (ignore noise)
    kappa: 0.001,       // Minimal inventory widening
    L: 200.0,           // Higher inventory limit (2x)
    ridgeEpsilon: 0.01,
    feeBuffer: 0.05,    // Lower fees (half)
    qMax: 20.0,         // Larger max size (2x)
    minEdge: 0.001,     // Lower min edge (10x smaller)
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
  {
    symbol: 'BTC-25DEC25-48000-C',
    strike: 48000,
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
// Run EXTREME A/B Test
// ============================================================================

async function main() {
  console.log('🚀 Starting EXTREME A/B Test Comparison\n');
  console.log('═'.repeat(80));
  
  console.log(`\n🛡️  Config A: ${configConservative.name}`);
  console.log(`   γ=${configConservative.risk.gamma} (5x cautious)`);
  console.log(`   z=${configConservative.risk.z} (2.5x wider spreads)`);
  console.log(`   κ=${configConservative.risk.kappa} (5x inv widening)`);
  console.log(`   qMax=${configConservative.risk.qMax} (smaller sizes)`);
  console.log(`   minEdge=${configConservative.risk.minEdge} (higher barrier)`);
  
  console.log(`\n⚡ Config B: ${configAggressive.name}`);
  console.log(`   γ=${configAggressive.risk.gamma} (10x aggressive)`);
  console.log(`   z=${configAggressive.risk.z} (tighter spreads)`);
  console.log(`   κ=${configAggressive.risk.kappa} (minimal widening)`);
  console.log(`   qMax=${configAggressive.risk.qMax} (larger sizes)`);
  console.log(`   minEdge=${configAggressive.risk.minEdge} (lower barrier)`);
  
  console.log(`\n📊 Running ${configConservative.numTicks} ticks with 3 instruments...`);
  console.log(`   (This will take ~30 seconds)\n`);
  console.log('═'.repeat(80));
  
  const startTime = Date.now();
  
  const result = await ABTestRunner.runComparison(
    { name: configConservative.name, config: configConservative },
    { name: configAggressive.name, config: configAggressive },
    500,  // More ticks
    instruments,
    priceFn,
    42
  );
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(ABTestRunner.formatResults(result));
  
  // Enhanced insights
  console.log('💡 DETAILED INSIGHTS\n');
  console.log('═'.repeat(80));
  
  if (result.winner !== 'TIE') {
    const winner = result.winner === 'A' ? result.configA : result.configB;
    const loser = result.winner === 'A' ? result.configB : result.configA;
    
    console.log(`\n✅ ${winner.configName} WINS!\n`);
    
    const pnlDiff = winner.netPnL - loser.netPnL;
    const pnlPct = Math.abs((pnlDiff / Math.abs(loser.netPnL)) * 100);
    
    console.log(`📈 Performance Advantage:`);
    console.log(`   • Net PnL: ${pnlDiff.toFixed(2)} better (${pnlPct.toFixed(1)}%)`);
    console.log(`   • Trades: ${winner.totalTrades} vs ${loser.totalTrades}`);
    console.log(`   • Fill Rate: ${(winner.fillRate * 100).toFixed(1)}% vs ${(loser.fillRate * 100).toFixed(1)}%`);
    console.log(`   • Avg Edge: ${winner.avgEdge.toFixed(2)} vs ${loser.avgEdge.toFixed(2)}`);
    console.log(`   • PnL/Trade: ${winner.pnlPerTrade.toFixed(2)} vs ${loser.pnlPerTrade.toFixed(2)}`);
    
    console.log(`\n⚖️  Risk Profile:`);
    console.log(`   • Winner Max Inv Util: ${(winner.maxInventoryUtil * 100).toFixed(1)}%`);
    console.log(`   • Loser Max Inv Util: ${(loser.maxInventoryUtil * 100).toFixed(1)}%`);
    console.log(`   • Winner Avg Spread: ${winner.avgSpread.toFixed(3)}`);
    console.log(`   • Loser Avg Spread: ${loser.avgSpread.toFixed(3)}`);
    
    console.log(`\n🎯 Key Takeaway:`);
    if (result.winner === 'A') {
      console.log(`   Conservative approach won by managing risk better.`);
      console.log(`   Wide spreads & small sizes = better edge capture.`);
    } else {
      console.log(`   Aggressive approach won by trading more frequently.`);
      console.log(`   Tight spreads & large sizes = more volume, more profit.`);
    }
    
  } else {
    console.log('🤝 TIE - Both strategies performed similarly!\n');
    console.log(`This suggests:`);
    console.log(`   • Market conditions favor neither extreme`);
    console.log(`   • The optimal strategy is somewhere in the middle`);
    console.log(`   • Try intermediate configs to find the sweet spot`);
  }
  
  console.log(`\n⏱️  Test completed in ${duration}s`);
  console.log('═'.repeat(80));
  
  // NOW start the API with results
  console.log('\n📡 Starting Debug API to serve results...\n');
  const inventory = new Array(d).fill(0);
  const sigmaService = new SigmaService(configConservative.sigma);
  const factorRisk = new FactorRisk(configConservative.risk);
  const debugAPI = new DebugAPI(3000, sigmaService, factorRisk, configConservative, inventory);
  
  await debugAPI.start();
  
  // Store result in API
  debugAPI.recordABTest(result);
  
  console.log('✅ Results available at: http://localhost:3000/debug/abtest');
  console.log('💡 Open dashboard.html to see visual comparison\n');
  console.log('💡 Press Ctrl+C to stop\n');
  
  // Keep API running
  process.stdin.resume();
}

main().catch(console.error);