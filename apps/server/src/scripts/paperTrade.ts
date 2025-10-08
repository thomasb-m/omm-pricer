// apps/server/src/scripts/paperTrade.ts
/**
 * Paper Trading Validator
 * Compares your quotes against live Deribit market
 * Logs to CSV for Excel analysis
 * 
 * Usage:
 *   npx ts-node src/scripts/paperTrade.ts [duration_minutes]
 *   npx ts-node src/scripts/paperTrade.ts 10  # Run for 10 minutes
 */

import { PrismaClient } from "@prisma/client";
import { DeribitWS } from "../deribit";
import { quoteEngine, initializeWithMarketData } from "../quoteEngine";
import { createWriteStream } from "fs";
import { mkdirSync } from "fs";

interface MarketSnapshot {
  instrument: string;
  strike: number;
  optionType: "C" | "P";
  expiryMs: number;
  marketBid: number;
  marketAsk: number;
  marketMid: number;
  marketSpread: number;
  marketIV: number;
}

interface Comparison {
  timestamp: number;
  instrument: string;
  strike: number;
  optionType: "C" | "P";
  
  // Market data
  mkt_bid: number;
  mkt_ask: number;
  mkt_mid: number;
  mkt_spread: number;
  mkt_iv: number;
  
  // Your quotes
  your_bid: number;
  your_ask: number;
  your_mid: number;
  your_spread: number;
  
  // Comparison metrics
  edge_vs_mid: number;        // your_mid - mkt_mid (positive = you're higher)
  inside_spread: number;      // 0-100% how much you're inside their spread
  would_buy: boolean;         // your_bid >= mkt_ask
  would_sell: boolean;        // your_ask <= mkt_bid
  competitive: boolean;       // inside_spread > 20%
}

class PaperTradeValidator {
  private prisma: PrismaClient;
  private ws: DeribitWS;
  private csvStream: any;
  private startTime: number;
  private durationMs: number;
  private quoteCount: number = 0;
  private instruments: string[] = [];
  private latestMarket = new Map<string, MarketSnapshot>();

  constructor(durationMinutes: number = 60) {
    this.prisma = new PrismaClient();
    this.ws = new DeribitWS(process.env.DERIBIT_NETWORK || "test");
    this.startTime = Date.now();
    this.durationMs = durationMinutes * 60 * 1000;
    
    // Ensure data directory exists
    try {
      mkdirSync("data", { recursive: true });
    } catch {}
    
    // Setup CSV logging
    const filename = `data/paper_trade_${Date.now()}.csv`;
    this.csvStream = createWriteStream(filename);
    
    // Write CSV header
    this.csvStream.write(
      "timestamp,instrument,strike,type," +
      "mkt_bid,mkt_ask,mkt_mid,mkt_spread,mkt_iv," +
      "your_bid,your_ask,your_mid,your_spread," +
      "edge_vs_mid,inside_spread,would_buy,would_sell,competitive\n"
    );
    
    console.log(`📝 Logging to: ${filename}`);
  }

  async initialize() {
    console.log("🚀 Starting paper trade validation...");
    console.log(`⏱️  Duration: ${this.durationMs / 60000} minutes`);
    
    // Initialize quote engine with market data
    await initializeWithMarketData(this.prisma);
    
    // Get current spot price
    const btcIndex = await this.prisma.btcIndex.findFirst({
      orderBy: { timestamp: "desc" }
    });
    
    if (!btcIndex) {
      throw new Error("No BTC index data available. Run ingest first.");
    }
    
    const spot = btcIndex.price;
    console.log(`📊 Current BTC spot: $${spot.toLocaleString()}`);
    
    // Select liquid instruments to track
    await this.selectInstruments(spot);
    
    // Subscribe to market data
    await this.subscribeToMarket();
  }

