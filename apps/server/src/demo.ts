// apps/server/src/demo.ts
/**
 * End-to-End Demo: Complete integration test
 * 
 * Now with feature flags and explainability!
 * 
 * Usage:
 *   npx ts-node src/demo.ts                    # Default (week1-baseline)
 *   npx ts-node src/demo.ts --config=debug     # Debug mode
 *   npx ts-node src/demo.ts --config=minimal   # Minimal (isolate)
 */

import { SigmaService } from './risk/SigmaService';
import { FactorRisk } from './risk/FactorRisk';
import { factorGreeksFor, Instrument, MarketContext } from './risk/factorGreeksLoader';
import { SimAdapter } from './exchange/SimAdapter';
import { d, FACTOR_LABELS } from './risk/factors/index.js';
import { Theta, PriceFn } from './risk/FactorSpace';
import { loadConfigFromArgs } from './config/featureFlags';
import { QuoteExplainer } from './engine/QuoteExplainer';
import { DebugAPI } from './api/DebugAPI';

// ============================================================================
// Configuration (from command line or default)
// ============================================================================

const CONFIG = loadConfigFromArgs();

console.log(`\n🚀 Running: ${CONFIG.name} (v${CONFIG.version})`);
console.log(`Features:`, CONFIG.features);
console.log(`Risk: γ=${CONFIG.risk.gamma}, z=${CONFIG.risk.z}, η=${CONFIG.risk.eta}, κ=${CONFIG.risk.kappa}`);
console.log('');

// ============================================================================
// Initialize Services
// ============================================================================

console.log('🚀 Initializing services...\n');

const sigmaService = new SigmaService(CONFIG.sigma);
const factorRisk = new FactorRisk(CONFIG.risk);
const simAdapter = new SimAdapter(CONFIG.sim, 42);

// Portfolio State (moved up)
let inventory: number[] = new Array(d).fill(0);

// Now initialize DebugAPI (after inventory exists)
const debugAPI = new DebugAPI(3000, sigmaService, factorRisk, CONFIG, inventory);
debugAPI.start().then(() => {
  console.log('✅ Debug API started\n');
});

// ============================================================================
// Portfolio State
// ============================================================================

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
  
  // Add 0.5% edge for market making
  const edge = callPrice * 0.01;
  
  return Math.max(0, callPrice + edge);
};

// ============================================================================
// Portfolio Factor Computation
// ============================================================================

function computePortfolioFactors(theta: Theta): number[] {
    // Return current inventory as portfolio factors
    // These are already scaled properly from factorGreeksFor()
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
    if (tick === 15) {
        console.log(`\n🔍 DEBUG: tick=${tick}, inst.symbol=${inst.symbol}, instruments[0].symbol=${instruments[0].symbol}, match=${inst === instruments[0]}`);
      }
    // Compute theoretical value
    const theo = priceFn(marketCtx.theta, inst);
    
    // Compute factor greeks
    const g = factorGreeksFor(inst, marketCtx, priceFn);
    
    // Get microstructure vol (dummy for now)
    const sigmaMD = 0.002;
    
    // Compute quote params
    // Simulate market mid slightly different from theo
    const marketMid = theo / 1.01;  // Remove the 1% edge to get market mid
    const quoteParams = factorRisk.computeQuote(g, theo, sigmaMD, marketMid);
    if (tick === 15 || tick === 16 || tick === 17) {
        console.log(`\n🔍 [Tick ${tick}] ${inst.symbol} RAW VALUES:`);
        console.log('  spreadComponents:', quoteParams.spreadComponents);
        console.log('  gLambdaG:', quoteParams.gLambdaG);
      }
    
   // FORCE explanation at tick 15 
   if (tick === 15 && inst === instruments[0]) {
    console.log('\n🔍 FORCING EXPLANATION...\n');
    
    // ADD THESE LINES HERE:
    console.log('🔍 RAW SPREAD COMPONENTS:');
    console.log('  fee:', quoteParams.spreadComponents.fee);
    console.log('  model:', quoteParams.spreadComponents.model);
    console.log('  noise:', quoteParams.spreadComponents.noise);
    console.log('  inventory:', quoteParams.spreadComponents.inventory);
    console.log('  total:', quoteParams.spreadComponents.total);
    console.log('  gLambdaG:', quoteParams.gLambdaG);
    console.log('  sigmaMD:', sigmaMD);
    console.log('  z:', CONFIG.risk.z);
    console.log('  eta:', CONFIG.risk.eta);
    console.log('');
    
    const explanation = QuoteExplainer.explain(
      inst.symbol,
      theo,
      marketMid,
      quoteParams,
      CONFIG.risk.minEdge,
      {
        useModelSpread: CONFIG.features.useModelSpread,
        useMicrostructure: CONFIG.features.useMicrostructure,
        useInventoryWidening: CONFIG.features.useInventoryWidening,
        useInventorySkew: CONFIG.features.useInventorySkew,
      }
    );
    
    console.log(QuoteExplainer.formatForConsole(explanation, true));
  }

    // Explain decision if enabled (show more often in debug mode)
    if (CONFIG.features.explainDecisions && inst === instruments[0] && (tick === 15 || tick === 18)) {      const explanation = QuoteExplainer.explain(
        inst.symbol,
        theo,
        marketMid,
        quoteParams,
        CONFIG.risk.minEdge,
        {
          useModelSpread: CONFIG.features.useModelSpread,
          useMicrostructure: CONFIG.features.useMicrostructure,
          useInventoryWidening: CONFIG.features.useInventoryWidening,
          useInventorySkew: CONFIG.features.useInventorySkew,
        }
      );
      
      console.log(QuoteExplainer.formatForConsole(explanation, true));
      // Record quote in API
      debugAPI.recordQuote(inst.symbol, explanation);
    }
    
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
  }  // ← This closes the "for (const inst of instruments)" loop
  
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
  // const fills: any[] = [];  // ← Remove this line
  
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
    // Record trade in API
    debugAPI.recordTrade({
        timestamp: Date.now(),
        symbol: fill.symbol,
        side: fill.side,
        qty: fill.qty,
        price: fill.price,
        edge: edge,
      });
  }
  
  // Update inventory in API
  debugAPI.updateInventory(inventory);

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
console.log('💡 Debug API still running on http://localhost:3000');
console.log('💡 Open dashboard.html in your browser');
console.log('💡 Press Ctrl+C to stop\n');

// Keep the process alive so API stays running
process.stdin.resume();