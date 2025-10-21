// apps/server/src/engine/QuoteEngine.ts
/**
 * Phase 2 Week 1 Day 3: QuoteEngine integration with FactorRisk
 * 
 * Orchestrates:
 * 1. Factor greeks computation
 * 2. Risk calculations (skew, spread, size)
 * 3. Quote generation
 */

import { d, FactorVector } from '../risk/factors/index.js';
import { FactorRisk, QuoteParams } from '../risk/FactorRisk';
import { SigmaService } from '../risk/SigmaService';
import { factorGreeksFor, Instrument, MarketContext } from '../risk/factorGreeksLoader';

export type QuoteEngineConfig = {
  symbols: string[];           // Which instruments to quote
  
  // Microstructure vol per symbol (σ_md)
  // You'll compute this via EWMA of mid returns @ 100-300ms
  sigmaMD: Record<string, number>;
  
  // Edge targets per instrument type
  edgeTargets: {
    atm: number;               // e.g. 0.5 per lot
    otm: number;               // e.g. 1.0 per lot
    wing: number;              // e.g. 1.5 per lot
  };
};

export type QuoteOutput = {
  symbol: string;
  strike: number;
  expiryMs: number;
  
  // Prices
  theoRaw: number;
  theoInv: number;
  bid: number;
  ask: number;
  
  // Sizes
  sizeBid: number;
  sizeAsk: number;
  
  // Diagnostics
  skew: number;
  spread: number;
  spreadComponents: {
    fee: number;
    noise: number;
    model: number;
    inventory: number;
  };
  
  // Risk
  gLambdaG: number;
  invUtil: number;
  
  // Metadata
  g: number[];               // Factor greeks
  factorContributions?: number[];
};

export class QuoteEngine {
  private config: QuoteEngineConfig;
  private factorRisk: FactorRisk;
  private sigmaService: SigmaService;
  
  // Current portfolio state
  private inventory: number[];  // I vector (d-dimensional)
  
  constructor(
    config: QuoteEngineConfig,
    factorRisk: FactorRisk,
    sigmaService: SigmaService
  ) {
    this.config = config;
    this.factorRisk = factorRisk;
    this.sigmaService = sigmaService;
    
    // Initialize zero inventory
    this.inventory = new Array(d).fill(0);
  }
  
  /**
   * Update inventory (call after each trade)
   */
  updateInventory(inventory: number[]): void {
    if (inventory.length !== d) {
      throw new Error(`Inventory dimension mismatch: expected ${d}, got ${inventory.length}`);
    }
    this.inventory = [...inventory];
  }
  
  /**
   * Main entry point: compute all quotes
   * 
   * @param instruments - List of instruments to quote
   * @param ctx - Market context (spot, vol surface, etc.)
   * @param theos - Pre-computed theoretical values per instrument
   * @param mids - Current market mids per instrument
   * @returns Array of quotes
   */
  computeQuotes(
    instruments: Instrument[],
    ctx: MarketContext,
    theos: Map<string, number>,
    mids: Map<string, number>
  ): QuoteOutput[] {
    // Update risk state with current Σ and I
    const Sigma = this.sigmaService.getSigmaRaw();
    this.factorRisk.updateState(Sigma, this.inventory);
    
    const quotes: QuoteOutput[] = [];
    
    for (const instr of instruments) {
      // Skip if not in our universe
      if (!this.config.symbols.includes(instr.symbol)) continue;
      
      // Get theoretical mid
      const theoRaw = theos.get(instr.symbol);
      if (theoRaw === undefined) continue;
      
      // Get current market mid
      const mid = mids.get(instr.symbol) ?? theoRaw;
      
      // Compute factor greeks
      const g = factorGreeksFor(instr, ctx);
      
      // Get microstructure vol
      const sigmaMD = this.config.sigmaMD[instr.symbol] ?? 0.001;
      
      // Compute quote params via FactorRisk
      const params = this.factorRisk.computeQuote(g, theoRaw, sigmaMD, mid);
      
      // Package output
      quotes.push({
        symbol: instr.symbol,
        strike: instr.strike,
        expiryMs: instr.expiryMs,
        
        theoRaw: params.theoRaw,
        theoInv: params.theoInv,
        bid: params.bid,
        ask: params.ask,
        
        sizeBid: params.sizeBid,
        sizeAsk: params.sizeAsk,
        
        skew: params.skew,
        spread: params.spreadComponents.total,
        spreadComponents: {
          fee: params.spreadComponents.fee,
          noise: params.spreadComponents.noise,
          model: params.spreadComponents.model,
          inventory: params.spreadComponents.inventory,
        },
        
        gLambdaG: params.gLambdaG,
        invUtil: params.inventoryUtilization,
        
        g,
        factorContributions: params.factorContributions,
      });
    }
    
    return quotes;
  }
  
