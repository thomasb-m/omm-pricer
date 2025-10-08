// apps/server/src/testing/ABTestRunner.ts
/**
 * A/B Test Harness: Compare two configurations side-by-side
 * 
 * Runs both configs on the same market data and compares:
 * - PnL (realized, fees, net)
 * - Sharpe ratio
 * - Fill rate
 * - Inventory utilization
 * - Quote spreads
 */

import { SigmaService } from '../risk/SigmaService';
import { FactorRisk } from '../risk/FactorRisk';
import { SimAdapter } from '../exchange/SimAdapter';
import { FeatureConfig } from '../config/featureFlags';
import { d } from '../risk/factors';
import { Instrument, MarketContext, factorGreeksFor } from '../risk/factorGreeksLoader';
import { PriceFn, Theta } from '../risk/FactorSpace';

export type ABTestConfig = {
  name: string;
  config: FeatureConfig;
};

export type ABTestMetrics = {
  configName: string;
  
  // PnL metrics
  realizedPnL: number;
  totalFees: number;
  netPnL: number;
  
  // Trading metrics
  totalTrades: number;
  fillRate: number;           // fills / quotes
  avgEdge: number;
  
  // Risk metrics
  maxInventoryUtil: number;
  avgInventoryUtil: number;
  
  // Quote metrics
  avgSpread: number;
  avgSize: number;
  
  // Performance
  sharpeRatio: number;
  pnlPerTrade: number;
  
  // Time series (for charting)
  pnlTimeSeries: Array<{ tick: number; pnl: number }>;
  invUtilTimeSeries: Array<{ tick: number; util: number }>;
};

export type ABTestResult = {
  configA: ABTestMetrics;
  configB: ABTestMetrics;
  winner: 'A' | 'B' | 'TIE';
  winnerReason: string;
  timestamp: number;
};

export class ABTestRunner {
  /**
   * Run A/B test comparing two configurations
   */
  static async runComparison(
    configA: ABTestConfig,
    configB: ABTestConfig,
    numTicks: number,
    instruments: Instrument[],
    priceFn: PriceFn<Instrument>,
    seed?: number
  ): Promise<ABTestResult> {
    console.log(`\n🔬 Starting A/B Test: ${configA.name} vs ${configB.name}\n`);
    
    // Run both configs
    const metricsA = await this.runConfig(configA, numTicks, instruments, priceFn, seed);
    const metricsB = await this.runConfig(configB, numTicks, instruments, priceFn, seed);
    
    // Determine winner
    const { winner, reason } = this.determineWinner(metricsA, metricsB);
    
    return {
      configA: metricsA,
      configB: metricsB,
      winner,
      winnerReason: reason,
      timestamp: Date.now(),
    };
  }
  
