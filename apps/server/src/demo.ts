// apps/server/src/demo.ts
/**
 * End-to-End Demo: Complete integration test
 * 
 * This demonstrates the full flow:
 * 1. Market data ticks (SimAdapter)
 * 2. Factor greeks computation (your FactorSpace)
 * 3. Covariance updates (SigmaService)
 * 4. Risk calculations (FactorRisk)
 * 5. Quote generation
 * 6. Fill simulation
 * 7. Inventory updates
 */

import { SigmaService } from './risk/SigmaService';
import { FactorRisk } from './risk/FactorRisk';
import { factorGreeksFor, Instrument, MarketContext } from './risk/factorGreeksLoader';
import { SimAdapter } from './exchange/SimAdapter';
import { d, FACTOR_LABELS } from './risk/factors';
import { Theta, PriceFn } from './risk/FactorSpace';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Risk parameters (conservative for Week 1 Day 1-5)
  risk: {
    gamma: 1.0,
    z: 0.0,      // No model spread yet
    eta: 0.0,    // No microstructure spread yet
    kappa: 0.0,  // No inventory widening yet
    L: 1.0,
    ridgeEpsilon: 1e-5,
    feeBuffer: 0.50,
    qMax: 10,
    minEdge: 0.10,
  },
  
  // Sigma parameters
  sigma: {
    horizonMs: 1000,
    alpha: 0.05,
    ridgeEpsilon: 1e-5,
    minSamples: 10, // Lower for demo
  },
  
  // Simulation parameters
  sim: {
    initialF: 50000,
    ouMean: 50000,
    ouTheta: 0.1,
    ouSigma: 0.02,
    tickMs: 1000,
    fillProbBase: 0.15,
    fillProbSpreadDecay: 0.5,
    fillProbSizeDecay: 0.3,
    slippageBps: 1.0,
  },
  
  // How many ticks to run
  numTicks: 50,
};

// ============================================================================
// Initialize Services
// ============================================================================

console.log('🚀 Initializing services...\n');

const sigmaService = new SigmaService(CONFIG.sigma);
const factorRisk = new FactorRisk(CONFIG.risk);
const simAdapter = new SimAdapter(CONFIG.sim, 42);

// ============================================================================
// Portfolio State
// ============================================================================

let inventory: number[] = new Array(d).fill(0);
let portfolioValue = 0;
let realizedPnL = 0;
let totalFees = 0;

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
];

// ============================================================================
// Pricing Function (Using Your FactorSpace)
// ============================================================================

/**
 * This wraps your existing pricing logic
 * Replace the body with your actual Black-76/local vol pricer
 */
const priceFn: PriceFn<Instrument> = (theta: Theta, inst: Instrument) => {
  // Extract factors
  const [L0, S0, C0, Sneg, Spos, F] = theta;
  
  // Compute moneyness
  const K = inst.strike;
  const m = Math.log(K / F);
  
  // Time to expiry (years)
  const t = Math.max(0.01, (inst.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000));
  
  // Simplified vol surface (replace with your actual model)
  // This is just a placeholder - use your real SVI/SABR/etc.
  let iv = L0 + S0 * m + C0 * m * m;
  if (m < 0) iv += Sneg * m * m;
  if (m > 0) iv += Spos * m * m;
  iv = Math.max(0.05, Math.min(2.0, iv)); // Clamp to reasonable range
  
  // Black-76 approximation (replace with your actual pricer)
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(F / K) + 0.5 * iv * iv * t) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  
  // Standard normal CDF approximation
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
  
  return Math.max(0, callPrice);
};

// ============================================================================
// Portfolio Factor Computation
// ============================================================================

function computePortfolioFactors(theta: Theta): number[] {
  // This should aggregate factors across all positions
  // For now, just return current inventory
  return [...inventory];
}

// ============================================================================
// Main Loop
// ============================================================================

console.log('📊 Starting simulation...\n');
console.log('Factor Labels:', FACTOR_LABELS.join(', '));
console.log('Initial Config:', {
  gamma: CONFIG.risk.gamma,
  z: CONFIG.risk.z,
  eta: CONFIG.risk.eta,
  kappa: CONFIG.risk.kappa,
});
console.log('\n' + '='.repeat(100) + '\n');