  private async selectInstruments(spot: number) {
    // Get instruments from database (populated by ingest)
    const allInstruments = await this.prisma.instrument.findMany({
      where: {
        instrument: { contains: "BTC" }
      },
      orderBy: { strike: "asc" }
    });

    if (allInstruments.length === 0) {
      throw new Error("No instruments in database. Run ingest first.");
    }

    // Find near-term expiry
    const now = Date.now();
    const expiryMap = new Map<number, any[]>();
    
    for (const ins of allInstruments) {
      const exp = ins.expirationTimestamp;
      if (!expiryMap.has(exp)) expiryMap.set(exp, []);
      expiryMap.get(exp)!.push(ins);
    }

    // Get expiry 5-10 days out
    const sortedExpiries = Array.from(expiryMap.keys()).sort((a, b) => a - b);
    const targetExpiry = sortedExpiries.find(exp => {
      const days = (exp - now) / (1000 * 60 * 60 * 24);
      return days >= 5 && days <= 15;
    }) || sortedExpiries[0];

    const expiryInstruments = expiryMap.get(targetExpiry)!;

    // Select 5-10 strikes around ATM (±10%)
    const lowerBound = spot * 0.90;
    const upperBound = spot * 1.10;
    
    const selected = expiryInstruments
      .filter(ins => ins.strike >= lowerBound && ins.strike <= upperBound)
      .slice(0, 10);

    this.instruments = selected.map(ins => ins.instrument);
    
    console.log(`✅ Selected ${this.instruments.length} instruments:`);
    this.instruments.forEach(ins => console.log(`   - ${ins}`));
  }

  private async subscribeToMarket() {
    console.log("🔌 Connecting to Deribit WebSocket...");
    
    await this.ws.connect();
    
    // Subscribe to ticker updates for selected instruments
    const channels = this.instruments.map(ins => `ticker.${ins}.100ms`);
    await this.ws.subscribe(channels);
    
    // Handle ticker messages
    this.ws.on("ticker", (data: any) => {
      this.handleTickerUpdate(data);
    });
    
    console.log("✅ Subscribed to market data");
  }

  private handleTickerUpdate(ticker: any) {
    const instrument = ticker.instrument_name;
    if (!this.instruments.includes(instrument)) return;

    // Parse instrument name (e.g., "BTC-25OCT24-100000-C")
    const parts = instrument.split("-");
    const strike = parseFloat(parts[2]);
    const optionType = parts[3] as "C" | "P";

    // Store latest market snapshot
    this.latestMarket.set(instrument, {
      instrument,
      strike,
      optionType,
      expiryMs: ticker.expiration_timestamp || 0,
      marketBid: ticker.best_bid_price || 0,
      marketAsk: ticker.best_ask_price || 0,
      marketMid: ticker.mark_price || (ticker.best_bid_price + ticker.best_ask_price) / 2,
      marketSpread: (ticker.best_ask_price || 0) - (ticker.best_bid_price || 0),
      marketIV: ticker.mark_iv || 0.30
    });
  }

  async runValidation() {
    console.log("🏃 Starting validation loop (every 5 seconds)...\n");

    const intervalId = setInterval(async () => {
      try {
        await this.generateAndCompareQuotes();
      } catch (err) {
        console.error("Error in validation loop:", err);
      }

      // Check if duration exceeded
      if (Date.now() - this.startTime >= this.durationMs) {
        console.log("\n⏰ Duration complete. Stopping validation.");
        clearInterval(intervalId);
        await this.shutdown();
      }
    }, 5000); // Every 5 seconds
  }

