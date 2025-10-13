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
  console.log("🧪 Trade Execution Test - Full Loop Validation\n");
  console.log("=" .repeat(70));
  
  const prisma = new PrismaClient();
  await prisma.$connect();

  // Initialize and calibrate
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
  
  if (latestByInstrument.size > 0) {
    const firstInstrument = Array.from(latestByInstrument.keys())[0];
    const expiry17Oct = parseExpiry(firstInstrument);
    
    const marketSmile = Array.from(latestByInstrument.values()).map(t => ({
      strike: parseFloat(t.instrument.split('-')[2]),
      iv: t.markIV ? t.markIV / 100 : 0.5,
      weight: 1.0
    }));
    
    console.log(`\n📊 Calibrating ${marketSmile.length} strikes to market smile...\n`);
    (quoteEngine as any).calibrateExpiry("BTC", expiry17Oct, marketSmile, btcForward);
  }

  // Pick a test instrument (ATM call)
  const testInstrument = Array.from(latestByInstrument.keys()).find(i => i.includes('-C'));
  if (!testInstrument) {
    console.error("No call options found!");
    await prisma.$disconnect();
    return;
  }

  const parts = testInstrument.split('-');
  const strike = parseFloat(parts[2]);
  const optionType = parts[3] as "C" | "P";
  const expiryMs = parseExpiry(testInstrument);
  const ticker = latestByInstrument.get(testInstrument);
  const marketIV = ticker.markIV ? ticker.markIV / 100 : 0.5;

  console.log("\n" + "=".repeat(70));
  console.log(`📍 Test Instrument: ${testInstrument}`);
  console.log(`   Strike: ${strike}, Type: ${optionType}, IV: ${(marketIV*100).toFixed(1)}%`);
  console.log("=".repeat(70));

  // STEP 1: Get initial quote
  console.log("\n🔹 STEP 1: Initial Quote (Before Trade)");
  console.log("-".repeat(70));
  
  const quote1 = quoteEngine.getQuote({
    symbol: "BTC",
    strike,
    expiryMs,
    optionType,
    marketIV
  });

  console.log(`   Bid/Ask: ${quote1.bid.toFixed(4)} / ${quote1.ask.toFixed(4)}`);
  console.log(`   Mid: ${quote1.mid.toFixed(4)} BTC`);
  console.log(`   CC Mid: ${quote1.ccMid?.toFixed(4)} BTC (fair value)`);
  console.log(`   PC Mid: ${quote1.pcMid?.toFixed(4)} BTC (with inventory)`);
  console.log(`   Edge: ${quote1.edge?.toFixed(6)} BTC`);
  console.log(`   Bucket: ${quote1.bucket}`);

  // Get initial inventory
  const inv1 = quoteEngine.getFactorInventory("BTC");
  console.log(`\n   Initial Factor Inventory:`);
  console.log(`   I = [${inv1.inventory.map(x => x.toFixed(2)).join(', ')}]`);
  console.log(`   λ·I = ${inv1.lambdaDotInventory.toFixed(4)}`);

  // STEP 2: Execute a trade (Customer BUYS from us, we SELL)
  console.log("\n🔹 STEP 2: Execute Trade (Customer BUYS 10 contracts)");
  console.log("-".repeat(70));
  
  const tradeSize = 10;
  const tradePrice = quote1.ask; // Customer lifts our offer
  
  console.log(`   Customer BUY ${tradeSize}x ${testInstrument} @ ${tradePrice.toFixed(4)} BTC`);
  console.log(`   (We SELL ${tradeSize} contracts - becoming SHORT)`);

  quoteEngine.executeTrade({
    symbol: "BTC",
    strike,
    expiryMs,
    optionType,
    side: "BUY", // Customer side
    size: tradeSize,
    price: tradePrice,
    timestamp: Date.now(),
    marketIV
  });

  // STEP 3: Get post-trade inventory
  console.log("\n🔹 STEP 3: Check Inventory Update");
  console.log("-".repeat(70));

  const inv2 = quoteEngine.getFactorInventory("BTC");
  console.log(`   New Factor Inventory:`);
  console.log(`   I = [${inv2.inventory.map(x => x.toFixed(2)).join(', ')}]`);
  console.log(`   λ·I = ${inv2.lambdaDotInventory.toFixed(4)}`);
  
  console.log(`\n   Change in Inventory:`);
  const invChange = inv2.inventory.map((x, i) => x - inv1.inventory[i]);
  console.log(`   ΔI = [${invChange.map(x => x.toFixed(2)).join(', ')}]`);
  console.log(`   Δ(λ·I) = ${(inv2.lambdaDotInventory - inv1.lambdaDotInventory).toFixed(4)}`);

  // Check for meaningful change
  const hasChanged = invChange.some(x => Math.abs(x) > 0.01);
  if (hasChanged) {
    console.log(`   ✅ Inventory updated correctly!`);
  } else {
    console.log(`   ⚠️  WARNING: Inventory did not change significantly!`);
  }

  // STEP 4: Get new quote
  console.log("\n🔹 STEP 4: New Quote (After Trade)");
  console.log("-".repeat(70));

  const quote2 = quoteEngine.getQuote({
    symbol: "BTC",
    strike,
    expiryMs,
    optionType,
    marketIV
  });

  console.log(`   Bid/Ask: ${quote2.bid.toFixed(4)} / ${quote2.ask.toFixed(4)}`);
  console.log(`   Mid: ${quote2.mid.toFixed(4)} BTC`);
  console.log(`   CC Mid: ${quote2.ccMid?.toFixed(4)} BTC (unchanged)`);
  console.log(`   PC Mid: ${quote2.pcMid?.toFixed(4)} BTC (adjusted)`);
  console.log(`   Edge: ${quote2.edge?.toFixed(6)} BTC`);

  // STEP 5: Analyze changes
  console.log("\n🔹 STEP 5: Quote Change Analysis");
  console.log("-".repeat(70));

  const bidChange = quote2.bid - quote1.bid;
  const askChange = quote2.ask - quote1.ask;
  const midChange = quote2.mid - quote1.mid;
  const pcMidChange = (quote2.pcMid || 0) - (quote1.pcMid || 0);
  const edgeChange = (quote2.edge || 0) - (quote1.edge || 0);

  console.log(`   Bid change: ${bidChange > 0 ? '+' : ''}${bidChange.toFixed(6)} BTC (${((bidChange/quote1.bid)*100).toFixed(2)}%)`);
  console.log(`   Ask change: ${askChange > 0 ? '+' : ''}${askChange.toFixed(6)} BTC (${((askChange/quote1.ask)*100).toFixed(2)}%)`);
  console.log(`   Mid change: ${midChange > 0 ? '+' : ''}${midChange.toFixed(6)} BTC (${((midChange/quote1.mid)*100).toFixed(2)}%)`);
  console.log(`   PC Mid change: ${pcMidChange > 0 ? '+' : ''}${pcMidChange.toFixed(6)} BTC`);
  console.log(`   Edge change: ${edgeChange > 0 ? '+' : ''}${edgeChange.toFixed(6)} BTC`);
  
  // Expected behavior: We're now short, so we should be WIDER or HIGHER
  console.log(`\n   Expected: After SELLING (going short), quotes should widen or increase`);
  if (askChange > 0 || midChange > 0) {
    console.log(`   ✅ Quotes adjusted correctly (offer moved up)`);
  } else if (Math.abs(midChange) < 0.0001) {
    console.log(`   ⚠️  WARNING: Quotes barely changed - inventory effect may be too small`);
  } else {
    console.log(`   ❌ ERROR: Quotes moved in wrong direction!`);
  }

  // STEP 6: Summary
  console.log("\n" + "=".repeat(70));
  console.log("📋 TEST SUMMARY");
  console.log("=".repeat(70));
  
  const tests = [
    { name: "Inventory Updated", pass: hasChanged },
    { name: "Quote Adjusted", pass: Math.abs(midChange) > 0.00001 },
    { name: "Direction Correct", pass: askChange >= 0 || midChange >= 0 },
    { name: "CC Unchanged", pass: Math.abs((quote2.ccMid || 0) - (quote1.ccMid || 0)) < 0.00001 },
    { name: "PC Changed", pass: Math.abs(pcMidChange) > 0.00001 }
  ];

  tests.forEach(t => {
    console.log(`   ${t.pass ? '✅' : '❌'} ${t.name}`);
  });

  const allPassed = tests.every(t => t.pass);
  console.log(`\n   ${allPassed ? '🎉 ALL TESTS PASSED!' : '⚠️  SOME TESTS FAILED'}`);
  console.log("=".repeat(70));

  await prisma.$disconnect();
}

main().catch(console.error);