import { PrismaClient } from "@prisma/client";
import { IntegratedSmileModel } from "../volModels/integratedSmileModel";
import { calibrateSVI } from "../volModels/sviCalibration";

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
  console.log("🎯 Test Proper SVI Calibration\n");
  
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
  
  console.log(`Found ${marketQuotes.length} market quotes:`);
  marketQuotes.forEach(q => console.log(`  K=${q.strike} IV=${(q.iv*100).toFixed(2)}%`));
  console.log();
  
  const expiryMs = parseExpiry(latestByInstrument.values().next().value.instrument);
  const T = (expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000);
  
  console.log(`Time to expiry: ${T.toFixed(4)} years\n`);
  
  // Test calibration directly
  const config = {
    bMin: 1e-6,
    sigmaMin: 1e-6,
    rhoMax: 0.995,
    sMax: 5.0,
    c0Min: 0.01
  };
  
  console.log("Running SVI calibration...\n");
  const sviParams = calibrateSVI(marketQuotes, forward, T, config);
  
  console.log("Calibrated SVI Parameters:");
  console.log(`  a     = ${sviParams.a.toFixed(6)}`);
  console.log(`  b     = ${sviParams.b.toFixed(6)}`);
  console.log(`  rho   = ${sviParams.rho.toFixed(6)}`);
  console.log(`  sigma = ${sviParams.sigma.toFixed(6)}`);
  console.log(`  m     = ${sviParams.m.toFixed(6)}`);
  
  // Check validation
  const L0 = sviParams.a + sviParams.b * sviParams.sigma;
  const sLeft = sviParams.b * (1 - sviParams.rho);
  const sRight = sviParams.b * (1 + sviParams.rho);
  
  console.log("\nValidation checks:");
  console.log(`  L0 = a + b*sigma = ${L0.toFixed(6)} (should be >= 0)`);
  console.log(`  sLeft = b*(1-rho) = ${sLeft.toFixed(6)} (should be > 0)`);
  console.log(`  sRight = b*(1+rho) = ${sRight.toFixed(6)} (should be > 0)`);
  console.log(`  b >= bMin? ${sviParams.b >= config.bMin}`);
  console.log(`  sigma >= sigmaMin? ${sviParams.sigma >= config.sigmaMin}`);
  console.log(`  |rho| <= rhoMax? ${Math.abs(sviParams.rho) <= config.rhoMax}`);
  console.log(`  sLeft <= sMax? ${sLeft <= config.sMax}`);
  console.log(`  sRight <= sMax? ${sRight <= config.sMax}`);
  
  await prisma.$disconnect();
}

main().catch(console.error);
