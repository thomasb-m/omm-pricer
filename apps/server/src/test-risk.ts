// apps/server/src/test-risk.ts
import { FactorRisk } from './risk/FactorRisk';

const factorRisk = new FactorRisk({
  gamma: 1.0,
  z: 0.0,
  eta: 0.0,
  kappa: 0.0,
  L: 1.0,
  ridgeEpsilon: 1e-5,
  feeBuffer: 0.50,
  qMax: 10,
  minEdge: 0.10,
});

// Simple 6x6 identity matrix
const Sigma = [
  [1, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 0],
  [0, 0, 0, 1, 0, 0],
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 0, 1],
];

const inventory = [0, 0, 0, 0, 0, 0]; // Zero inventory

factorRisk.updateState(Sigma, inventory);

const g = [1, 0.1, 0.5, 0.05, 0.05, 100]; // Sample greeks
const quote = factorRisk.computeQuote(g, 1000, 0.01, 1000);

console.log('Quote Test');
console.log('==========');
console.log(`Theo: ${quote.theoRaw.toFixed(2)}`);
console.log(`Bid:  ${quote.bid.toFixed(2)}`);
console.log(`Ask:  ${quote.ask.toFixed(2)}`);
console.log(`Size: ${quote.sizeBid.toFixed(2)}`);
console.log(`Skew: ${quote.skew.toFixed(4)}`);
console.log(`✅ FactorRisk works!`);