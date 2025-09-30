import Fastify from "fastify";
import cors from "@fastify/cors";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { startIngest } from "./ingest";
import { computePortfolioRisk, computeRealizedPnL } from "./risk";
import { quoteEngine } from "./quoteEngine";

async function main() {
  console.log(`[server] PORT=${process.env.PORT} NETWORK=${process.env.DERIBIT_NETWORK} MOCK=${process.env.MOCK_MODE}`);
  
  // Enable mock mode for testing
  if (!process.env.MOCK_MODE) {
    process.env.MOCK_MODE = "1";
    console.log("[server] Enabling MOCK_MODE for testing");
  }
  
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const prisma = new PrismaClient();

  // Kick off ingest (fire-and-forget)
  console.log("[server] Starting ingest process...");
  startIngest(prisma).catch(err => {
    console.error("INGEST ERROR:", err);
  });

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));

  // === RISK & PNL ===
  app.get("/risk/greeks", async () => {
    return await computePortfolioRisk(prisma);
  });

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

  // Set / replace positions (for quick testing)
  app.post<{
    Body: { positions: Array<{ instrument:string; qty:number; avgPrice:number }> }
  }>("/positions/set", async (req, res) => {
    const { positions } = req.body;
    if(!Array.isArray(positions)) return res.status(400).send({ error:"positions must be array" });

    // upsert each
    for(const p of positions){
      await prisma.position.upsert({
        where: { instrument: p.instrument },
        create: { instrument: p.instrument, qty: p.qty, avgPrice: p.avgPrice },
        update: { qty: p.qty, avgPrice: p.avgPrice, updatedAt: new Date() }
      });
    }
    return { ok:true, count: positions.length };
  });

  // Optional: add a dummy seed for quick demo
  app.post("/positions/seed-demo", async () => {
    // pick instruments we already subscribed to or any from /instruments
    const ins = await prisma.instrument.findMany({ take: 3 });
    if(ins.length === 0) return { ok:false, msg:"no instruments in DB yet" };
    const payload = ins.slice(0,3).map((m,i)=>({
      instrument: m.id,
      qty: (i===0? +5 : i===1? -3 : +2),
      avgPrice: 100 // placeholder, real fills will update this
    }));
    for(const p of payload){
      await prisma.position.upsert({
        where:{ instrument:p.instrument },
        create: p,
        update: { qty:p.qty, avgPrice:p.avgPrice }
      });
    }
    return { ok:true, positions: payload };
  });

  // List instruments we've upserted
  app.get("/instruments", async () => {
    const rows = await prisma.instrument.findMany({ orderBy: { name: "asc" }});
    return rows;
  });

  // Latest N ticker rows for an instrument
  app.get<{
    Params: { instrument: string }; Querystring: { limit?: string }
  }>("/tickers/:instrument", async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? "50")));
    const rows = await prisma.ticker.findMany({
      where: { instrument: req.params.instrument },
      orderBy: { tsMs: "desc" },
      take: limit
    });
    return rows;
  });

  // Latest index prints
  app.get<{
    Params: { indexName: string }; Querystring: { limit?: string }
  }>("/index/:indexName", async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? "50")));
    const rows = await prisma.tickIndex.findMany({
      where: { indexName: req.params.indexName },
      orderBy: { tsMs: "desc" },
      take: limit
    });
    return rows;
  });

  // === VOLATILITY MODEL QUOTES ===
  
  // Get single quote
  app.post<{
    Body: { symbol: string; strike: number; expiry?: number; size?: number; side?: 'BUY' | 'SELL' }
  }>("/quote", async (req) => {
    const { symbol = 'BTC', strike, expiry = 0.08, size, side } = req.body;
    const quote = quoteEngine.getQuote({ symbol, strike, expiry, size, side });
    return quote;
  });

  // Get quote grid
  app.post<{
    Body: { symbol: string; strikes: number[]; expiry?: number }
  }>("/quote/grid", async (req) => {
    const { symbol = 'BTC', strikes, expiry = 0.08 } = req.body;
    const quotes = quoteEngine.getQuoteGrid(symbol, strikes, expiry);
    return quotes;
  });

  // Execute trade (update vol model)
  app.post<{
    Body: { symbol: string; strike: number; side: 'BUY' | 'SELL'; size: number; price: number }
  }>("/trade/execute", async (req) => {
    const trade = { ...req.body, timestamp: Date.now() };
    quoteEngine.executeTrade(trade);
    
    // Get updated inventory
    const inv = quoteEngine.getInventory(trade.symbol);
    
    return {
      success: true,
      trade,
      inventory: inv
    };
  });

  // Update spot price
  app.post<{
    Body: { symbol: string; spot: number }
  }>("/spot/update", async (req) => {
    const { symbol, spot } = req.body;
    quoteEngine.updateSpot(symbol, spot);
    return { success: true, symbol, spot };
  });

  // Get current inventory
  app.get<{
    Querystring: { symbol?: string }
  }>("/inventory", async (req) => {
    const symbol = req.query.symbol || 'BTC';
    const inv = quoteEngine.getInventory(symbol);
    return inv;
  });

  const port = Number(process.env.PORT || 3001);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`server up http://localhost:${port}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});