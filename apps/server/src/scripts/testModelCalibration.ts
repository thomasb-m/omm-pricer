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
  console.log("🎯 Test Model Calibration\n");
  
  const prisma = new PrismaClient();
  await prisma.$connect();
  
  // Get BTC forward
  const btcPerp = await prisma.ticker.findFirst({
    where: { instrument: "BTC-PERPETUAL" },
    orderBy: { tsMs: "desc" }
  });
  const forward = btcPerp?.markPrice ?? 121000;
  console.log(`BTC Forward: ${forward}\n`);
  
  // Get ALL BTC-17OCT25 options
  const tickers = await prisma.ticker.findMany({
    where: {
      instrument: { contains: "BTC-17OCT25" },
      markIV: { not: null }
    },
    orderBy: { tsMs: "desc" }
  });
  
  const latestByInstrument = new Map();
  for (const t of tickers) {
    if (!latestByInstrument.has(t.instrument)) {
      latestByInstrument.set(t.instrument, t);
    }
  }
  
  // Build market smile
  const marketQuotes = Array.from(latestByInstrument.values())
    .map(t => {
      const parts = t.instrument.split('-');
      const strike = parseFloat(parts[2]);
      const iv = (t.markIV ?? 0) / 100;
      return { strike, iv };
    })
    .filter(q => q.iv > 0.01 && q.iv < 2.0);
  
  console.log(`Found ${marketQuotes.length} market quotes\n`);
  
  const expiryMs = parseExpiry(latestByInstrument.values().next().value.instrument);
  
  // Create model and calibrate using the model's method
  const model = new IntegratedSmileModel('BTC');
  console.log("Calibrating with model.calibrateFromMarket()...\n");
  model.calibrateFromMarket(expiryMs, marketQuotes, forward);
  
  // Test a put quote
  console.log("\nTesting 108000 Put:");
  const putQuote = model.getQuote(expiryMs, 108000, forward, 'P');
  console.log(`  Model: ${putQuote.bid.toFixed(4)} / ${putQuote.ask.toFixed(4)}`);
  console.log(`  pcMid: ${putQuote.pcMid.toFixed(4)}`);
  console.log(`  ccMid: ${putQuote.ccMid.toFixed(4)}`);
  
  const putTicker = latestByInstrument.get('BTC-17OCT25-108000-P');
  if (putTicker) {
    console.log(`  Market: ${putTicker.bid?.toFixed(4)} / ${putTicker.ask?.toFixed(4)}`);
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);
