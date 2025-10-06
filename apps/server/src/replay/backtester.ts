import { PrismaClient } from "@prisma/client";
import { quoteEngine } from "../quoteEngine";
import { VolModelService } from "../services/volModelService";
import { TradeLog } from "../logging/tradeLog";


export type Side = "BUY" | "SELL";
export type OptionType = "C" | "P";

export type BacktestResult = {
  trades: number;
  totalEdgeUSD: number;
  avgEdgePerContractUSD: number;
  winRatePct: number;
  byTrade: Trade[];
  inventory: Record<number, { qty: number; avgPrice: number; totalEdge: number }>;
};

export type Trade = {
  ts: number;
  strike: number;
  expiryMs: number;
  side: Side;
  optionType: OptionType;
  price: number;
  ccMid: number;
  edgeUSD: number;
  bucket?: string;
};

export interface Strategy {
  name: string;
  decide(q: QuoteLike, context: TickContext): Side | null;
  size(q: QuoteLike, context: TickContext): number;
}

type QuoteLike = {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  spread: number;
  ccMid?: number;
  pcMid?: number;
  bucket?: string;
};

type TickContext = {
  ts: number;
  symbol: string;
  strike: number;
  expiryMs: number;
  optionType: OptionType;
};

function strikeGrid(F: number): number[] {
  const low = Math.floor(F * 0.9 / 100) * 100;
  const high = Math.ceil(F * 1.1 / 100) * 100;
  const strikes: number[] = [];
  for (let k = low; k <= high; k += 100) strikes.push(k);
  return strikes;
}

function tradeEdgeUSD(side: Side, ccMid: number, bid: number, ask: number): number {
  return side === "SELL" ? ask - ccMid : ccMid - bid;
}

export class PassiveMMStrategy implements Strategy {
  name = "Passive Market Making";
  constructor(private maxSpreadUSD = 5000, private blockSize = 1) {}

  decide(q: QuoteLike): Side | null {
    if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask)) return null;
    if (q.ask <= 0 || q.bid < 0) return null;
    if (q.spread > this.maxSpreadUSD) return null;
    if ((q.askSize || 0) >= this.blockSize) return "SELL";
    if ((q.bidSize || 0) >= this.blockSize) return "BUY";
    return null;
  }
  size(): number { return this.blockSize; }
}

export class InventoryAwareStrategy implements Strategy {
  name = "Inventory-Aware MM";
  constructor(private maxSpreadUSD = 5000, private blockSize = 1) {}

  decide(q: QuoteLike): Side | null {
    if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask)) return null;
    if (q.spread > this.maxSpreadUSD) return null;
    if ((q.askSize || 0) >= this.blockSize) return "SELL";
    if ((q.bidSize || 0) >= this.blockSize) return "BUY";
    // fallback: just sell if nothing else
    return "SELL";
  }
  size(): number { return this.blockSize; }
}

export class Backtester {
  constructor(private prisma: PrismaClient) {}

  async runBacktest(
    strat: Strategy,
    symbol: string,
    startTime: number,
    endTime: number,
    optionType: OptionType = "P"
  ): Promise<{ strategy: string; summary: BacktestResult }> {
    const beats = await this.prisma.ticker.findMany({
      where: { instrument: "BTC-PERPETUAL", tsMs: { gte: BigInt(startTime), lte: BigInt(endTime) } },
      orderBy: { tsMs: "asc" },
      select: { tsMs: true, markPrice: true, underlying: true }
    });
    if (beats.length === 0) {
      return { strategy: strat.name, summary: { trades: 0, totalEdgeUSD: 0, avgEdgePerContractUSD: 0, winRatePct: 0, byTrade: [], inventory: {} } };
    }

    const byTrade: Trade[] = [];
    const inventory: Record<number, { qty: number; avgPrice: number; totalEdge: number }> = {};
    let trades = 0, totalEdgeUSD = 0, wins = 0;

    for (const b of beats) {
      const ts = Number(b.tsMs);
      const F = Number(b.markPrice ?? b.underlying ?? 0);
      if (!Number.isFinite(F) || F <= 0) continue;
      const expiryMs = ts + Math.round(14 * 24 * 3600 * 1000);
    
      // Estimate ATM IV from recent market (simple heuristic: 30-80 vol in BTC terms)
      const atmIV = 0.35; // Placeholder - should come from market data
    
      for (const strike of strikeGrid(F)) {
        const q = quoteEngine.getQuote({ 
          symbol, strike, expiryMs, optionType, 
          marketIV: atmIV  // Use dynamic IV here
        });
        
        const side = strat.decide(q, { ts, symbol, strike, expiryMs, optionType });
        if (!side) continue;
        const size = strat.size(q, { ts, symbol, strike, expiryMs, optionType });
        if (size <= 0) continue;
    
        const ccMid = q.ccMid ?? q.mid;
        const edge = tradeEdgeUSD(side, ccMid, q.bid, q.ask);
    
        trades += size;
        totalEdgeUSD += edge * size;
        if (edge > 0) wins += size;
    
        // update inventory
        const inv = inventory[strike] || { qty: 0, avgPrice: 0, totalEdge: 0 };
        if (side === "SELL") inv.qty -= size; else inv.qty += size;
        inv.totalEdge += edge * size;
        inv.avgPrice = (inv.avgPrice * Math.abs(inv.qty) + (side === "SELL" ? q.ask : q.bid) * size) / (Math.abs(inv.qty) + size);
        inventory[strike] = inv;
    
        byTrade.push({ 
          ts, strike, expiryMs, side, optionType, 
          price: side === "SELL" ? q.ask : q.bid, 
          ccMid, edgeUSD: edge, bucket: q.bucket 
        });
        
        quoteEngine.executeTrade({ 
          symbol, strike, expiryMs, optionType, side, size, 
          price: side === "SELL" ? q.ask : q.bid, 
          timestamp: ts,
          marketIV: atmIV  // Pass through for proper surface calibration
        });
      }
    }

    const avg = trades ? totalEdgeUSD / trades : 0;
    const winRatePct = trades ? (wins / trades) * 100 : 0;
    const summary: BacktestResult = { trades, totalEdgeUSD, avgEdgePerContractUSD: avg, winRatePct, byTrade, inventory };

    this.printSummary(strat.name, summary);
    return { strategy: strat.name, summary };
  }

  private printSummary(name: string, s: BacktestResult) {
    console.log("\n--------------------------------------------------------------------------------");
    console.log(`Results Summary — ${name}`);
    console.log(`Trades executed:  ${s.trades}`);
    console.log(`Total edge:       $${s.totalEdgeUSD.toFixed(2)}`);
    console.log(`Avg edge/contract:$${s.avgEdgePerContractUSD.toFixed(4)}`);
    console.log(`Win rate:         ${s.winRatePct.toFixed(1)}%`);
    console.log("\nNet Inventory by Strike:");
    console.log("Strike    Qty   AvgPx   Edge");
    for (const k of Object.keys(s.inventory).sort((a,b)=>+a - +b)) {
      const inv = s.inventory[+k];
      console.log(`${k.padEnd(8)} ${inv.qty.toString().padStart(5)}   ${inv.avgPrice.toFixed(2).padStart(6)}   ${inv.totalEdge.toFixed(2).padStart(6)}`);
    }
  }
}
