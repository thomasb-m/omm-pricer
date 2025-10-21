import { IntegratedSmileModel } from './src/volModels/integratedSmileModel';

console.log('🚀 INSTANT SHADOW MODE TEST\n');

const model = new IntegratedSmileModel('BTC');

// Realistic BTC market quotes
const quotes = Array.from({length: 12}, (_, i) => ({
  strike: 100000 + (i - 6) * 5000,
  iv: 0.60 + (Math.abs(i - 6) * 0.02),
  weight: 1
}));

const expiry = Date.now() + 7 * 24 * 3600 * 1000;
const spot = 100000;

console.log('📊 Market quotes:', quotes.length);
console.log('💰 Spot:', spot);
console.log('\n🔄 Calibrating (shadow mode active)...\n');

model.calibrateFromMarket(expiry, quotes, spot);

console.log('\n✅ Done! Check logs above for [SHADOW] comparisons\n');
