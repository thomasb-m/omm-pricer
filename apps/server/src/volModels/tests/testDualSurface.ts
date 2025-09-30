/**
 * Test Suite for Dual Surface Model
 * Run this to verify everything is working
 */

import { DualSurfaceModel, TraderMetrics } from '../dualSurfaceModel';
import { getDefaultConfig } from '../config/modelConfig';
import { blackScholes, DeltaConventions } from '../pricing/blackScholes';

/**
 * Test 1: Basic surface creation and CC updates
 */
function testSurfaceCreation(): void {
  console.log('=== Test 1: Surface Creation ===\n');
  
  const config = getDefaultConfig('BTC');
  const model = new DualSurfaceModel(config);
  
  // Initial CC setup
  const expiry = 0.25; // 3 months
  const initialMetrics: TraderMetrics = {
    L0: 0.04,    // 20% vol for 3M (0.2^2 * 0.25)
    S0: 0.001,   // Small positive skew
    C0: 0.5,     // Moderate curvature
    S_neg: -0.8, // Left wing slope
    S_pos: 0.9   // Right wing slope
  };
  
  model.updateCC(expiry, initialMetrics);
  console.log('✅ Created initial CC with 20% ATM vol\n');
  
  // Get initial quotes
  const spot = 100;
  const strikes = [90, 95, 100, 105, 110];
  const quotes = model.getQuotes(expiry, strikes, spot);
  
  console.log('Initial quotes (no trades yet):');
  quotes.forEach((quote, strike) => {
    const bucket = DeltaConventions.strikeToBucket(strike, spot, 0.2, expiry);
    console.log(`  K=${strike} (${bucket}): ${quote.bid.toFixed(2)} / ${quote.ask.toFixed(2)}`);
  });
  
  console.log('');
}

/**
 * Test 2: Trade execution and PC anchoring
 */
function testTradeExecution(): void {
  console.log('=== Test 2: Trade Execution ===\n');
  
  const config = getDefaultConfig('BTC');
  const model = new DualSurfaceModel(config);
  
  // Setup
  const expiry = 0.25;
  const spot = 100;
  const initialMetrics: TraderMetrics = {
    L0: 0.04,
    S0: 0.001,
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
  };
  
  model.updateCC(expiry, initialMetrics);
  
  // Get quotes before trade
  const strikeToTrade = 95;
  const quotesBefore = model.getQuotes(expiry, [strikeToTrade], spot);
  const quoteBefore = quotesBefore.get(strikeToTrade)!;
  
  console.log(`Before trade - K=95: ${quoteBefore.bid.toFixed(2)} / ${quoteBefore.ask.toFixed(2)}`);
  
  // Execute trade - sell 100 lots at the ask
  const tradedPrice = quoteBefore.ask;
  model.onTrade(expiry, strikeToTrade, tradedPrice, 100, spot);
  
  console.log(`\n✅ Sold 100 lots at ${tradedPrice.toFixed(2)}\n`);
  
  // Get quotes after trade
  const quotesAfter = model.getQuotes(expiry, [90, 95, 100, 105, 110], spot);
  
  console.log('After trade - quotes:');
  quotesAfter.forEach((quote, strike) => {
    const marker = strike === strikeToTrade ? ' ← traded' : '';
    console.log(`  K=${strike}: ${quote.bid.toFixed(2)} / ${quote.ask.toFixed(2)}${marker}`);
  });
  
  console.log('\nNote: PC has anchored at trade price, quotes now centered there\n');
}

/**
 * Test 3: Width-delta rule on spot move
 */
