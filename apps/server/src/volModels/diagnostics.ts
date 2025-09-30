/**
 * Diagnose the PC bump issue
 */

import { IntegratedDualSurface, TradeExecution } from './integratedModel';
import { TraderMetrics } from './dualSurfaceModel';

function diagnose() {
  console.log('\n=== DIAGNOSING PC BUMP ISSUE ===\n');
  
  const model = new IntegratedDualSurface('BTC');
  
  // Setup
  const expiry = 0.25;
  const spot = 100;
  
  const metrics: TraderMetrics = {
    L0: 0.04,    // 20% vol
    S0: 0.001,
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
  };
  
  model.updateCC(expiry, metrics);
  
  // Get quote before trade
  const strike = 95;
  const quoteBefore = model.getQuote(expiry, strike, spot);
  console.log(`Before trade - K=${strike}:`);
  console.log(`  CC Mid: ${quoteBefore.ccMid.toFixed(2)}`);
  console.log(`  PC Mid: ${quoteBefore.pcMid.toFixed(2)}`);
  console.log(`  Edge: ${quoteBefore.edge.toFixed(2)}`);
  console.log(`  Bucket: ${quoteBefore.bucket}`);
  
  // Execute trade
  const trade: TradeExecution = {
    expiry,
    strike: 95,
    price: 5.34,  // Use the actual mid price
    size: -100,
    spot,
    time: Date.now()
  };
  
  console.log(`\nExecuting trade: Sell 100 lots at ${trade.price}`);
  model.onTrade(trade);
  
  // Check inventory
  const inventory = model.getInventorySummary();
  console.log(`\nAfter selling 100 lots:`);
  console.log(`  Total Vega: ${inventory.totalVega.toFixed(1)}`);
  
  // Show edges for all buckets
  console.log(`\nEdge requirements by bucket:`);
  for (const [bucket, edge] of Object.entries(inventory.edges)) {
    const bucketInv = (inventory.byBucket as any)[bucket];
    if (bucketInv) {
      console.log(`  ${bucket}: ${bucketInv.vega.toFixed(1)} vega → ${(edge as number).toFixed(2)} ticks edge`);
    }
  }
  
  // Get quotes after trade for different strikes
  console.log(`\nPost-trade quotes:`);
  console.log(`Strike | Bucket | PC Mid | CC Mid | Edge   | Bid    | Ask`);
  console.log('-'.repeat(65));
  
  const testStrikes = [90, 95, 100, 105, 110];
  for (const k of testStrikes) {
    const q = model.getQuote(expiry, k, spot);
    const marker = k === strike ? ' ← traded' : '';
    console.log(
      `${k.toString().padStart(6)} | ` +
      `${q.bucket.padEnd(6)} | ` +
      `${q.pcMid.toFixed(2).padStart(6)} | ` +
      `${q.ccMid.toFixed(2).padStart(6)} | ` +
      `${q.edge.toFixed(2).padStart(6)} | ` +
      `${q.bid.toFixed(2).padStart(6)} | ` +
      `${q.ask.toFixed(2).padStart(6)}${marker}`
    );
  }
  
  // Analyze the problem
  console.log('\n=== ANALYSIS ===\n');
  
  const q95 = model.getQuote(expiry, 95, spot);
  const q90 = model.getQuote(expiry, 90, spot);
  
  console.log('Issue 1: PC is moving too much');
  console.log(`  95 strike edge: ${q95.edge.toFixed(2)} ticks (reasonable)`);
  console.log(`  90 strike edge: ${q90.edge.toFixed(2)} ticks (way too high!)`);
  
  console.log('\nIssue 2: Bumps affecting wrong strikes');
  console.log('  The 90 strike is in a different bucket but still affected');
  console.log('  This suggests bumps are too wide or miscalculated');
  
  console.log('\nLikely causes:');
  console.log('  1. Bump amplitude calculation is wrong (variance vs price units)');
  console.log('  2. Bump width is too large (affects too many strikes)');
  console.log('  3. Edge-to-variance conversion has wrong scaling');
}

diagnose();