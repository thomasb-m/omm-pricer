import Fastify from "fastify";
import cors from "@fastify/cors";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { startIngest } from "./ingest";
import { computePortfolioRisk, computeRealizedPnL } from "./risk";
import { quoteEngine, initializeWithMarketData } from "./quoteEngine";
import { MarketRecorder } from "./replay/marketRecorder";
import { Backtester, PassiveMMStrategy, InventoryAwareStrategy } from "./replay/backtester";

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const ensureMs = (expiryOrYears?: number) =>
  expiryOrYears && expiryOrYears > 1e10
    ? Math.floor(expiryOrYears)
    : Math.floor(Date.now() + (expiryOrYears ?? 0.08) * YEAR_MS);

    export async function startServer() {
      console.log(`[server] PORT=${process.env.PORT} NETWORK=${process.env.DERIBIT_NETWORK} MOCK=${process.env.MOCK_MODE}`);
    
      if (!process.env.MOCK_MODE) {
        process.env.MOCK_MODE = "1";
        console.log("[server] Enabling MOCK_MODE for testing");
      }
    
      const app = Fastify({ logger: false }); // Less noise
      await app.register(cors, { origin: true });
    
      const prisma = new PrismaClient();
    
      // Connect to database first
      try {
        await prisma.$connect();
        console.log("[server] ✅ Database connected");
      } catch (err) {
        console.error("[server] ❌ Database connection failed:", err);
        process.exit(1);
      }
    
      console.log("[server] Starting ingest process...");
      startIngest(prisma).catch(err => console.error("INGEST ERROR:", err));
    
      console.log("[server] Initializing quote engine...");
      try {
        await initializeWithMarketData(prisma);
        console.log("[server] ✅ Quote engine initialized");
      } catch (err) {
        console.error("FATAL: Quote engine init failed:", err);
        if (process.env.MOCK_MODE !== "1") {
          process.exit(1);
        }
        console.log("[server] ⚠️  Continuing in MOCK mode");
      }
    
      const recorder = new MarketRecorder(prisma);
      recorder.startRecording("BTC", 60000);

  // ------------------------
  // Health
  // ------------------------
  app.get("/health", async () => ({ ok: true, ts: Date.now() }));

  // ------------------------
  // Risk & PnL
  // ------------------------
  app.get("/risk/greeks", async () => computePortfolioRisk(prisma));

  app.get("/pnl", async () => {
    const realized = await computeRealizedPnL(prisma);
    const port = await computePortfolioRisk(prisma);
    return {
      realized,
      unrealized: port.totals.unrealized,
      total: realized + port.totals.unrealized,
      totals: port.totals,
      legs: port.legs
    };
  });

  app.get("/pnl/summary", async () => {
    const file = "data/trades.jsonl";
    if (!require("fs").existsSync(file)) {
      return { count: 0, totalEdge: 0, avgEdge: 0 };
    }
    const lines = require("fs").readFileSync(file, "utf8").trim().split("\n");
    let totalEdge = 0;
    for (const ln of lines) {
      try {
        const r = JSON.parse(ln);
        totalEdge += r.pnl_est ?? 0;
      } catch {}
    }
    return {
      count: lines.length,
      totalEdge: parseFloat(totalEdge.toFixed(2)),
      avgEdge: lines.length ? parseFloat((totalEdge / lines.length).toFixed(4)) : 0
    };
  });

  // ------------------------
  // Positions helpers
  // ------------------------
  app.post<{ Body: { positions: Array<{ instrument:string; qty:number; avgPrice:number }> } }>(
    "/positions/set", async (req, res) => {
      const { positions } = req.body;
      if(!Array.isArray(positions)) return res.status(400).send({ error:"positions must be array" });
      for (const p of positions) {
        await prisma.position.upsert({
          where: { instrument: p.instrument },
          create: { instrument: p.instrument, qty: p.qty, avgPrice: p.avgPrice },
          update: { qty: p.qty, avgPrice: p.avgPrice, updatedAt: new Date() }
        });
      }
      return { ok:true, count: positions.length };
    }
  );

  app.post("/positions/seed-demo", async () => {
    const ins = await prisma.instrument.findMany({ take: 3 });
    if(ins.length === 0) return { ok:false, msg:"no instruments in DB yet" };
    const payload = ins.slice(0,3).map((m,i)=>({
      instrument: m.id, qty: (i===0? +5 : i===1? -3 : +2), avgPrice: 100
    }));
    for(const p of payload){
      await prisma.position.upsert({ where:{ instrument:p.instrument }, create: p, update: { qty:p.qty, avgPrice:p.avgPrice }});
    }
    return { ok:true, positions: payload };
  });

  // ------------------------
  // Market data reads
  // ------------------------
  app.get("/instruments", async () => prisma.instrument.findMany({ orderBy: { name: "asc" }}));

  app.get<{ Params: { instrument: string }; Querystring: { limit?: string } }>(
    "/tickers/:instrument", async (req) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? "50")));
      return prisma.ticker.findMany({
        where: { instrument: req.params.instrument },
        orderBy: { tsMs: "desc" },
        take: limit
      });
    }
  );

  app.get<{ Params: { indexName: string }; Querystring: { limit?: string } }>(
    "/index/:indexName", async (req) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? "50")));
      return prisma.tickIndex.findMany({
        where: { indexName: req.params.indexName },
        orderBy: { tsMs: "desc" },
        take: limit
      });
    }
  );

  // ------------------------
  // QUOTES
  // ------------------------

  // GET /quote — convenient for curl/tests
  app.get<{ Querystring: { symbol?: string; strike: string; expiryMs: string; optionType?: 'C'|'P'; size?: string; side?: 'BUY'|'SELL'; marketIV?: string } }>(
    "/quote", async (req, reply) => {
      const q = req.query;
      const symbol = (q.symbol ?? "BTC").toUpperCase();
      const strike = Number(q.strike);
      const expiryMs = Number(q.expiryMs);
      const optionType = (q.optionType === "C" ? "C" : "P") as 'C'|'P';
      const size = q.size ? Number(q.size) : undefined;
      const side = q.side === "BUY" || q.side === "SELL" ? q.side : undefined;
      const marketIV = q.marketIV != null ? Number(q.marketIV) : undefined;

      if (!Number.isFinite(strike) || !Number.isFinite(expiryMs)) {
        return reply.code(400).send({ error: "strike and expiryMs must be numbers" });
      }

      const res = quoteEngine.getQuote({ symbol, strike, expiryMs, optionType, size, side, marketIV });
      return reply.send(res);
    }
  );

  // Existing POST /quote — programmatic clients
  app.post<{ Body: { symbol: string; strike: number; expiryMs: number; optionType: 'C'|'P'; size?: number; side?: 'BUY'|'SELL'; marketIV?: number } }>(
    "/quote", async (req) => {
      const { symbol='BTC', strike, expiryMs, optionType='C', size, side, marketIV } = req.body;
      return quoteEngine.getQuote({ symbol, strike, expiryMs, optionType, size, side, marketIV });
    }
  );

  app.post<{ Body: { symbol: string; strikes: number[]; expiryMs: number; optionType?: 'C'|'P' } }>(
    "/quote/grid", async (req) => {
      const { symbol='BTC', strikes, expiryMs, optionType='C' } = req.body;
      return quoteEngine.getQuoteGrid(symbol, strikes, expiryMs, optionType);
    }
  );

  // ------------------------
  // Trades & forwards
  // ------------------------
  app.post<{ Body: { symbol: string; strike: number; expiryMs: number; optionType: 'C'|'P'; side: 'BUY'|'SELL'; size: number; price: number; } }>(
    "/trade/execute", async (req) => {
      const trade = { ...req.body, timestamp: Date.now() };
      quoteEngine.executeTrade(trade);
      const inv = quoteEngine.getInventory(trade.symbol);
      return { success: true, trade, inventory: inv };
    }
  );

  app.post<{ Body: { symbol: string; forward: number } }>(
    "/forward/update", async (req) => {
      const { symbol, forward } = req.body;
      quoteEngine.updateForward(symbol, forward);
      return { success: true, symbol, forward };
    }
  );

  app.get<{ Querystring: { symbol?: string } }>("/inventory", async (req) => {
    const symbol = req.query.symbol || 'BTC';
    return quoteEngine.getInventory(symbol);
  });

  // ------------------------
  // Backtester
  // ------------------------
  app.post<{
    Body: {
      strategy: "passive" | "inventory";
      symbol: string;
      startTime: number;
      endTime: number;
      maxSpreadUSD?: number;
      blockSize?: number;
      optionType?: 'C'|'P';
    }
  }>("/backtest/run", async (req) => {
    const { strategy = "passive", symbol = "BTC", startTime, endTime, maxSpreadUSD, blockSize, optionType } = req.body;

    const backtester = new Backtester(prisma);

    let strat;
    if (strategy === "passive") {
      strat = new PassiveMMStrategy(maxSpreadUSD ?? 5000, blockSize ?? 1);
    } else if (strategy === "inventory") {
      strat = new InventoryAwareStrategy(maxSpreadUSD ?? 5000, blockSize ?? 1);
    } else {
      return { error: "Unknown strategy" };
    }

    const results = await backtester.runBacktest(strat, symbol, startTime, endTime, optionType ?? "P");
    return results;
  });

  // ------------------------
  // Snapshots & debug
  // ------------------------
  app.get<{ Querystring: { symbol?: string; limit?: number } }>(
    "/snapshots/list", async (req) => {
      const symbol = req.query.symbol || "BTC";
      const limit = parseInt(req.query.limit as any) || 100;
      return prisma.marketSnapshot.findMany({
        where: { symbol }, orderBy: { timestamp: "desc" }, take: limit,
        select: { timestamp: true, id: true }
      });
    }
  );

  app.get("/debug/snapshot-latest", async () => {
    const latest = await prisma.marketSnapshot.findFirst({ where: { symbol: "BTC" }, orderBy: { timestamp: "desc" } });
    if (!latest) return { error: "No snapshots" };
    const data = JSON.parse(latest.data);
    return {
      timestamp: new Date(data.timestamp),
      forward: data.forward,
      spot: data.spot,
      optionCount: data.options.length,
      sampleOptions: data.options.slice(0, 5).map((o: any) => ({
        instrument: o.instrument, strike: o.strike, bid: o.bid, ask: o.ask,
        spread: o.ask - o.bid, bidSize: o.bidSize, askSize: o.askSize
      }))
    };
  });

  app.post("/snapshots/capture", async () => {
    const snapshot = await recorder.captureSnapshot("BTC");
    await recorder.saveSnapshot(snapshot);
    return { success: true, snapshot };
  });

    // ------------------------
  // Risk factors passthrough
  // ------------------------
  app.get<{ Querystring: { symbol?: string } }>("/risk/factors", async (req) => {
    const symbol = (req.query.symbol || "BTC").toUpperCase();
    const { volService } = await import("./volModels/integration/volModelService");
    return { symbol, ...volService.getFactors(symbol) };
  });

  app.post<{ Body: { symbol: string; lambda: [number, number, number, number, number, number] } }>(
    "/risk/factors/set-lambda",
    async (req) => {
      const { symbol, lambda } = req.body;
      const { volService } = await import("./volModels/integration/volModelService");
      return volService.setLambda(symbol.toUpperCase(), lambda);
    }
  );

  app.post<{ Body: { symbol: string } }>(
    "/risk/factors/clear",
    async (req) => {
      const { symbol } = req.body;
      const { volService } = await import("./volModels/integration/volModelService");
      return volService.clearInventory(symbol.toUpperCase());
    }
  );


  // ------------------------
  // Start server
  // ------------------------
  const port = Number(process.env.PORT || 3001);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`server up http://localhost:${port}`);
}

if (typeof require !== "undefined" && require.main === module) {
  startServer().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
