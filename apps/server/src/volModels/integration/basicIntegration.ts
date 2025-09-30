import { CorrectedAdapter } from '../correctedAdapter';

// Start with just BTC to test
const btcModel = new CorrectedAdapter(100);  // Initialize with spot price

// Simple function to get a quote
export function getVolQuote(strike: number) {
  return btcModel.getQuote(strike);
}

// Test it works
console.log('Test quote for strike 95:', getVolQuote(95));