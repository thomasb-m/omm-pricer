// apps/server/src/scripts/mockPaperTrade.ts
/**
 * Paper Trading Validator - MOCK MODE
 * Tests quote engine with simulated market data
 * Logs comparisons to CSV for Excel analysis
 * 
 * Usage:
 *   npx ts-node src/scripts/mockPaperTrade.ts [duration_minutes]
 */

import { PrismaClient } from "@prisma/client";
import { quoteEngine } from "../quoteEngine";
import { createWriteStream } from "fs";
import { mkdirSync } from "fs";

interface Comparison {
  timestamp: number;
  instrument: string;
  strike: number;
  optionType: "C" | "P";
  
  // Simulated "market" (slightly offset from your quotes)
  sim_market_bid: number;
  sim_market_ask: number;
  sim_market_mid: number;
  sim_market_spread: number;
  
  // Your quotes
  your_bid: number;
  your_ask: number;
  your_mid: number;
  your_spread: number;
  
  // Comparison metrics
  edge_vs_mid: number;
  inside_spread_pct: number;
  would_buy: boolean;
  would_sell: boolean;
  competitive: boolean;
}

class MockPaperTradeValidator {
  private prisma: PrismaClient;
  private csvStream: any;
  private startTime: number;
  private durationMs: number;
  private quoteCount: number = 0;

  constructor(durationMinutes: number = 10) {
    this.prisma = new PrismaClient();
    this.startTime = Date.now();
    this.durationMs = durationMinutes * 60 * 1000;
    
    mkdirSync("data", { recursive: true });
    
    const filename = `data/mock_paper_trade_${Date.now()}.csv`;
    this.csvStream = createWriteStream(filename);
    
    this.csvStream.write(
      "timestamp,instrument,strike,type," +
      "sim_mkt_bid,sim_mkt_ask,sim_mkt_mid,sim_mkt_spread," +
      "your_bid,your_ask,your_mid,your_spread," +
      "edge_vs_mid,inside_spread_pct,would_buy,would_sell,competitive\n"
    );
    
    console.log(`📝 Logging to: ${filename}`);
  }

  async initialize() {
    console.log("🚀 Starting MOCK paper trade validation...");
    console.log(`⏱️  Duration: ${this.durationMs / 60000} minutes`);
    console.log(`📊 Mode: MOCK (simulated market data)\n`);
    
    await this.prisma.$connect();
  }

  async runValidation() {
    console.log("🏃 Starting validation loop (every 5 seconds)...\n");

    // Test strikes around the money
    const strikes = [90000, 95000, 100000, 105000, 110000];
    const expiryMs = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days out

    const intervalId = setInterval(async () => {
      try {
        await this.generateAndCompareQuotes(strikes, expiryMs);
      } catch (err) {
        console.error("Error in validation loop:", err);
      }

      if (Date.now() - this.startTime >= this.durationMs) {
        console.log("\n⏰ Duration complete. Stopping validation.");
        clearInterval(intervalId);
        await this.shutdown();
      }
    }, 5000);
  }