  /**
   * Get current inventory utilization
   */
  getInventoryUtilization(): number {
    return this.factorRisk.getInventoryUtilization();
  }
  
  /**
   * Update config (e.g. adjust sigmaMD online)
   */
  updateConfig(partial: Partial<QuoteEngineConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}

/**
 * Example integration into main loop
 */

/*
// Initialization
const sigmaService = new SigmaService({
  horizonMs: 1000,
  alpha: 0.05,
  ridgeEpsilon: 1e-5,
  minSamples: 50,
});

const factorRisk = new FactorRisk({
  gamma: 1.0,
  z: 1.0,
  eta: 1.0,
  kappa: 0.5,
  L: 1.0,
  ridgeEpsilon: 1e-5,
  feeBuffer: 0.50,
  qMax: 10,
  minEdge: 0.1,
});

const quoteEngine = new QuoteEngine(
  {
    symbols: ['BTC-25DEC25-50000-C', 'BTC-25DEC25-50000-P'],
    sigmaMD: {
      'BTC-25DEC25-50000-C': 0.002,
      'BTC-25DEC25-50000-P': 0.002,
    },
    edgeTargets: {
      atm: 0.5,
      otm: 1.0,
      wing: 1.5,
    },
  },
  factorRisk,
  sigmaService
);

const simAdapter = new SimAdapter({
  initialF: 50000,
  ouMean: 50000,
  ouTheta: 0.1,
  ouSigma: 0.02,
  tickMs: 1000,
  fillProbBase: 0.1,
  fillProbSpreadDecay: 0.5,
  fillProbSizeDecay: 0.3,
  slippageBps: 1.0,
}, 42);

const apiService = new APIService(sigmaService, factorRisk);
apiService.start(3000);

// Main loop (1Hz)
setInterval(() => {
  // 1. Tick market data
  const md = simAdapter.tick();
  
  // 2. Update Σ with current factors
  const portfolioFactors = computePortfolioFactors(md); // Your impl
  sigmaService.update(portfolioFactors, Date.now());
  
  // 3. Compute theos for all instruments
  const instruments = getInstruments(); // Your impl
  const theos = new Map<string, number>();
  const mids = new Map<string, number>();
  
  for (const instr of instruments) {
    const theo = computeTheo(instr, md); // Your impl
    theos.set(instr.symbol, theo);
    mids.set(instr.symbol, md.F); // Simplified
  }
  
  // 4. Generate quotes
  const marketCtx: MarketContext = {
    F: md.F,
    atmIV: md.atmIV,
    skew: md.skew,
    t: 0.25, // Example: 3 months
    r: 0.05,
  };
  
  const quotes = quoteEngine.computeQuotes(instruments, marketCtx, theos, mids);
  
  // 5. Try to fill
  const simQuotes = quotes.map(q => ({
    symbol: q.symbol,
    bid: q.bid,
    ask: q.ask,
    sizeBid: q.sizeBid,
    sizeAsk: q.sizeAsk,
  }));
  
  const fills = simAdapter.tryFill(simQuotes);
  
  // 6. Update inventory
  for (const fill of fills) {
    updateInventoryFromFill(fill); // Your impl
  }
  
  // 7. Broadcast state via API
  apiService.updateQuotes({
    ts: Date.now(),
    quotes: quotes.map(q => ({
      symbol: q.symbol,
      bid: q.bid,
      ask: q.ask,
      sizeBid: q.sizeBid,
      sizeAsk: q.sizeAsk,
      spread: q.spread,
      skew: q.skew,
      invUtil: q.invUtil,
    })),
  });
  
  // 8. Log to DB (every N ticks)
  if (shouldLog()) {
    logQuotesToDB(quotes);
    logInventoryToDB(inventory);
    logRiskMetricsToDB(sigmaService.getStats());
  }
  
}, 1000);
*/