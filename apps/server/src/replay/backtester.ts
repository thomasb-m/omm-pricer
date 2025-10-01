// apps/server/src/replay/backtester.ts

import { ReplayEngine, ReplayStats } from "./replayEngine";
import { MarketRecorder, MarketSnapshot } from "./marketRecorder";
import { PrismaClient } from "@prisma/client";

export interface TradeSignal {
  strike: number;
  expiry: string;
  side: "BUY" | "SELL";
  size: number;
}

export interface BacktestStrategy {
  name: string;
  onSnapshot(snapshot: MarketSnapshot, replayEngine: ReplayEngine): TradeSignal[];
}

export interface BacktestResult {
  strategy: string;
  startTime: number;
  endTime: number;
  duration: number;
  stats: ReplayStats;
  snapshotCount: number;
}

export class Backtester {
  private replayEngine: ReplayEngine;
  private recorder: MarketRecorder;

  constructor(prisma: PrismaClient) {
    this.replayEngine = new ReplayEngine();
    this.recorder = new MarketRecorder(prisma);
  }

  async runBacktest(
    strategy: BacktestStrategy,
    symbol: string,
    startTime: number,
    endTime: number
  ): Promise<BacktestResult> {
    console.log(`\n=== Starting Backtest: ${strategy.name} ===`);
    console.log(`Period: ${new Date(startTime)} to ${new Date(endTime)}`);

    const snapshots = await this.recorder.loadSnapshots(symbol, startTime, endTime);
    
    if (snapshots.length === 0) {
      throw new Error("No snapshots found for the specified period");
    }

    console.log(`Loaded ${snapshots.length} snapshots`);

    await this.replayEngine.loadSnapshots(snapshots);
    this.replayEngine.reset();

    let snapshotCount = 0;
    let tradeCount = 0;

    while (this.replayEngine.hasNext()) {
      const snapshot = this.replayEngine.getCurrentSnapshot();
      if (!snapshot) break;

      snapshotCount++;

      const signals = strategy.onSnapshot(snapshot, this.replayEngine);

      for (const signal of signals) {
        const trade = this.replayEngine.simulateTrade(
          signal.strike,
          signal.expiry,
          signal.side,
          signal.size
        );
        if (trade) {
          tradeCount++;
          console.log(
            `[${new Date(trade.timestamp).toISOString()}] ${trade.side} ${
              trade.size
            }x ${trade.strike} @ ${trade.ourPrice.toFixed(2)} (edge: ${trade.edge.toFixed(
              2
            )})`
          );
        }
      }

      this.replayEngine.step();
    }

    const stats = this.replayEngine.getStats();

    console.log(`\n=== Backtest Complete ===`);
    console.log(`Snapshots processed: ${snapshotCount}`);
    console.log(`Trades executed: ${tradeCount}`);
    console.log(`Total edge captured: ${stats.totalEdge.toFixed(2)}`);
    console.log(`Average edge per contract: ${stats.avgEdge.toFixed(2)}`);
    console.log(`Win rate: ${(stats.winRate * 100).toFixed(1)}%`);
    console.log(`Max inventory: ${stats.maxInventory}`);
    console.log(`Final inventory: ${stats.finalInventory}`);

    return {
      strategy: strategy.name,
      startTime,
      endTime,
      duration: endTime - startTime,
      stats,
      snapshotCount,
    };
  }
}

// Aggressive Passive MM Strategy
export class PassiveMMStrategy implements BacktestStrategy {
  name = "Passive Market Making";

  constructor(
    private atmRange: number = 2000,     // Wider range
    private minSpread: number = 20,      // Lower threshold (was 100)
    private maxSize: number = 5          // Smaller size
  ) {}

  onSnapshot(snapshot: MarketSnapshot, engine: ReplayEngine): TradeSignal[] {
    const signals: TradeSignal[] = [];

    for (const option of snapshot.options) {
      const isATM = Math.abs(option.strike - snapshot.forward) < this.atmRange;
      const spread = option.ask - option.bid;
      const hasWideSpread = spread > this.minSpread;

      if (isATM && hasWideSpread && option.bid > 0 && option.ask > 0) {
        // Sell on wide spreads
        signals.push({
          strike: option.strike,
          expiry: option.expiry,
          side: "SELL",
          size: this.maxSize,
        });
      }
    }

    return signals;
  }
}

// Inventory-Aware Strategy
export class InventoryAwareStrategy implements BacktestStrategy {
  name = "Inventory-Aware MM";

  constructor(
    private maxInventory: number = 30,   // Lower limit
    private atmRange: number = 2000      // Wider range
  ) {}

  onSnapshot(snapshot: MarketSnapshot, engine: ReplayEngine): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const stats = engine.getStats();
    const currentInventory = stats.finalInventory;

    // Don't trade if inventory is too large
    if (Math.abs(currentInventory) > this.maxInventory) {
      return signals;
    }

    for (const option of snapshot.options) {
      const isATM = Math.abs(option.strike - snapshot.forward) < this.atmRange;
      
      if (!isATM || option.bid === 0 || option.ask === 0) continue;

      const spread = option.ask - option.bid;
      
      // Trade if spread is reasonable (>$20)
      if (spread < 20) continue;
      
      // If long inventory, prefer selling
      if (currentInventory > 5 && spread > 20) {
        signals.push({
          strike: option.strike,
          expiry: option.expiry,
          side: "SELL",
          size: 3,
        });
      }
      
      // If short inventory, prefer buying
      if (currentInventory < -5 && spread > 20) {
        signals.push({
          strike: option.strike,
          expiry: option.expiry,
          side: "BUY",
          size: 3,
        });
      }
      
      // If flat, sell to start building edge
      if (Math.abs(currentInventory) <= 5 && spread > 30) {
        signals.push({
          strike: option.strike,
          expiry: option.expiry,
          side: "SELL",
          size: 2,
        });
      }
    }

    return signals;
  }
}