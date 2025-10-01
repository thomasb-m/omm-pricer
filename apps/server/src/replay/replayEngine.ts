// apps/server/src/replay/replayEngine.ts

import { MarketSnapshot, OptionSnapshot } from "./marketRecorder";
import { quoteEngine } from "../quoteEngine";
import { timeToExpiryYears } from "../utils/time";

export interface Trade {
  timestamp: number;
  strike: number;
  expiry: string;
  side: "BUY" | "SELL";
  size: number;
  ourPrice: number;
  marketBid: number;
  marketAsk: number;
  marketMid: number;
  edge: number;
  inventory: number;
}

export interface ReplayStats {
  trades: Trade[];
  totalEdge: number;
  totalVolume: number;
  avgEdge: number;
  winRate: number;
  maxInventory: number;
  finalInventory: number;
}

export class ReplayEngine {
  private snapshots: MarketSnapshot[] = [];
  private currentIndex: number = 0;
  private trades: Trade[] = [];
  private currentInventory: number = 0;

  async loadSnapshots(snapshots: MarketSnapshot[]): Promise<void> {
    this.snapshots = snapshots;
    this.currentIndex = 0;
    console.log(`Loaded ${snapshots.length} snapshots for replay`);
  }

  getCurrentSnapshot(): MarketSnapshot | null {
    return this.snapshots[this.currentIndex] || null;
  }

  getCurrentTime(): number {
    const snap = this.getCurrentSnapshot();
    return snap ? snap.timestamp : 0;
  }

  hasNext(): boolean {
    return this.currentIndex < this.snapshots.length - 1;
  }

  step(): void {
    if (this.hasNext()) {
      this.currentIndex++;
      const snapshot = this.snapshots[this.currentIndex];
      // Keep the engine's forward synced with snapshot
      quoteEngine.updateForward("BTC", snapshot.forward);
    }
  }

  // Find option in current snapshot
  private findOption(strike: number, expiry: string): OptionSnapshot | null {
    const snapshot = this.getCurrentSnapshot();
    if (!snapshot) return null;
    return (
      snapshot.options.find((o) => o.strike === strike && o.expiry === expiry) ||
      null
    );
  }

  // Parse "28JUN24" -> absolute expiry (ms since epoch)
  private parseExpiryMs(expiryStr: string): number {
    const day = parseInt(expiryStr.slice(0, 2), 10);
    const monthMap: Record<string, number> = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };
    const month = monthMap[expiryStr.slice(2, 5)];
    const year = 2000 + parseInt(expiryStr.slice(5, 7), 10);
    // 08:00 local like before
    const d = new Date(year, month, day, 8, 0, 0);
    return d.getTime();
  }

  // If you want T (years) for diagnostics
  private timeToExpiryYearsFromStr(expiryStr: string, nowMs: number): number {
    const expiryMs = this.parseExpiryMs(expiryStr);
    return Math.max(0.001, timeToExpiryYears(expiryMs, nowMs));
  }

  private inferOptionType(opt: OptionSnapshot): "C" | "P" {
    if ((opt as any).optionType === "C" || (opt as any).optionType === "P") {
      return (opt as any).optionType;
    }
    const name = (opt as any).instrument || "";
    return name.includes("-C") ? "C" : "P";
  }

  // Simulate a trade at current market
  simulateTrade(
    strike: number,
    expiry: string,
    side: "BUY" | "SELL",
    size: number
  ): Trade | null {
    const snapshot = this.getCurrentSnapshot();
    if (!snapshot) return null;

    const option = this.findOption(strike, expiry);
    if (!option) return null;

    // Skip if market is too illiquid
    if (option.bid === 0 || option.ask === 0) return null;
    if (option.ask - option.bid > option.markPrice * 0.5) return null; // Spread > 50%

    const expiryMs = this.parseExpiryMs(expiry);
    const optionType = this.inferOptionType(option);

    // Use market IV for calibration if present (decimal)
    const marketIV = option.markIv > 0 ? option.markIv / 100 : undefined;

    // Ask engine for a quote (forward is maintained inside quoteEngine)
    const quote = quoteEngine.getQuote({
      symbol: "BTC",
      strike,
      expiryMs,
      optionType,
      side,
      size,
      marketIV,
    });

    // Simulate fill at our quote
    const ourPrice = side === "BUY" ? quote.ask : quote.bid;
    const marketMid = (option.bid + option.ask) / 2;

    // Edge (positive = we made money vs mid)
    const edge =
      side === "SELL"
        ? (ourPrice - marketMid) * size
        : (marketMid - ourPrice) * size;

    // Inventory update (customer BUY => we SELL)
    const inventoryChange = side === "BUY" ? -size : size;
    this.currentInventory += inventoryChange;

    const trade: Trade = {
      timestamp: snapshot.timestamp,
      strike,
      expiry,
      side,
      size,
      ourPrice,
      marketBid: option.bid,
      marketAsk: option.ask,
      marketMid,
      edge,
      inventory: this.currentInventory,
    };

    this.trades.push(trade);

    // Inform the engine (will update inventory/PC)
    quoteEngine.executeTrade({
      symbol: "BTC",
      strike,
      side,
      size,
      price: ourPrice,
      timestamp: snapshot.timestamp,
      expiryMs,
      optionType,
    } as any);

    return trade;
  }

  getStats(): ReplayStats {
    const totalEdge = this.trades.reduce((sum, t) => sum + t.edge, 0);
    const totalVolume = this.trades.reduce((sum, t) => sum + t.size, 0);
    const avgEdge = totalVolume > 0 ? totalEdge / totalVolume : 0;
    const winningTrades = this.trades.filter((t) => t.edge > 0).length;
    const winRate = this.trades.length > 0 ? winningTrades / this.trades.length : 0;
    const maxInventory = Math.max(...this.trades.map((t) => Math.abs(t.inventory)), 0);

    return {
      trades: this.trades,
      totalEdge,
      totalVolume,
      avgEdge,
      winRate,
      maxInventory,
      finalInventory: this.currentInventory,
    };
  }

  reset(): void {
    this.currentIndex = 0;
    this.trades = [];
    this.currentInventory = 0;
  }

  // Get all available strikes for current snapshot
  getAvailableStrikes(minVolume: number = 0): number[] {
    const snapshot = this.getCurrentSnapshot();
    if (!snapshot) return [];
    return Array.from(
      new Set(snapshot.options.filter((o) => o.volume24h >= minVolume).map((o) => o.strike))
    ).sort((a, b) => a - b);
  }
}
