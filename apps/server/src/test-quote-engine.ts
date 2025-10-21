// apps/server/src/test-quote-engine.ts
import { QuoteEngine } from './engine/QuoteEngine';
import { FactorRisk } from './risk/FactorRisk';
import { SigmaService } from './risk/SigmaService';

const sigmaService = new SigmaService({
  horizonMs: 1000,
  alpha: 0.05,
  ridgeEpsilon: 1e-5,
  minSamples: 10, // Lower for testing
});

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

const quoteEngine = new QuoteEngine(
  {
    symbols: ['BTC-25DEC25-50000-C'],
    tickMs: 1000,
    sigmaMD: { 'BTC-25DEC25-50000-C': 0.002 },
    edgeTargets: { atm: 0.5, otm: 1.0, wing: 1.5 },
  },
  factorRisk,
  sigmaService
);

console.log('✅ QuoteEngine initialized!');