  private async generateAndCompareQuotes() {
    const timestamp = Date.now();
    const comparisons: Comparison[] = [];

    for (const instrument of this.instruments) {
      const market = this.latestMarket.get(instrument);
      if (!market) continue;

      try {
        // Generate YOUR quote using the quote engine
        const yourQuote = quoteEngine.getQuote({
          symbol: "BTC",
          strike: market.strike,
          expiryMs: market.expiryMs,
          optionType: market.optionType,
          marketIV: market.marketIV
        });

        // Calculate comparison metrics
        const edgeVsMid = yourQuote.mid - market.marketMid;
        
        // Inside spread %: How much of their spread you're capturing
        const insideSpread = market.marketSpread > 0
          ? Math.max(0, Math.min(100, 
              ((Math.min(yourQuote.ask, market.marketAsk) - Math.max(yourQuote.bid, market.marketBid)) 
              / market.marketSpread) * 100
            ))
          : 0;

        const wouldBuy = yourQuote.bid >= market.marketAsk;
        const wouldSell = yourQuote.ask <= market.marketBid;
        const competitive = insideSpread > 20;

        const comparison: Comparison = {
          timestamp,
          instrument,
          strike: market.strike,
          optionType: market.optionType,
          mkt_bid: market.marketBid,
          mkt_ask: market.marketAsk,
          mkt_mid: market.marketMid,
          mkt_spread: market.marketSpread,
          mkt_iv: market.marketIV,
          your_bid: yourQuote.bid,
          your_ask: yourQuote.ask,
          your_mid: yourQuote.mid,
          your_spread: yourQuote.ask - yourQuote.bid,
          edge_vs_mid: edgeVsMid,
          inside_spread: insideSpread,
          would_buy: wouldBuy,
          would_sell: wouldSell,
          competitive
        };

        comparisons.push(comparison);
        this.logToCSV(comparison);

      } catch (err) {
        console.error(`Error quoting ${instrument}:`, err);
      }
    }

    this.quoteCount++;
    
    // Print summary every 10 iterations (50 seconds)
    if (this.quoteCount % 10 === 0) {
      this.printSummary(comparisons);
    }
  }

  private logToCSV(c: Comparison) {
    this.csvStream.write(
      `${c.timestamp},${c.instrument},${c.strike},${c.optionType},` +
      `${c.mkt_bid},${c.mkt_ask},${c.mkt_mid},${c.mkt_spread},${c.mkt_iv},` +
      `${c.your_bid},${c.your_ask},${c.your_mid},${c.your_spread},` +
      `${c.edge_vs_mid},${c.inside_spread},${c.would_buy ? 1 : 0},${c.would_sell ? 1 : 0},${c.competitive ? 1 : 0}\n`
    );
  }

  private printSummary(comparisons: Comparison[]) {
    if (comparisons.length === 0) return;

    const avgEdge = comparisons.reduce((sum, c) => sum + c.edge_vs_mid, 0) / comparisons.length;
    const avgInsideSpread = comparisons.reduce((sum, c) => sum + c.inside_spread, 0) / comparisons.length;
    const buyCount = comparisons.filter(c => c.would_buy).length;
    const sellCount = comparisons.filter(c => c.would_sell).length;
    const competitiveCount = comparisons.filter(c => c.competitive).length;

    console.log(`📝 Logged ${this.quoteCount * comparisons.length} quotes...`);
    console.log(`   Edge vs mid: ${avgEdge > 0 ? '+' : ''}${avgEdge.toFixed(6)} BTC (${avgEdge > 0 ? '✅' : '❌'})`);
    console.log(`   Inside spread: ${avgInsideSpread.toFixed(1)}% (target: 20-40%)`);
    console.log(`   Would buy: ${buyCount}/${comparisons.length} (${(buyCount/comparisons.length*100).toFixed(1)}%)`);
    console.log(`   Would sell: ${sellCount}/${comparisons.length} (${(sellCount/comparisons.length*100).toFixed(1)}%)`);
    console.log(`   Competitive: ${competitiveCount}/${comparisons.length} (${(competitiveCount/comparisons.length*100).toFixed(1)}%)`);
    console.log();
  }

  private async shutdown() {
    console.log("🛑 Shutting down...");
    this.csvStream.end();
    await this.ws.disconnect();
    await this.prisma.$disconnect();
    console.log("✅ Validation complete. Check the CSV file for analysis.");
    process.exit(0);
  }
}

// Main execution
async function main() {
  const durationMinutes = parseInt(process.argv[2] || "60", 10);
  
  const validator = new PaperTradeValidator(durationMinutes);
  
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