  private async generateAndCompareQuotes(strikes: number[], expiryMs: number) {
    const timestamp = Date.now();
    const comparisons: Comparison[] = [];

    for (const strike of strikes) {
      for (const optionType of ["C", "P"] as const) {
        try {
          // Get YOUR quote
          const yourQuote = quoteEngine.getQuote({
            symbol: "BTC",
            strike,
            expiryMs,
            optionType
          });

          // Simulate "market" data
          // Market is typically wider than your quote (you have edge)
          // Add some randomness to simulate market movement
          const noise = (Math.random() - 0.5) * 0.1;
          const simMarketMid = yourQuote.mid * (1 + noise);
          const simMarketSpread = yourQuote.spread * 1.5; // Market is 50% wider
          const simMarketBid = simMarketMid - simMarketSpread / 2;
          const simMarketAsk = simMarketMid + simMarketSpread / 2;

          // Calculate metrics
          const edgeVsMid = yourQuote.mid - simMarketMid;
          
          const insideSpreadPct = simMarketSpread > 0
            ? Math.max(0, Math.min(100, 
                ((Math.min(yourQuote.ask, simMarketAsk) - Math.max(yourQuote.bid, simMarketBid)) 
                / simMarketSpread) * 100
              ))
            : 0;

          const wouldBuy = yourQuote.bid >= simMarketAsk;
          const wouldSell = yourQuote.ask <= simMarketBid;
          const competitive = insideSpreadPct > 20;

          const comparison: Comparison = {
            timestamp,
            instrument: `BTC-MOCK-${strike}-${optionType}`,
            strike,
            optionType,
            sim_market_bid: simMarketBid,
            sim_market_ask: simMarketAsk,
            sim_market_mid: simMarketMid,
            sim_market_spread: simMarketSpread,
            your_bid: yourQuote.bid,
            your_ask: yourQuote.ask,
            your_mid: yourQuote.mid,
            your_spread: yourQuote.spread,
            edge_vs_mid: edgeVsMid,
            inside_spread_pct: insideSpreadPct,
            would_buy: wouldBuy,
            would_sell: wouldSell,
            competitive
          };

          comparisons.push(comparison);
          this.logToCSV(comparison);

        } catch (err) {
          console.error(`Error quoting ${strike}${optionType}:`, err);
        }
      }
    }

    this.quoteCount++;
    
    if (this.quoteCount % 6 === 0) {
      this.printSummary(comparisons);
    }
  }

  private logToCSV(c: Comparison) {
    this.csvStream.write(
      `${c.timestamp},${c.instrument},${c.strike},${c.optionType},` +
      `${c.sim_market_bid},${c.sim_market_ask},${c.sim_market_mid},${c.sim_market_spread},` +
      `${c.your_bid},${c.your_ask},${c.your_mid},${c.your_spread},` +
      `${c.edge_vs_mid},${c.inside_spread_pct},${c.would_buy ? 1 : 0},${c.would_sell ? 1 : 0},${c.competitive ? 1 : 0}\n`
    );
  }

  private printSummary(comparisons: Comparison[]) {
    if (comparisons.length === 0) return;

    const avgEdge = comparisons.reduce((sum, c) => sum + c.edge_vs_mid, 0) / comparisons.length;
    const avgInsideSpread = comparisons.reduce((sum, c) => sum + c.inside_spread_pct, 0) / comparisons.length;
    const buyCount = comparisons.filter(c => c.would_buy).length;
    const sellCount = comparisons.filter(c => c.would_sell).length;
    const competitiveCount = comparisons.filter(c => c.competitive).length;

    console.log(`📝 Logged ${this.quoteCount * comparisons.length} quotes...`);
    console.log(`   Edge vs mid: ${avgEdge > 0 ? '+' : ''}${avgEdge.toFixed(6)} BTC ${avgEdge > 0 ? '✅' : '❌'}`);
    console.log(`   Inside spread: ${avgInsideSpread.toFixed(1)}% (target: 20-40%)`);
    console.log(`   Would buy: ${buyCount}/${comparisons.length} (${(buyCount/comparisons.length*100).toFixed(1)}%)`);
    console.log(`   Would sell: ${sellCount}/${comparisons.length} (${(sellCount/comparisons.length*100).toFixed(1)}%)`);
    console.log(`   Competitive: ${competitiveCount}/${comparisons.length} (${(competitiveCount/comparisons.length*100).toFixed(1)}%)`);
    console.log();
  }

  private async shutdown() {
    console.log("🛑 Shutting down...");
    this.csvStream.end();
    await this.prisma.$disconnect();
    console.log("✅ Validation complete. Check the CSV file for analysis.");
    console.log("\n📊 Next Steps:");
    console.log("1. Open the CSV in Excel");
    console.log("2. Create pivot table: AVG(edge_vs_mid), AVG(inside_spread_pct)");
    console.log("3. Chart: edge_vs_mid over time");
    console.log("4. If edge is positive → tune parameters and test more");
    console.log("5. If edge is negative → adjust gamma/lambda in config\n");
    process.exit(0);
  }
}

async function main() {
  const durationMinutes = parseInt(process.argv[2] || "10", 10);
  
  const validator = new MockPaperTradeValidator(durationMinutes);
  
  try {
    await validator.initialize();
    await validator.runValidation();
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}