// Create new file: apps/server/src/quoteEngine.ts

import { PrismaClient } from "@prisma/client";
import { volService } from './volModels/integration/volModelService';

export interface QuoteRequest {
  symbol: string;
  strike: number;
  expiry?: number;
  size?: number;
  side?: 'BUY' | 'SELL';
}

export interface Quote {
  symbol: string;
  strike: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  spread: number;
  forward: number;
  timestamp: number;
}

export interface Trade {
  symbol: string;
  strike: number;
  side: 'BUY' | 'SELL';  // Customer side
  size: number;
  price: number;
  timestamp: number;
}

export class QuoteEngine {
  private forwards: Map<string, number> = new Map();
  
  constructor() {
    // Initialize with default forwards
    this.forwards.set('BTC', 45000);
    this.forwards.set('ETH', 3000);
  }
  
  // Update forward price (from perpetual)
  updateForward(symbol: string, forward: number): void {
    this.forwards.set(symbol, forward);
    console.log(`Updated ${symbol} forward to ${forward}`);
  }
  
  // Get current forward
  getForward(symbol: string): number {
    return this.forwards.get(symbol) || 45000;
  }
  
  // Get a single quote
  getQuote(request: QuoteRequest): Quote {
    const { symbol, strike, expiry = 0.08, size, side } = request;
    
    // Get current forward
    const forward = this.getForward(symbol);
    
    // Get quote from vol model (passing forward as "spot")
    const modelQuote = volService.getQuote(symbol, strike, expiry);
    
    // Adjust sizes based on request
    let bidSize = modelQuote.bidSize;
    let askSize = modelQuote.askSize;
    
    if (side === 'SELL' && size) {
      bidSize = Math.min(bidSize, size);
    } else if (side === 'BUY' && size) {
      askSize = Math.min(askSize, size);
    }
    
    const mid = (modelQuote.bid + modelQuote.ask) / 2;
    
    return {
      symbol,
      strike,
      bid: modelQuote.bid,
      ask: modelQuote.ask,
      bidSize,
      askSize,
      mid,
      spread: modelQuote.ask - modelQuote.bid,
      forward,
      timestamp: Date.now()
    };
  }
  
  // Get multiple quotes (for a quote grid)
  getQuoteGrid(symbol: string, strikes: number[], expiry: number = 0.08): Quote[] {
    return strikes.map(strike => 
      this.getQuote({ symbol, strike, expiry })
    );
  }
  
  // Execute a trade
  executeTrade(trade: Trade): void {
    const { symbol, strike, side, size, price } = trade;
    
    // Update the vol model
    const result = volService.onCustomerTrade(
      symbol,
      strike,
      side,
      size,
      price
    );
    
    if (result) {
      console.log(`Trade executed: Customer ${side} ${size}x ${strike} @ ${price}`);
      
      // Show inventory after trade
      const inv = volService.getInventory(symbol);
      if (inv) {
        console.log(`${symbol} inventory: ${inv.totalVega.toFixed(1)} vega`);
      }
    }
  }
  
  // Get inventory
  getInventory(symbol: string) {
    return volService.getInventory(symbol);
  }
}

// Create instance
export const quoteEngine = new QuoteEngine();

// Initialize with market data
export async function initializeWithMarketData(prisma: PrismaClient) {
  // Get BTC perpetual (this is the forward)
  const btcPerp = await prisma.ticker.findFirst({
    where: { instrument: "BTC-PERPETUAL" },
    orderBy: { tsMs: "desc" }
  });
  
  const btcForward = btcPerp?.markPrice || btcPerp?.lastPrice || 45000;
  
  console.log(`Initializing BTC with forward: ${btcForward}`);
  quoteEngine.updateForward('BTC', btcForward);
  
  // Update the vol model's "spot" (which is really forward)
  volService.updateSpot('BTC', btcForward);
  
  return btcForward;
}