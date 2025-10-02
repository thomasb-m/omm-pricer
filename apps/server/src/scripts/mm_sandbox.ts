/**
 * Minimal MM sandbox:
 * - reads ticks from Prisma (your mock feed)
 * - builds a strike grid around the first forward
 * - each market beat, requests quotes from quoteEngine for each strike
 * - randomly fills a few quotes, updates inventory and cash P&L
 * - prints a compact summary + inventory by strike at the end
 *
 * Run:
 *   npx ts-node --transpile-only src/scripts/mm_sandbox.ts \
 *     --symbol BTC --minutes 5 --tenorDays 7 --edgeUSD 2 --fillProb 0.15
 */

import { PrismaClient } from "@prisma/client";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { quoteEngine } from "../quoteEngine";

type Side = "BUY" | "SELL";
type OptionType = "C" | "P";

type InvRow = {
  qty: number;      // + long, - short
  cash: number;     // realized cash from trades at our price
  lastMid: number;  // last seen ccMid to mark-to-market
  lastTs: number;
  avgPx: number;    // |cash| / |qty| when open
};

function strikeGrid(F: number, pct: number, step: number): number[] {
  const low = Math.floor((F * (1 - pct)) / step) * step;
  const high = Math.ceil((F * (1 + pct)) / step) * step;
  const out: number[] = [];
  for (let k = low; k <= high; k += step) out.push(k);
  return out;
}

function rand() { return Math.random(); }

