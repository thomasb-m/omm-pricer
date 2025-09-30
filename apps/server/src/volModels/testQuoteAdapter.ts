/**
 * Test the Quote Engine Adapter
 */

import { QuoteEngineAdapter, Fill, RiskMetrics } from './quoteEngineAdapter';

console.log('\n' + '='.repeat(60));
console.log('QUOTE ENGINE ADAPTER TEST');
console.log('='.repeat(60));

const adapter = new QuoteEngineAdapter('BTC', 100);

// Register event handlers
adapter.on('fill', (fill: Fill) => {
  console.log(`\n✅ FILL: ${fill.side} ${fill.size}x ${fill.strike} @ ${fill.price.toFixed(2)}`);
});

adapter.on('risk', (risk: RiskMetrics) => {
  console.log(`\n📊 Risk Update:`);
  console.log(`  Total Vega: ${risk.totalVega.toFixed(1)}`);
  console.log(`  Smile Level Adj: ${(risk.smileAdjustments.level * 100).toFixed(3)}%`);
});

// Initial quote grid
console.log('\nInitial quotes:');
console.log(adapter.formatQuoteTable([90, 95, 100, 105, 110], 0.08));

// Simulate trades
console.log('\n' + '-'.repeat(60));
console.log('Executing trades...');

try {
  adapter.executeTrade(95, 0.08, 'SELL', 100);
  adapter.executeTrade(100, 0.08, 'SELL', 50);
  adapter.executeTrade(105, 0.08, 'BUY', 75);
} catch (error) {
  console.error('Error executing trades:', error);
}

// Show updated quotes
console.log('\nQuotes after trades:');
console.log(adapter.formatQuoteTable([90, 95, 100, 105, 110], 0.08));

// Show risk metrics
const risk = adapter.getRiskMetrics();
console.log('\nFinal Risk Metrics:');
console.log(`  Total Vega: ${risk.totalVega.toFixed(1)}`);
console.log(`  Total Gamma: ${risk.totalGamma.toFixed(1)}`);
console.log('\n  Bucket breakdown:');
risk.buckets.forEach((b: any) => {
  if (b.vega !== 0) {
    console.log(`    ${b.name}: ${b.vega.toFixed(1)} vega, edge: ${b.edge.toFixed(2)}`);
  }
});

console.log('\n' + '='.repeat(60));
console.log('TEST COMPLETE');
console.log('='.repeat(60));