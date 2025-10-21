import { PrismaClient } from "@prisma/client";
import { quoteEngine, initializeWithMarketData } from "../quoteEngine";

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
  console.log("🚀 Real Paper Trade - Debug Version\n");
  
  const prisma = new PrismaClient();
  await prisma.$connect();

  const btcForward = await initializeWithMarketData(prisma);
  
  const tickers = await prisma.ticker.findMany({
    where: {
      instrument: { contains: "BTC-17OCT25" },
      bid: { not: null },
      ask: { not: null }
    },
    orderBy: { tsMs: "desc" },
    take: 10
  });
  
  const latestByInstrument = new Map();
  for (const t of tickers) {
    if (!latestByInstrument.has(t.instrument)) {
      latestByInstrument.set(t.instrument, t);
    }
  }
  
  console.log(`Found ${latestByInstrument.size} instruments\n`);
  
  // CALIBRATE ONCE with all available market points for this expiry
  if (latestByInstrument.size > 0) {
    const firstInstrument = Array.from(latestByInstrument.keys())[0];
    const expiry17Oct = parseExpiry(firstInstrument);
    
    const marketSmile = Array.from(latestByInstrument.values()).map(t => ({
      strike: parseFloat(t.instrument.split('-')[2]),
      iv: t.markIV ? t.markIV / 100 : 0.5,
      weight: 1.0
    }));
    
    console.log(`Calibrating ${marketSmile.length} strikes to market smile...\n`);
    (quoteEngine as any).calibrateExpiry("BTC", expiry17Oct, marketSmile, btcForward);
  }
  
  // NOW generate quotes
  let count = 0;
  for (const [instrument, ticker] of latestByInstrument) {
    if (count++ >= 3) break;
    
    const parts = instrument.split('-');
    const strike = parseFloat(parts[2]);
    const optionType = parts[3] as "C" | "P";
    const expiryMs = parseExpiry(instrument);
    const marketIV = ticker.markIV ? ticker.markIV / 100 : undefined;
    
    console.log(`${instrument}:`);
    console.log(`  Debug: strike=${strike}, expiryMs=${expiryMs}, optionType=${optionType}, marketIV=${marketIV}`);
    console.log(`  Deribit: ${ticker.bid.toFixed(4)} / ${ticker.ask.toFixed(4)}`);
    
    const yourQuote = quoteEngine.getQuote({
      symbol: "BTC",
      strike,
      expiryMs,
      optionType,
      marketIV
    });
    
    console.log(`  You: ${yourQuote.bid.toFixed(4)} / ${yourQuote.ask.toFixed(4)} (pcMid=${yourQuote.pcMid?.toFixed(6)})`);
    
    const deribitMid = (ticker.bid + ticker.ask) / 2;
    const edgeUSD = (yourQuote.mid - deribitMid) * btcForward;
    console.log(`  Edge: ${edgeUSD > 0 ? '+' : ''}${edgeUSD.toFixed(0)} USD\n`);
  }
  
  await prisma.$disconnect();
}

main();