(async () => {
  const argv = await yargs(hideBin(process.argv))
    .option("symbol", { type: "string", default: "BTC" })
    .option("minutes", { type: "number", default: 5, desc: "lookback minutes" })
    .option("tenorDays", { type: "number", default: 7 })
    .option("optionType", { type: "string", default: "P", choices: ["P","C"] })
    .option("gridPct", { type: "number", default: 0.10, desc: "±% around ATM" })
    .option("gridStep", { type: "number", default: 100 })
    .option("blockSize", { type: "number", default: 1 })
    .option("edgeUSD", { type: "number", default: 2, desc: "target quote edge in USD (informational)" })
    .option("fillProb", { type: "number", default: 0.15, desc: "chance a quote fills" })
    .option("maxPerBeat", { type: "number", default: 5, desc: "max fills per tick" })
    .help()
    .parse();

  const {
    symbol, minutes, tenorDays, optionType,
    gridPct, gridStep, blockSize, fillProb, maxPerBeat
  } = argv as any;

  const prisma = new PrismaClient();

  try {
    const endTime = Date.now();
    const startTime = endTime - Math.max(1, minutes) * 60 * 1000;

    const beats = await prisma.ticker.findMany({
      where: { instrument: "BTC-PERPETUAL", tsMs: { gte: BigInt(startTime), lte: BigInt(endTime) } },
      orderBy: { tsMs: "asc" },
      select: { tsMs: true, markPrice: true, underlying: true }
    });

    if (beats.length === 0) {
      console.log("No ticks found in the selected window. Is MOCK ingest running?");
      process.exit(0);
    }

    // anchor grid on first forward so the set of strikes is stable
    const F0 = Number(beats[0].markPrice ?? beats[0].underlying ?? 0);
    if (!Number.isFinite(F0) || F0 <= 0) {
      console.log("Invalid initial forward.");
      process.exit(1);
    }
    const strikes = strikeGrid(F0, gridPct, gridStep);
    const inventory: Record<number, InvRow> = {};
    let fills = 0;
    let cash = 0;

    // simple market IV (use your engine default if it ignores this)
    const marketIV = 0.35;

    for (const b of beats) {
      const ts = Number(b.tsMs);
      const F = Number(b.markPrice ?? b.underlying ?? 0);
      if (!Number.isFinite(F) || F <= 0) continue;

      const expiryMs = ts + Math.round(tenorDays * 24 * 3600 * 1000);
      let filledThisBeat = 0;

      for (const k of strikes) {
        if (filledThisBeat >= maxPerBeat) break;

        const q = quoteEngine.getQuote({
          symbol,
          strike: k,
          expiryMs,
          optionType: optionType as OptionType,
          marketIV
        });

        // Decide a side: sell wings, buy near ATM — extremely simple heuristic
        const rel = Math.abs(k - F) / F;
        const side: Side = rel > 0.03 ? "SELL" : "BUY";

        // stochastic fill
        if (rand() > fillProb) {
          // still record last mid for MtM even if no trade
          const mid = q.ccMid ?? q.mid ?? (q.bid + q.ask) / 2;
          const inv = inventory[k] ?? { qty: 0, cash: 0, lastMid: mid, lastTs: 0, avgPx: 0 };
          inv.lastMid = mid;
          inv.lastTs = ts;
          inventory[k] = inv;
          continue;
        }

        const px = side === "SELL" ? q.ask : q.bid;
        const mid = q.ccMid ?? q.mid ?? (q.bid + q.ask) / 2;

        if (!Number.isFinite(px) || !Number.isFinite(mid)) continue;

        // apply trade
        const inv = inventory[k] ?? { qty: 0, cash: 0, lastMid: mid, lastTs: 0, avgPx: 0 };
        const signedCash = (side === "SELL" ? +1 : -1) * px * blockSize;
        inv.cash += signedCash;
        inv.qty += (side === "SELL" ? -1 : +1) * blockSize;
        inv.lastMid = mid;
        inv.lastTs = ts;
        inv.avgPx = Math.abs(inv.qty) > 0 ? Math.abs(inv.cash) / Math.abs(inv.qty) : 0;
        inventory[k] = inv;

        cash += signedCash;
        fills += 1;
        filledThisBeat += 1;

        // (optional) tell the engine about the fill
        quoteEngine.executeTrade({
          symbol,
          strike: k,
          expiryMs,
          optionType,
          side,
          size: blockSize,
          price: px,
          timestamp: ts
        } as any);
      }
    }

    // mark-to-market close (using lastMid per strike)
    let mtmClose = 0;
    let netContracts = 0;
    for (const k of Object.keys(inventory)) {
      const inv = inventory[+k];
      mtmClose += -inv.qty * inv.lastMid;
      netContracts += inv.qty;
    }

    // --------- PRINT SUMMARY ----------
    const pad = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
    console.log("\n--------------------------------------------------------------------------------");
    console.log(`MM Sandbox — ${symbol}`);
    console.log(`Beats:            ${beats.length}`);
    console.log(`Strikes quoted:   ${strikes.length}`);
    console.log(`Fills:            ${fills}`);
    console.log(`P&L (cash):       $${pad(cash)}`);
    console.log(`P&L (MtM open):   $${pad(mtmClose)}`);
    console.log(`P&L (total):      $${pad(cash + mtmClose)}`);
    console.log(`Net contracts:    ${netContracts}`);
    console.log("--------------------------------------------------------------------------------");

    console.log("Strike    Qty   AvgPx    LastMid   Cash       MtMClose   TotPnL");
    const ks = Object.keys(inventory).map(Number).sort((a, b) => a - b);
    for (const k of ks) {
      const inv = inventory[k];
      const mtm = -inv.qty * inv.lastMid;
      const tot = inv.cash + mtm;
      console.log(
        `${String(k).padEnd(8)} ${String(inv.qty).padStart(5)}   ${inv.avgPx.toFixed(3).padStart(6)}   ${inv.lastMid.toFixed(3).padStart(8)}   ${inv.cash.toFixed(2).padStart(9)}   ${mtm.toFixed(2).padStart(9)}   ${tot.toFixed(2).padStart(9)}`
      );
    }
    console.log("--------------------------------------------------------------------------------");

    await prisma.$disconnect();
  } catch (err) {
    await prisma.$disconnect();
    console.error(err);
    process.exit(1);
  }
})();