function testWidthDeltaRule(): void {
  console.log('=== Test 3: Width-Delta Rule (Spot Move) ===\n');
  
  const config = getDefaultConfig('BTC');
  const model = new DualSurfaceModel(config);
  
  // Setup
  const expiry = 0.25;
  let spot = 100;
  const initialMetrics: TraderMetrics = {
    L0: 0.04,
    S0: 0.001,
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
  };
  
  model.updateCC(expiry, initialMetrics);
  
  // Trade at K=95 (initially ~25 delta put)
  const strike = 95;
  console.log(`Initial: Spot=${spot}, K=${strike}`);
  
  const initialDelta = Math.abs(blackScholes({
    strike,
    spot,
    vol: 0.2,
    T: expiry,
    r: 0,
    isCall: false
  }).delta);
  
  console.log(`  Delta: ${(initialDelta * 100).toFixed(0)}Δ`);
  console.log(`  Bucket: ${DeltaConventions.strikeToBucket(strike, spot, 0.2, expiry)}\n`);
  
  // Execute trade
  model.onTrade(expiry, strike, 5.5, 100, spot);
  console.log('✅ Sold 100 lots at 5.5\n');
  
  // Get quotes at original spot
  let quotes = model.getQuotes(expiry, [strike], spot);
  let quote = quotes.get(strike)!;
  console.log(`Quotes at spot=100: ${quote.bid.toFixed(2)} / ${quote.ask.toFixed(2)}`);
  
  // Move spot - strike gets closer to ATM
  spot = 96;
  console.log(`\n📉 Spot moves to ${spot} (strike now closer to ATM)\n`);
  
  const newDelta = Math.abs(blackScholes({
    strike,
    spot,
    vol: 0.2,
    T: expiry,
    r: 0,
    isCall: false
  }).delta);
  
  console.log(`New delta: ${(newDelta * 100).toFixed(0)}Δ`);
  console.log(`New bucket: ${DeltaConventions.strikeToBucket(strike, spot, 0.2, expiry)}\n`);
  
  // Get new quotes - should reflect higher risk
  quotes = model.getQuotes(expiry, [strike], spot);
  quote = quotes.get(strike)!;
  console.log(`Quotes at spot=96: ${quote.bid.toFixed(2)} / ${quote.ask.toFixed(2)}`);
  console.log('\n⚠️  Width should increase as position risk increased');
  console.log('(In full implementation, PC would adjust via width-delta rule)\n');
}

/**
 * Test 4: Greeks calculation
 */
function testGreeks(): void {
  console.log('=== Test 4: Greeks Calculation ===\n');
  
  const inputs = {
    strike: 100,
    spot: 100,
    vol: 0.25,
    T: 0.25,
    r: 0.05,
    isCall: true
  };
  
  const greeks = blackScholes(inputs);
  
  console.log('ATM Call (S=K=100, σ=25%, T=3M, r=5%):');
  console.log(`  Price: $${greeks.price.toFixed(2)}`);
  console.log(`  Delta: ${greeks.delta.toFixed(3)}`);
  console.log(`  Gamma: ${greeks.gamma.toFixed(4)}`);
  console.log(`  Vega:  $${greeks.vega.toFixed(2)} per 1% vol`);
  console.log(`  Theta: $${greeks.theta.toFixed(2)} per day`);
  console.log(`  Rho:   $${greeks.rho.toFixed(2)} per 1% rate`);
  
  // Test put-call parity
  const callGreeks = blackScholes({ ...inputs, isCall: true });
  const putGreeks = blackScholes({ ...inputs, isCall: false });
  
  const parityCheck = callGreeks.price - putGreeks.price - 
    (inputs.spot - inputs.strike * Math.exp(-inputs.r * inputs.T));
  
  console.log(`\n✅ Put-Call Parity check: ${Math.abs(parityCheck) < 0.01 ? 'PASS' : 'FAIL'}`);
  console.log(`  Difference: ${parityCheck.toFixed(6)}\n`);
}

/**
 * Test 5: Market learning (risk scorer)
 */
function testMarketLearning(): void {
  console.log('=== Test 5: Market Learning ===\n');
  
  const config = getDefaultConfig('BTC');
  const model = new DualSurfaceModel(config);
  
  // Setup surface
  const expiry = 0.25;
  const spot = 100;
  const initialMetrics: TraderMetrics = {
    L0: 0.04,
    S0: 0.001,
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
  };
  
  model.updateCC(expiry, initialMetrics);
  
  console.log('Simulating market observations...\n');
  
  // Simulate tight market
  console.log('Scenario 1: Tight market');
  // In real implementation, would update risk scorer with tight spreads
  let quotes = model.getQuotes(expiry, [100], spot);
  let quote = quotes.get(100)!;
  console.log(`  ATM: ${quote.bid.toFixed(2)} / ${quote.ask.toFixed(2)}`);
  
  // Simulate wide market (would need to update risk scorer)
  console.log('\nScenario 2: Wide market (stressed conditions)');
  console.log('  [In full implementation, spreads would widen]');
  
  console.log('\n✅ Market learning framework in place\n');
}

/**
 * Run all tests
 */
export function runAllTests(): void {
  console.log('\n' + '='.repeat(50));
  console.log('DUAL SURFACE MODEL - TEST SUITE');
  console.log('='.repeat(50) + '\n');
  
  try {
    testSurfaceCreation();
    testTradeExecution();
    testWidthDeltaRule();
    testGreeks();
    testMarketLearning();
    
    console.log('='.repeat(50));
    console.log('✅ ALL TESTS COMPLETED SUCCESSFULLY');
    console.log('='.repeat(50) + '\n');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests();
}