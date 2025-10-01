// apps/server/src/replay/marketRecorder.ts

import { PrismaClient } from "@prisma/client";

export interface OptionSnapshot {
  instrument: string;
  strike: number;
  expiry: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bidIv: number;
  askIv: number;
  markIv: number;
  markPrice: number;
  volume24h: number;
  openInterest: number;
  underlying: number;
}

export interface MarketSnapshot {
  timestamp: number;
  symbol: string;
  spot: number;
  forward: number;
  options: OptionSnapshot[];
}

export class MarketRecorder {
  private recording: boolean = false;
  private intervalId?: NodeJS.Timeout;

  constructor(private prisma: PrismaClient) {}

  async captureSnapshot(symbol: string = "BTC"): Promise<MarketSnapshot> {
    const perp = await this.prisma.ticker.findFirst({
      where: { instrument: `${symbol}-PERPETUAL` },
      orderBy: { tsMs: "desc" },
    });

    const index = await this.prisma.tickIndex.findFirst({
      where: { indexName: `${symbol.toLowerCase()}_usd` },
      orderBy: { tsMs: "desc" },
    });

    const rawOptions = await this.prisma.ticker.findMany({
      where: {
        instrument: { startsWith: `${symbol}-` },
        NOT: { instrument: { endsWith: "PERPETUAL" } },
      },
      orderBy: { tsMs: "desc" },
    });

    const optionMap = new Map<string, any>();
    for (const opt of rawOptions) {
      if (!optionMap.has(opt.instrument)) {
        optionMap.set(opt.instrument, opt);
      }
    }

    const forward = perp?.markPrice || 45000;
    const SCALE_FACTOR = 1;
    const DEFAULT_SIZE = 10; // CRITICAL FIX: hardcode sizes

    const options: OptionSnapshot[] = Array.from(optionMap.values()).map((opt) => {
      const parts = opt.instrument.split("-");
      
      return {
        instrument: opt.instrument,
        strike: parseInt(parts[2]) || 0,
        expiry: parts[1] || "",
        bid: (opt.bestBid || 0) * forward,
        ask: (opt.bestAsk || 0) * forward,
        // FIXED: Use default size instead of database values
        bidSize: DEFAULT_SIZE,
        askSize: DEFAULT_SIZE,
        bidIv: opt.bidIv || 0,
        askIv: opt.askIv || 0,
        markIv: opt.markIv || 0,
        markPrice: (opt.markPrice || 0) * forward,
        volume24h: parseFloat(opt.stats24h?.volume || "0"),
        openInterest: opt.openInterest || 0,
        underlying: forward,
      };
    });

    return {
      timestamp: Date.now(),
      symbol,
      spot: index?.price || 0,
      forward: perp?.markPrice || 0,
      options: options.filter((o) => o.strike > 0),
    };
  }

  async saveSnapshot(snapshot: MarketSnapshot): Promise<void> {
    await this.prisma.marketSnapshot.create({
      data: {
        timestamp: snapshot.timestamp,
        symbol: snapshot.symbol,
        data: JSON.stringify(snapshot),
      },
    });
  }

  async loadSnapshots(
    symbol: string,
    startTime: number,
    endTime: number
  ): Promise<MarketSnapshot[]> {
    const rows = await this.prisma.marketSnapshot.findMany({
      where: {
        symbol,
        timestamp: { gte: startTime, lte: endTime },
      },
      orderBy: { timestamp: "asc" },
    });

    return rows.map((row) => JSON.parse(row.data));
  }

  startRecording(symbol: string = "BTC", intervalMs: number = 60000): void {
    if (this.recording) return;

    this.recording = true;
    console.log(`Started recording ${symbol} snapshots every ${intervalMs}ms`);

    this.intervalId = setInterval(async () => {
      try {
        const snapshot = await this.captureSnapshot(symbol);
        await this.saveSnapshot(snapshot);
        console.log(
          `Recorded snapshot: ${snapshot.options.length} options, forward=${snapshot.forward}`
        );
      } catch (err) {
        console.error("Failed to record snapshot:", err);
      }
    }, intervalMs);
  }

  stopRecording(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.recording = false;
      console.log("Stopped recording");
    }
  }

  isRecording(): boolean {
    return this.recording;
  }
}