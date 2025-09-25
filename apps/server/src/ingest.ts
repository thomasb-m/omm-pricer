import { PrismaClient } from "@prisma/client";
import { DeribitWS } from "./deribit";

type Picked = { atm: any; wingC: any; wingP: any; expiryMs: number };

function chooseThree(list: any[], spot: number): Picked | null {
  const now = Date.now();
  const targetDays = 7;
  let bestExpTs: number | null = null, bestExpDiff = Infinity;
  const byExp = new Map<number, any[]>();
  for (const ins of list) {
    const ts = ins.expiration_timestamp;
    if (!byExp.has(ts)) byExp.set(ts, []);
    byExp.get(ts)!.push(ins);
    const days = (ts - now) / (1000*60*60*24);
    const diff = Math.abs(days - targetDays);
    if (diff < bestExpDiff) { bestExpDiff = diff; bestExpTs = ts; }
  }
  if (!bestExpTs) return null;

  const bucket = byExp.get(bestExpTs)!;
  let atm: any=null, atmDiff=Infinity;
  let wingC: any=null, wingCDiff=Infinity, targetC=spot*1.10;
  let wingP: any=null, wingPDiff=Infinity, targetP=spot*0.90;

  for (const ins of bucket) {
    const d = Math.abs(ins.strike - spot);
    if (d < atmDiff) { atm = ins; atmDiff = d; }
    if (ins.strike >= targetC) {
      const dc = Math.abs(ins.strike - targetC);
      if (dc < wingCDiff && (ins.option_type === "call" || wingC === null)) {
        wingC = ins; wingCDiff = dc;
      }
    }
    if (ins.strike <= targetP) {
      const dp = Math.abs(ins.strike - targetP);
      if (dp < wingPDiff && (ins.option_type === "put" || wingP === null)) {
        wingP = ins; wingPDiff = dp;
      }
    }
  }
  if (!wingC) wingC = atm;
  if (!wingP) wingP = atm;
  return { atm, wingC, wingP, expiryMs: bestExpTs! };
}

function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }

export async function startIngest(prisma: PrismaClient) {
  // Make BigInt printable in JSON
  (BigInt.prototype as any).toJSON = function(){ return Number(this) };

  // MOCK MODE (no network, always produces data)
  if (process.env.MOCK_MODE === "1") {
    console.log("[ingest] MOCK_MODE=1 — generating fake ticks");
    console.log("[ingest] Mock mode enabled, starting data generation...");
    const nameATM = "MOCK-BTC-7D-ATM-C";
    const nameCW  = "MOCK-BTC-7D-110C";
    const namePW  = "MOCK-BTC-7D-090P";

    // upsert instruments
    const now = Date.now();
    const expiryMs = BigInt(now + 7*24*3600*1000);
    for (const [n, strike, type] of [
      [nameATM, 100_000, "call"],
      [nameCW,  110_000, "call"],
      [namePW,   90_000, "put" ],
    ] as const) {
      await prisma.instrument.upsert({
        where: { id: n },
        create: { id: n, name: n, kind: "option", currency: "BTC", strike, optionType: type, expiryMs },
        update: {}
      });
    }

    // mock generator
    let f = 100_000;
    let t = 0;
    console.log("[ingest] Starting mock data generation loop...");
    (async () => {
      while (true) {
        t += 1;
        f += Math.sin(t/10)*5 + (Math.random()-0.5)*10;
        const tsMs = BigInt(Date.now());
        
        console.log(`[ingest] Mock tick ${t}: price=${f.toFixed(2)}`);
        await prisma.tickIndex.create({ data: { tsMs, indexName:"btc_usd", price: f } }).catch((e) => {
          console.error("[ingest] Index save error:", e);
        });

        const mIv = 0.5 + 0.05*Math.sin(t/30);
        for (const n of [nameATM, nameCW, namePW]) {
          await prisma.ticker.create({
            data: {
              tsMs, instrument: n,
              markIv: mIv, markPrice: 100 + Math.sin(t/20)*2 + (Math.random()-0.5),
              bestBid: 99, bestAsk: 101, underlying: f
            }
          }).catch((e) => {
            console.error("[ingest] Ticker save error:", e);
          });
        }
        await sleep(250);
      }
    })();
    return;
  }

  // REAL WS MODE
  const network = (process.env.DERIBIT_NETWORK || "mainnet").toLowerCase();
  console.log(`[ingest] network=${network}`);

  const ws = new DeribitWS(async (channel, data) => {
    const tsMs = BigInt(Date.now());
    console.log(`[ingest] received: ${channel}`, data);

    // BTC perp: use 100ms public stream
    if (channel === "ticker.BTC-PERPETUAL.100ms") {
      const price = typeof data.underlying_price === "number" ? data.underlying_price
                   : typeof data.index_price === "number" ? data.index_price
                   : undefined;
      if (typeof price === "number") {
        console.log(`[ingest] saving index price: ${price}`);
        await prisma.tickIndex.create({
          data: { tsMs, indexName: "btc_usd", price }
        }).catch((e) => {
          console.error("[ingest] index save error:", e);
        });
      }
      return;
    }

    if (channel.startsWith("ticker.")) {
      const name = data.instrument_name as string;
      const markIv = typeof data.mark_iv === "number" ? data.mark_iv : null;
      const markPrice = typeof data.mark_price === "number" ? data.mark_price : null;
      const bestBid = typeof data.best_bid_price === "number" ? data.best_bid_price : null;
      const bestAsk = typeof data.best_ask_price === "number" ? data.best_ask_price : null;
      const underlying = typeof data.underlying_price === "number" ? data.underlying_price : null;
      console.log(`[ingest] saving ticker: ${name}, markIv: ${markIv}, underlying: ${underlying}`);
      await prisma.ticker.create({
        data: { tsMs, instrument: name, markIv, markPrice, bestBid, bestAsk, underlying }
      }).catch((e) => {
        console.error("[ingest] ticker save error:", e);
      });
      return;
    }
  });

  console.log("[ingest] connecting ws…");
  await ws.connect(network);

  // Subscribe to public (non-auth) channels
  await ws.subscribe(["ticker.BTC-PERPETUAL.100ms"]);
  const idx = await ws.getIndexPrice("btc_usd").catch(()=>null);
  const spot = idx?.index_price as number | undefined;
  if (typeof spot !== "number") {
    console.error("[ingest] no spot index price; is the network blocking WS?");
    return;
  }
  console.log("[ingest] spot index:", spot);

  // Load instruments and pick ATM + wings
  const list = await ws.getInstruments("BTC", "option", false).catch(()=>[]);
  const picked = chooseThree(list, spot);
  if (!picked) { console.warn("[ingest] Could not pick ATM + wings"); return; }

  for (const m of [picked.atm, picked.wingC, picked.wingP]) {
    await prisma.instrument.upsert({
      where: { id: m.instrument_name },
      create: {
        id: m.instrument_name,
        name: m.instrument_name,
        kind: "option",
        currency: m.currency || "BTC",
        strike: m.strike ?? null,
        optionType: m.option_type ?? null,
        expiryMs: BigInt(m.expiration_timestamp),
      },
      update: {}
    }).catch(()=>{});
  }

  const wanted = [
    picked.atm.instrument_name,
    picked.wingC.instrument_name,
    picked.wingP.instrument_name,
  ];
  await ws.subscribe(wanted.map(n => `ticker.${n}.100ms`));
  console.log("[ingest] subscribed:", wanted.join(", "));
}