  /**
   * Run a single configuration and collect metrics
   */
  private static async runConfig(
    testConfig: ABTestConfig,
    numTicks: number,
    instruments: Instrument[],
    priceFn: PriceFn<Instrument>,
    seed?: number
  ): Promise<ABTestMetrics> {
    const config = testConfig.config;
    
    // Initialize services
    const sigmaService = new SigmaService(config.sigma);
    const factorRisk = new FactorRisk(config.risk);
    const simAdapter = new SimAdapter(config.sim, seed);
    
    // State
    let inventory = new Array(d).fill(0);
    let realizedPnL = 0;
    let totalFees = 0;
    let totalTrades = 0;
    let totalQuotes = 0;
    let totalFills = 0;
    let totalEdge = 0;
    let totalSpread = 0;
    let totalSize = 0;
    let maxInventoryUtil = 0;
    let sumInventoryUtil = 0;
    let ticksProcessed = 0;
    
    // Time series
    const pnlTimeSeries: Array<{ tick: number; pnl: number }> = [];
    const invUtilTimeSeries: Array<{ tick: number; util: number }> = [];
    
    // Main loop
    for (let tick = 0; tick < numTicks; tick++) {
      const md = simAdapter.tick();
      const marketCtx: MarketContext = {
        theta: [md.atmIV, md.skew, 0.01, 0.005, 0.005, md.F] as Theta,
      };
      
      // Update Σ
      const portfolioFactors = [...inventory];
      sigmaService.update(portfolioFactors, md.ts);
      
      if (!sigmaService.isReady()) continue;
      
      // Update risk state
      const Sigma = sigmaService.getSigmaRaw();
      factorRisk.updateState(Sigma, inventory);
      
      // Generate quotes
      const quotes = [];
      for (const inst of instruments) {
        const theo = priceFn(marketCtx.theta, inst);
        
        // ✅ FIX: Use the real factorGreeksFor function
        const g = factorGreeksFor(inst, marketCtx, priceFn);
        
        const sigmaMD = 0.002;
        const marketMid = theo / 1.01;
        
        const quoteParams = factorRisk.computeQuote(g, theo, sigmaMD, marketMid);
        
        quotes.push({
          symbol: inst.symbol,
          bid: quoteParams.bid,
          ask: quoteParams.ask,
          sizeBid: quoteParams.sizeBid,
          sizeAsk: quoteParams.sizeAsk,
          spread: quoteParams.spreadComponents.total,
          g,
          theo,
        });
        
        totalQuotes++;
        totalSpread += quoteParams.spreadComponents.total;
        totalSize += quoteParams.sizeBid;
      }
      
      // Try to fill
      const simQuotes = quotes.map(q => ({
        symbol: q.symbol,
        bid: q.bid,
        ask: q.ask,
        sizeBid: q.sizeBid,
        sizeAsk: q.sizeAsk,
      }));
      
      const fills = simAdapter.tryFill(simQuotes);
      totalFills += fills.length;
      
      // Process fills
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
        totalFees += config.risk.feeBuffer * fill.qty;
        totalEdge += edge;
        totalTrades++;
      }
      
      // Track metrics
      const invUtil = factorRisk.getInventoryUtilization();
      maxInventoryUtil = Math.max(maxInventoryUtil, invUtil);
      sumInventoryUtil += invUtil;
      ticksProcessed++;
      
      pnlTimeSeries.push({ tick, pnl: realizedPnL - totalFees });
      invUtilTimeSeries.push({ tick, util: invUtil });
    }
    
    // Calculate final metrics
    const netPnL = realizedPnL - totalFees;
    const fillRate = totalQuotes > 0 ? totalFills / totalQuotes : 0;
    const avgEdge = totalTrades > 0 ? totalEdge / totalTrades : 0;
    const avgInventoryUtil = ticksProcessed > 0 ? sumInventoryUtil / ticksProcessed : 0;
    const avgSpread = totalQuotes > 0 ? totalSpread / totalQuotes : 0;
    const avgSize = totalQuotes > 0 ? totalSize / totalQuotes : 0;
    const pnlPerTrade = totalTrades > 0 ? netPnL / totalTrades : 0;
    
    // Calculate Sharpe ratio (simplified)
    const pnlReturns = pnlTimeSeries.map(p => p.pnl);
    const avgReturn = pnlReturns.reduce((a, b) => a + b, 0) / pnlReturns.length;
    const variance = pnlReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / pnlReturns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;
    