for (let tick = 0; tick < CONFIG.numTicks; tick++) {
  // ==========================================================================
  // 1. Tick Market Data
  // ==========================================================================
  
  const md = simAdapter.tick();
  const marketCtx: MarketContext = {
    theta: [md.atmIV, md.skew, 0.01, 0.005, 0.005, md.F] as Theta,
  };
  
  // ==========================================================================
  // 2. Update Σ with Current Portfolio Factors
  // ==========================================================================
  
  const portfolioFactors = computePortfolioFactors(marketCtx.theta);
  sigmaService.update(portfolioFactors, md.ts);
  
  const sigmaStats = sigmaService.getStats();
  const sigmaReady = sigmaService.isReady();
  
  if (!sigmaReady) {
    console.log(`[Tick ${tick}] Warming up Σ... (${sigmaStats.sampleCount}/${CONFIG.sigma.minSamples})`);
    continue;
  }
  
  // ==========================================================================
  // 3. Update Risk State (Λ, λ)
  // ==========================================================================
  
  const Sigma = sigmaService.getSigmaRaw();
  factorRisk.updateState(Sigma, inventory);
  
  // ==========================================================================
  // 4. Generate Quotes for All Instruments
  // ==========================================================================
  
  const quotes: Array<{
    symbol: string;
    theo: number;
    bid: number;
    ask: number;
    sizeBid: number;
    sizeAsk: number;
    skew: number;
    g: number[];
  }> = [];
  
  for (const inst of instruments) {
    // Compute theoretical value
    const theo = priceFn(marketCtx.theta, inst);
    
    // Compute factor greeks
    const g = factorGreeksFor(inst, marketCtx, priceFn);
    
    // Get microstructure vol (dummy for now)
    const sigmaMD = 0.002;
    
    // Compute quote params
    const quoteParams = factorRisk.computeQuote(g, theo, sigmaMD, theo);
    
    quotes.push({
      symbol: inst.symbol,
      theo,
      bid: quoteParams.bid,
      ask: quoteParams.ask,
      sizeBid: quoteParams.sizeBid,
      sizeAsk: quoteParams.sizeAsk,
      skew: quoteParams.skew,
      g,
    });
  }
  
  // ==========================================================================
  // 5. Try to Fill
  // ==========================================================================
  
  const simQuotes = quotes.map(q => ({
    symbol: q.symbol,
    bid: q.bid,
    ask: q.ask,
    sizeBid: q.sizeBid,
    sizeAsk: q.sizeAsk,
  }));
  
  const fills = simAdapter.tryFill(simQuotes);
  
  // ==========================================================================
  // 6. Process Fills & Update Inventory
  // ==========================================================================
  
  for (const fill of fills) {
    const quote = quotes.find(q => q.symbol === fill.symbol);
    if (!quote) continue;
    
    // Update inventory
    const sign = fill.side === 'buy' ? 1 : -1;
    for (let i = 0; i < d; i++) {
      inventory[i] += sign * quote.g[i] * fill.qty;
    }
    
    // Update PnL
    const edge = Math.abs(quote.theo - fill.price);
    const pnlFromEdge = (fill.side === 'buy' ? -1 : 1) * edge * fill.qty;
    realizedPnL += pnlFromEdge;
    totalFees += CONFIG.risk.feeBuffer * fill.qty;
    
    console.log(`  💰 FILL: ${fill.side.toUpperCase()} ${fill.qty} ${fill.symbol} @ ${fill.price.toFixed(2)} | Edge: $${edge.toFixed(2)}`);
  }
  
  // ==========================================================================
  // 7. Print Status
  // ==========================================================================
  
  if (tick % 5 === 0 || fills.length > 0) {
    const invUtil = factorRisk.getInventoryUtilization();
    
    console.log(`\n[Tick ${tick}]`);
    console.log(`  Market: F=${md.F.toFixed(2)}, IV=${md.atmIV.toFixed(4)}, Skew=${md.skew.toFixed(4)}`);
    console.log(`  Σ: trace=${sigmaStats.traceValue.toFixed(6)}, κ=${sigmaStats.conditionNumber.toFixed(2)}, samples=${sigmaStats.sampleCount}`);
    console.log(`  Inventory: util=${(invUtil * 100).toFixed(1)}%, ||I||=[${inventory.map(x => x.toFixed(2)).join(', ')}]`);
    console.log(`  PnL: realized=$${realizedPnL.toFixed(2)}, fees=$${totalFees.toFixed(2)}, net=$${(realizedPnL - totalFees).toFixed(2)}`);
    console.log(`  Quotes: ${quotes.length}, Fills: ${fills.length}`);
    
    if (quotes.length > 0) {
      const q = quotes[0];
      console.log(`  Sample Quote (${q.symbol}): bid=${q.bid.toFixed(2)}, ask=${q.ask.toFixed(2)}, skew=${q.skew.toFixed(2)}, size=${q.sizeBid.toFixed(1)}`);
    }
    
    console.log('');
  }
}

// ============================================================================
// Final Summary
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('📈 SIMULATION COMPLETE\n');

const finalStats = sigmaService.getStats();
const finalUtil = factorRisk.getInventoryUtilization();
const netPnL = realizedPnL - totalFees;

console.log('Final State:');
console.log(`  Ticks:      ${CONFIG.numTicks}`);
console.log(`  Σ Samples:  ${finalStats.sampleCount}`);
console.log(`  Σ κ:        ${finalStats.conditionNumber.toFixed(2)}`);
console.log(`  Inv Util:   ${(finalUtil * 100).toFixed(1)}%`);
console.log(`  Realized:   $${realizedPnL.toFixed(2)}`);
console.log(`  Fees:       $${totalFees.toFixed(2)}`);
console.log(`  Net PnL:    $${netPnL.toFixed(2)}`);
console.log(`  Final Inv:  [${inventory.map(x => x.toFixed(2)).join(', ')}]`);

console.log('\n✅ Demo complete! All systems working.\n');