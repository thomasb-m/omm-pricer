// apps/server/src/test-factors.ts
import { FACTORS, d, FACTOR_LABELS } from './risk/factors/index.js';
import { factorGreeksFor, MarketContext } from './risk/factorGreeksLoader';
import { Theta } from './risk/FactorSpace';

console.log('Factor Registry Test');
console.log('====================');
console.log(`Version: ${FACTORS.version}`);
console.log(`Dimension: ${d}`);
console.log(`Labels: ${FACTOR_LABELS.join(', ')}`);
console.log('\n✅ Factor registry loaded successfully!');

// Test greek computation (dummy example)
const dummyInstr = {
  symbol: 'BTC-25DEC25-50000-C',
  strike: 50000,
  expiryMs: Date.parse('2025-12-25'),
  isCall: true,
};

const dummyCtx: MarketContext = {
  theta: [0.5, 0.02, 0.01, 0.005, 0.005, 50000] as Theta,  // ← Cast to Theta
};

const dummyPriceFn = (theta: any, inst: any) => {
  return 1000; // Dummy price
};

try {
  const g = factorGreeksFor(dummyInstr, dummyCtx, dummyPriceFn);
  console.log('\nGreeks computed:', g);
  console.log('✅ factorGreeksFor() works!');
} catch (e) {
  console.error('❌ Error:', e);
}