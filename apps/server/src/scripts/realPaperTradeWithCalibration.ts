import { PrismaClient } from "@prisma/client";
import { IntegratedSmileModel } from "../volModels/integratedSmileModel";

function parseExpiry(instrumentName: string): number {
  const parts = instrumentName.split('-');
  const dateStr = parts[1];
  const day = parseInt(dateStr.substring(0, 2));
  const monthStr = dateStr.substring(2, 5);
  const year = 2000 + parseInt(dateStr.substring(5, 7));
  const months: Record<string, number> = {
    'JAN': 0, 'FEB': 1, 'MAR': 2, 'APR': 3, 'MAY': 4, 'JUN': 5,
    'JUL': 6, 'AUG': 7, 'SEP': 8, 'OCT': 9, 'NOV': 10, 'DEC': 11
  };
  const month = months[monthStr.toUpperCase()];
  return new Date(Date.UTC(year, month, day, 8, 0, 0)).getTime();
}

async function main() {
  console.log("🚀 Real Paper Trade - WITH CALIBRATION\n");
  
  const prisma = new PrismaClient();
  await prisma.$connect();
  
  // Get forward
  const btcPerp = await prisma.ticker.findFirst({
    where: { instrument: "BTC-PERPETUAL" },
    orderBy: { tsMs: "desc" }
  });
  const forward = btcPerp?.markPrice ?? 121000;
  console.log(`BTC Forward: ${forward}\n`);
  
  const tickers = await prisma.ticker.findMany({
    where: {
      instrument: { contains: "BTC-17OCT25" },
      bid: { not: null },
      ask: { not: null },
      markIV: { not: null }
    },
    orderBy: { tsMs: "desc" },
    take: 50
  });
  
  const latestByInstrument = new Map();
  for (const t of tickers) {
    if (!latestByInstrument.has(t.instrument)) {
      latestByInstrument.set(t.instrument, t);
    }
  }
  
  console.log(`Found ${latestByInstrument.size} instruments\n`);
  
  // Build full market smile for calibration
  const marketQuotes = Array.from(latestByInstrument.values())
    .map(t => {
      const parts = t.instrument.split('-');
      const strike = parseFloat(parts[2]);
      const iv = (t.markIV ?? 0) / 100;
      return { strike, iv };
    })
    .filter(q => q.iv > 0.01 && q.iv < 2.0);
  
  const expiryMs = parseExpiry(Array.from(latestByInstrument.values())[0].instrument);
  
  // Create model and CALIBRATE FIRST
  const model = new IntegratedSmileModel('BTC');
  console.log("Calibrating SVI from full market smile...");
  model.calibrateFromMarket(expiryMs, marketQuotes, forward);
  console.log();
  
  // Now get quotes
  let count = 0;
  for (const [instrument, ticker] of latestByInstrument) {
    if (count++ >= 5) break;
    
    const parts = instrument.split('-');
    const strike = parseFloat(parts[2]);
    const optionType = parts[3] as "C" | "P";
    
    const quote = model.getQuote(expiryMs, strike, forward, optionType);
    
    console.log(`${instrument}:`);
    console.log(`  Deribit: ${ticker.bid.toFixed(4)} / ${ticker.ask.toFixed(4)}`);
    console.log(`  Model:   ${quote.bid.toFixed(4)} / ${quote.ask.toFixed(4)} (mid=${quote.pcMid.toFixed(4)})`);
    
    const deribitMid = (ticker.bid + ticker.ask) / 2;
    const edgeUSD = (quote.pcMid - deribitMid) * forward;
    console.log(`  Edge: ${edgeUSD > 0 ? '+' : ''}${edgeUSD.toFixed(0)} USD\n`);
  }
  
  await prisma.$disconnect();
}

main();
