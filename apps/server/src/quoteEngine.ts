// apps/server/src/quoteEngine.ts
import { PrismaClient } from "@prisma/client";
import { volService } from './volModels/integration/volModelService';

export interface QuoteRequest {
  symbol: string;
  strike: number;
  expiryMs: number;                 // absolute ms
  optionType: 'C' | 'P';
  size?: number;
  side?: 'BUY' | 'SELL';
  marketIV?: number;                // ATM IV (decimal) to calibrate
}

export interface Quote {
  symbol: string;
  strike: number;
  expiryMs: number;
  optionType: 'C'|'P';
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  spread: number;
  edge: number;
  forward: number;
  timestamp: number;
  pcMid?: number;
  ccMid?: number;
  bucket?: string;
}

export interface Trade {
  symbol: string;
  strike: number;
  expiryMs: number;
  optionType: 'C'|'P';
  side: 'BUY' | 'SELL';             // CUSTOMER side
  size: number;
  price: number;
  timestamp: number;
}

export class QuoteEngine {
  private forwards: Map<string, number> = new Map();

  constructor() {
    this.forwards.set('BTC', 45000);
    this.forwards.set('ETH', 3000);
  }

  updateForward(symbol: string, forward: number): void {
    this.forwards.set(symbol, forward);
    // keep vol service in sync
    volService.updateSpot(symbol, forward);
    console.log(`Updated ${symbol} forward to ${forward}`);
  }

  getForward(symbol: string): number {
    return this.forwards.get(symbol) || 45000;
  }

  getQuote(req: QuoteRequest): Quote {
    const forward = this.getForward(req.symbol);

    // NEW: drive the IntegratedSmileModel via volService
    const q = volService.getQuoteWithIV(
      req.symbol,
      req.expiryMs,
      req.strike,
      req.optionType,
      req.marketIV
    );

    // size clamp (optional)
    let bidSize = q.bidSize;
    let askSize = q.askSize;
    if (req.side === 'SELL' && req.size) bidSize = Math.min(bidSize, req.size);
    if (req.side === 'BUY'  && req.size) askSize = Math.min(askSize, req.size);

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
      edge: q.edge,
      forward,
      timestamp: Date.now(),
      pcMid: q.pcMid,     // 👈
      ccMid: q.ccMid,     // 👈
      bucket: q.bucket   // 👈
    };
  }

  getQuoteGrid(symbol: string, strikes: number[], expiryMs: number, optionType: 'C'|'P' = 'C'): Quote[] {
    return strikes.map(strike =>
      this.getQuote({ symbol, strike, expiryMs, optionType })
    );
  }

  executeTrade(trade: Trade): void {
    const forward = this.getForward(trade.symbol);

    // ✅ route trade into the model (customer side; service handles signing)
    volService.onCustomerTrade(
      trade.symbol,
      trade.strike,
      trade.side,               // 'BUY' | 'SELL' (customer side)
      trade.size,
      trade.price,
      trade.expiryMs,
      trade.optionType,
      trade.timestamp
    );

    console.log(`Trade executed: Customer ${trade.side} ${trade.size}x ${trade.strike} @ ${trade.price}`);

    const inv = volService.getInventory(trade.symbol);
    if (inv) {
      const tv = Number(inv.totalVega ?? inv.total?.vega ?? 0);
      console.log(`${trade.symbol} inventory: ${inv.totalVega.toFixed(1)} vega`);
    }
  }

  getInventory(symbol: string) {
    return volService.getInventory(symbol);
  }
}

export const quoteEngine = new QuoteEngine();

export async function initializeWithMarketData(prisma: PrismaClient) {
  const btcPerp = await prisma.ticker.findFirst({
    where: { instrument: "BTC-PERPETUAL" },
    orderBy: { tsMs: "desc" }
  });

  const btcForward = btcPerp?.markPrice || btcPerp?.lastPrice || 45000;
  console.log(`Initializing BTC with forward: ${btcForward}`);
  quoteEngine.updateForward('BTC', btcForward);
  return btcForward;
}
