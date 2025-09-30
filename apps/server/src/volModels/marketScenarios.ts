/**
 * Market Making Scenarios
 * Test how the model behaves in different situations
 */

import { SimpleAdapter } from './simpleAdapter';

function scenario1_NormalFlow() {
  console.log('\n' + '='.repeat(60));
  console.log('SCENARIO 1: Normal Customer Flow');
  console.log('='.repeat(60));
  
  const model = new SimpleAdapter(100);
  
  console.log('\nCustomer wants to buy protection (buy puts)...');
  model.formatQuotes([90, 95, 100], 0.08);
  
  // Customer buys 95 puts
  const fill1 = model.executeTrade(95, 0.08, 'BUY', 50);
  console.log(`\n✓ Customer BOUGHT 50x 95 puts @ ${fill1.price.toFixed(2)}`);
  console.log('  (We are now SHORT 50 puts)');
  
  console.log('\nUpdated quotes - notice ask is wider:');
  model.formatQuotes([90, 95, 100], 0.08);
  
  // Another customer sells puts to us
  const fill2 = model.executeTrade(95, 0.08, 'SELL', 30);
  console.log(`\n✓ Customer SOLD 30x 95 puts @ ${fill2.price.toFixed(2)}`);
  console.log('  (We are now SHORT only 20 puts)');
  
  console.log('\nRisk reduced, spreads tighten:');
  model.formatQuotes([90, 95, 100], 0.08);
  
  const inv = model.getInventory();
  console.log(`\nNet position: ${inv.totalVega.toFixed(1)} vega`);
}

function scenario2_InventoryManagement() {
  console.log('\n' + '='.repeat(60));
  console.log('SCENARIO 2: Building and Managing Inventory');
  console.log('='.repeat(60));
  
  const model = new SimpleAdapter(100);
  
  console.log('\nInitial quotes (flat):');
  model.formatQuotes([95, 100, 105], 0.08);
  
  // Accumulate short gamma
  console.log('\n1. Selling premium (getting short gamma)...');
  model.executeTrade(100, 0.08, 'SELL', 100);  // Sell ATM
  model.executeTrade(95, 0.08, 'SELL', 50);    // Sell puts
  model.executeTrade(105, 0.08, 'SELL', 50);   // Sell calls
  
  console.log('\nAfter selling - edge is positive (PC > CC):');
  model.formatQuotes([95, 100, 105], 0.08);
  
  const inv1 = model.getInventory();
  console.log(`Position: ${inv1.totalVega.toFixed(1)} vega`);
  console.log(`Smile adjustment: Level +${(inv1.smileAdjustments.deltaL0 * 100).toFixed(2)}%`);
  
  // Try to reduce risk
  console.log('\n2. Trying to buy back some risk...');
  model.executeTrade(100, 0.08, 'BUY', 50);  // Buy back ATM
  
  console.log('\nAfter reducing - edge decreases:');
  model.formatQuotes([95, 100, 105], 0.08);
  
  const inv2 = model.getInventory();
  console.log(`Position: ${inv2.totalVega.toFixed(1)} vega`);
  console.log(`Smile adjustment: Level +${(inv2.smileAdjustments.deltaL0 * 100).toFixed(2)}%`);
}

function scenario3_SkewTrading() {
  console.log('\n' + '='.repeat(60));
  console.log('SCENARIO 3: Skew Trading (Put-Call Imbalance)');
  console.log('='.repeat(60));
  
  const model = new SimpleAdapter(100);
  
  console.log('\nBalanced market initially:');
  model.formatQuotes([90, 95, 100, 105, 110], 0.08);
  
  // Heavy put selling
  console.log('\n1. Market sells puts aggressively...');
  model.executeTrade(95, 0.08, 'SELL', 100);
  model.executeTrade(90, 0.08, 'SELL', 100);
  
  console.log('\nPut skew emerges (puts more expensive):');
  model.formatQuotes([90, 95, 100, 105, 110], 0.08);
  
  const inv1 = model.getInventory();
  console.log(`\nSkew adjustment: ${(inv1.smileAdjustments.deltaS0 * 100).toFixed(3)}%`);
  
  // Now calls get sold
  console.log('\n2. Market sells calls to balance...');
  model.executeTrade(105, 0.08, 'SELL', 100);
  model.executeTrade(110, 0.08, 'SELL', 100);
  
  console.log('\nMore balanced smile:');
  model.formatQuotes([90, 95, 100, 105, 110], 0.08);
  
  const inv2 = model.getInventory();
  console.log(`\nTotal position: ${inv2.totalVega.toFixed(1)} vega`);
  console.log('Inventory by bucket:');
  Object.entries(inv2.byBucket).forEach(([bucket, data]: [string, any]) => {
    if (data.vega !== 0) {
      console.log(`  ${bucket}: ${data.vega.toFixed(1)} vega`);
    }
  });
}

function scenario4_StressTest() {
  console.log('\n' + '='.repeat(60));
  console.log('SCENARIO 4: Stress Test (Large Position)');
  console.log('='.repeat(60));
  
  const model = new SimpleAdapter(100);
  
  console.log('\nNormal market:');
  model.formatQuotes([95, 100, 105], 0.08);
  
  console.log('\n💥 Massive one-sided flow hits...');
  model.executeTrade(100, 0.08, 'SELL', 500);  // Huge ATM sale
  
  console.log('\nExtreme adjustment - look at the edge!');
  model.formatQuotes([95, 100, 105], 0.08);
  
  const inv = model.getInventory();
  console.log(`\nPosition: ${inv.totalVega.toFixed(1)} vega (very short!)`);
  console.log(`Level adjustment: ${(inv.smileAdjustments.deltaL0 * 100).toFixed(2)}% 🚨`);
  
  console.log('\nThis shows the model protects itself with wide spreads');
  console.log('when inventory gets extreme.');
}

// Run all scenarios
function runAll() {
  scenario1_NormalFlow();
  scenario2_InventoryManagement();
  scenario3_SkewTrading();
  scenario4_StressTest();
  
  console.log('\n' + '='.repeat(60));
  console.log('SCENARIOS COMPLETE');
  console.log('='.repeat(60));
  console.log('\nKey observations:');
  console.log('1. Edge (PC-CC) grows with inventory risk');
  console.log('2. Sizes adjust based on position direction');
  console.log('3. Entire smile shifts, not just single strikes');
  console.log('4. Model naturally tries to reduce inventory via pricing');
}

runAll();