    return {
      configName: testConfig.name,
      realizedPnL,
      totalFees,
      netPnL,
      totalTrades,
      fillRate,
      avgEdge,
      maxInventoryUtil,
      avgInventoryUtil,
      avgSpread,
      avgSize,
      sharpeRatio,
      pnlPerTrade,
      pnlTimeSeries,
      invUtilTimeSeries,
    };
  }
  
  /**
   * Determine winner based on multiple criteria
   */
  private static determineWinner(
    metricsA: ABTestMetrics,
    metricsB: ABTestMetrics
  ): { winner: 'A' | 'B' | 'TIE'; reason: string } {
    // Primary criterion: Net PnL
    if (Math.abs(metricsA.netPnL - metricsB.netPnL) > 1.0) {
      const winner = metricsA.netPnL > metricsB.netPnL ? 'A' : 'B';
      const diff = Math.abs(metricsA.netPnL - metricsB.netPnL);
      return {
        winner,
        reason: `Higher net PnL by $${diff.toFixed(2)} (${winner === 'A' ? metricsA.netPnL.toFixed(2) : metricsB.netPnL.toFixed(2)} vs ${winner === 'A' ? metricsB.netPnL.toFixed(2) : metricsA.netPnL.toFixed(2)})`,
      };
    }
    
    // Secondary criterion: Sharpe ratio
    if (Math.abs(metricsA.sharpeRatio - metricsB.sharpeRatio) > 0.1) {
      const winner = metricsA.sharpeRatio > metricsB.sharpeRatio ? 'A' : 'B';
      return {
        winner,
        reason: `Better Sharpe ratio (${winner === 'A' ? metricsA.sharpeRatio.toFixed(2) : metricsB.sharpeRatio.toFixed(2)} vs ${winner === 'A' ? metricsB.sharpeRatio.toFixed(2) : metricsA.sharpeRatio.toFixed(2)})`,
      };
    }
    
    // Tertiary criterion: PnL per trade
    if (Math.abs(metricsA.pnlPerTrade - metricsB.pnlPerTrade) > 0.1) {
      const winner = metricsA.pnlPerTrade > metricsB.pnlPerTrade ? 'A' : 'B';
      return {
        winner,
        reason: `Better PnL per trade ($${winner === 'A' ? metricsA.pnlPerTrade.toFixed(2) : metricsB.pnlPerTrade.toFixed(2)} vs $${winner === 'A' ? metricsB.pnlPerTrade.toFixed(2) : metricsA.pnlPerTrade.toFixed(2)})`,
      };
    }
    
    return {
      winner: 'TIE',
      reason: 'Performance is statistically equivalent',
    };
  }
  
  /**
   * Format results for console
   */
  static formatResults(result: ABTestResult): string {
    const lines: string[] = [];
    
    lines.push('\n' + '='.repeat(100));
    lines.push('🔬 A/B TEST RESULTS');
    lines.push('='.repeat(100));
    
    // Winner
    const emoji = result.winner === 'TIE' ? '🤝' : result.winner === 'A' ? '🥇' : '🥈';
    lines.push(`\n${emoji} WINNER: Config ${result.winner}`);
    lines.push(`   ${result.winnerReason}`);
    
    // Comparison table
    lines.push('\n📊 COMPARISON');
    lines.push('─'.repeat(100));
    lines.push(`${'Metric'.padEnd(25)} | ${'Config A'.padEnd(20)} | ${'Config B'.padEnd(20)} | Delta`);
    lines.push('─'.repeat(100));
    
    const metrics = [
      { label: 'Net PnL', a: result.configA.netPnL, b: result.configB.netPnL, fmt: 'money' },
      { label: 'Sharpe Ratio', a: result.configA.sharpeRatio, b: result.configB.sharpeRatio, fmt: 'ratio' },
      { label: 'Total Trades', a: result.configA.totalTrades, b: result.configB.totalTrades, fmt: 'int' },
      { label: 'Fill Rate', a: result.configA.fillRate * 100, b: result.configB.fillRate * 100, fmt: 'pct' },
      { label: 'Avg Edge', a: result.configA.avgEdge, b: result.configB.avgEdge, fmt: 'money' },
      { label: 'PnL per Trade', a: result.configA.pnlPerTrade, b: result.configB.pnlPerTrade, fmt: 'money' },
      { label: 'Max Inv Util', a: result.configA.maxInventoryUtil * 100, b: result.configB.maxInventoryUtil * 100, fmt: 'pct' },
      { label: 'Avg Spread', a: result.configA.avgSpread, b: result.configB.avgSpread, fmt: 'money' },
    ];
    
    for (const m of metrics) {
      const aStr = this.formatValue(m.a, m.fmt);
      const bStr = this.formatValue(m.b, m.fmt);
      const delta = m.a - m.b;
      const deltaStr = this.formatValue(Math.abs(delta), m.fmt);
      const sign = delta > 0 ? '↑' : delta < 0 ? '↓' : '=';
      
      lines.push(`${m.label.padEnd(25)} | ${aStr.padEnd(20)} | ${bStr.padEnd(20)} | ${sign} ${deltaStr}`);
    }
    
    lines.push('='.repeat(100) + '\n');
    
    return lines.join('\n');
  }
  
  private static formatValue(val: number, fmt: string): string {
    if (fmt === 'money') return `$${val.toFixed(2)}`;
    if (fmt === 'pct') return `${val.toFixed(1)}%`;
    if (fmt === 'ratio') return val.toFixed(2);
    if (fmt === 'int') return val.toFixed(0);
    return val.toFixed(2);
  }
}