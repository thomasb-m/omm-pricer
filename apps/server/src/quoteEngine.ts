// apps/server/src/quoteEngine.ts
import { PrismaClient } from "@prisma/client";
import { volService } from "./volModels/integration/volModelService";

export interface QuoteRequest {
  symbol: string;
  strike: number;
  expiryMs: number;                 // absolute ms
  optionType: "C" | "P";
  size?: number;
  side?: "BUY" | "SELL";
  marketIV?: number;                // ATM IV (decimal) to calibrate
}

export interface Quote {
  symbol: string;
  strike: number;
  expiryMs: number;
  optionType: "C" | "P";
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  spread: number;
  edge: number;
  forward: number;
  timestamp: number;
  pcMid?: number;                   // pricing curve mid (λ·g applied)
  ccMid?: number;                   // core curve mid (fair)
  bucket?: string;                  // quote bucket (atm/wings/etc)
}

export interface Trade {
  symbol: string;
  strike: number;
  expiryMs: number;
  optionType: "C" | "P";
  side: "BUY" | "SELL";             // CUSTOMER side
  size: number;
  price: number;
  timestamp: number;
  marketIV?: number; 
}

export class QuoteEngine {
  private forwards: Map<string, number> = new Map();

  constructor() {
    // sensible defaults; will be overwritten at init
    this.forwards.set("BTC", 100000);
    this.forwards.set("ETH", 3000);
  }

  updateForward(symbol: string, forward: number): void {
    this.forwards.set(symbol, forward);
    // keep vol service in sync
    volService.updateSpot(symbol, forward);
    console.log(`Updated ${symbol} forward to ${forward}`);
  }

  getForward(symbol: string): number {
    return this.forwards.get(symbol) ?? 100000;
  }

  calibrateExpiry(
    symbol: string,
    expiryMs: number,
    marketQuotes: Array<{ strike: number; iv: number; weight?: number }>,
    forward: number
  ): void {
    // Delegate to volService
    const volService = require('./volModels/integration/volModelService').volService;
    volService.calibrateExpiry(symbol, expiryMs, marketQuotes, forward);
    console.log(`[QuoteEngine] Calibrated ${symbol} expiry ${new Date(expiryMs).toISOString().split('T')[0]} with ${marketQuotes.length} market quotes`);
  }

  getQuote(req: QuoteRequest): Quote {
    const forward = this.getForward(req.symbol);

    // Delegate to volService — this is where the single-calculus runs.
    // Ensure volService.getQuoteWithIV applies computePcQuote internally
    // and returns pcMid/ccMid/bucket in addition to the usual fields.
    const q = volService.getQuoteWithIV(
      req.symbol, 
      req.strike, 
      req.expiryMs, 
      req.marketIV,     // ← 4th argument
      req.optionType    // ← 5th argument
    );

    // Optional size clamp by requested side/size
    let bidSize = q.bidSize;
    let askSize = q.askSize;
    if (req.side === "SELL" && req.size) bidSize = Math.min(bidSize, req.size);
    if (req.side === "BUY"  && req.size) askSize = Math.min(askSize, req.size);

    // Optional lightweight debug: comment out in prod
    // if (q.pcMid !== undefined && q.ccMid !== undefined) {
    //   console.log(
    //     `[${req.symbol}] ${req.optionType} ${req.strike} ${new Date(req.expiryMs).toISOString()} ` +
    //     `ccMid=${q.ccMid.toFixed(4)} pcMid=${q.pcMid.toFixed(4)} bid=${q.bid.toFixed(4)} ask=${q.ask.toFixed(4)}`
    //   );
    // }

    return {
      symbol: req.symbol,
      strike: req.strike,
      expiryMs: req.expiryMs,
      optionType: req.optionType,
      bid: q.bid,
      ask: q.ask,
      bidSize,
      askSize,
      mid: q.mid,
      spread: q.spread,
      edge: (q.pcMid ?? q.mid) - (q.ccMid ?? q.mid),
      forward,
      timestamp: Date.now(),
      pcMid: q.pcMid,   // passthrough from volService (pricing curve mid)
      ccMid: q.ccMid,   // passthrough from volService (core curve mid)
      bucket: q.bucket  // passthrough from volService
    };
  }

  getQuoteGrid(
    symbol: string,
    strikes: number[],
    expiryMs: number,
    optionType: "C" | "P" = "C"
  ): Quote[] {
    return strikes.map((strike) =>
      this.getQuote({ symbol, strike, expiryMs, optionType })
    );
  }

  executeTrade(trade: Trade): void {
    // Extract marketIV from trade (it's optional)
    const marketIV = trade.marketIV;  // ← Add this line
    
    // Route trade into the model (customer side; service handles signs/inventory)
    volService.onCustomerTrade(
      trade.symbol,
      trade.strike,
      trade.side,
      trade.size,
      trade.price,
      trade.expiryMs,
      trade.optionType,
      trade.timestamp,
      marketIV  // ← Now this variable exists
    );
  
    console.log(
      `Trade executed: Customer ${trade.side} ${trade.size}x ${trade.symbol} ` +
      `${trade.optionType} ${trade.strike} @ ${trade.price}` +
      (marketIV ? ` (IV=${(marketIV*100).toFixed(1)}%)` : '')
    );
  
    const inv = volService.getInventory(trade.symbol);
    if (inv && typeof inv.totalVega === "number") {
      console.log(`${trade.symbol} inventory: ${inv.totalVega.toFixed(1)} vega`);
    }
  }

  getInventory(symbol: string) {
    return volService.getInventory(symbol);
  }

  getFactorInventory(symbol: string) {
    return volService.getFactorInventory(symbol);
  }

  resetAllState(): void {
    volService.clearInventory("BTC");
    volService.clearInventory("ETH");
    // Force the model to reset surfaces
    const btcModel = (volService as any).symbols?.get?.("BTC")?.model;
    const ethModel = (volService as any).symbols?.get?.("ETH")?.model;
    if (btcModel?.resetAllState) btcModel.resetAllState();
    if (ethModel?.resetAllState) ethModel.resetAllState();
  }
}

export const quoteEngine = new QuoteEngine();

export async function initializeWithMarketData(prisma: PrismaClient) {
  const btcPerp = await prisma.ticker.findFirst({
    where: { instrument: "BTC-PERPETUAL" },
    orderBy: { tsMs: "desc" }
  });

  const btcForward =
    btcPerp?.markPrice ?? 100000;

  console.log(`Initializing BTC with forward: ${btcForward}`);
  quoteEngine.updateForward("BTC", btcForward);
  return btcForward;
}
