/**
 * Test SVI Calibration with real market data
 */
import { PrismaClient } from "@prisma/client";
import { calibrateSVI } from "../volModels/sviCalibration";
import { SVI } from "../volModels/dualSurfaceModel";

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
  console.log("🎯 SVI Calibration Test\n");
  
  const prisma = new PrismaClient();
  await prisma.$connect();
  
  // Get BTC forward
  const btcPerp = await prisma.ticker.findFirst({
    where: { instrument: "BTC-PERPETUAL" },
    orderBy: { tsMs: "desc" }
  });
  const forward = btcPerp?.markPrice ?? 109000;
  console.log(`BTC Forward: ${forward}\n`);
  
  // Get all BTC-17OCT25 options with valid IVs
  const tickers = await prisma.ticker.findMany({
    where: {
      instrument: { contains: "BTC-17OCT25" },
      markIV: { not: null },
      bid: { not: null },
      ask: { not: null }
    },
    orderBy: { tsMs: "desc" }
  });
  
  // Get latest quote for each instrument
  const latestByInstrument = new Map();
  for (const t of tickers) {
    if (!latestByInstrument.has(t.instrument)) {
      latestByInstrument.set(t.instrument, t);
    }
  }
  
  // Extract market smile points
  const marketPoints = Array.from(latestByInstrument.values())
    .map(t => {
      const parts = t.instrument.split('-');
      const strike = parseFloat(parts[2]);
      const iv = (t.markIV ?? 0) / 100;  // Convert from % to decimal
      return { strike, iv };
    })
    .filter(p => p.iv > 0.01 && p.iv < 2.0)  // Filter out bad data
    .sort((a, b) => a.strike - b.strike);
  
  console.log(`Found ${marketPoints.length} market points:\n`);
  marketPoints.forEach(p => {
    const moneyness = (p.strike / forward * 100 - 100).toFixed(1);
    console.log(`  K=${p.strike.toString().padStart(6)} (${moneyness.padStart(5)}%) IV=${(p.iv*100).toFixed(2)}%`);
  });
  
  // Calculate time to expiry
  const expiryMs = parseExpiry(latestByInstrument.values().next().value.instrument);
  const T = Math.max((expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000), 0.001);
  console.log(`\nTime to expiry: ${T.toFixed(4)} years (${(T*365).toFixed(1)} days)\n`);
  
  // Calibrate SVI
  const config = {
    bMin: 1e-6,
    sigmaMin: 1e-6,
    rhoMax: 0.995,
    sMax: 5.0,
    c0Min: 0.01
  };
  
  console.log("Calibrating SVI...\n");
  const sviParams = calibrateSVI(marketPoints, forward, T, config);
  
  console.log("Calibrated SVI Parameters:");
  console.log(`  a     = ${sviParams.a.toFixed(6)}`);
  console.log(`  b     = ${sviParams.b.toFixed(6)}`);
  console.log(`  rho   = ${sviParams.rho.toFixed(6)}`);
  console.log(`  sigma = ${sviParams.sigma.toFixed(6)}`);
  console.log(`  m     = ${sviParams.m.toFixed(6)}`);
  
  const L0 = sviParams.a + sviParams.b * sviParams.sigma;
  const atmIV = Math.sqrt(L0 / T);
  console.log(`\nImplied ATM IV: ${(atmIV*100).toFixed(2)}%`);
  
  // Compare fitted vs market
  console.log("\nFit Quality:");
  console.log("Strike      Market IV   Fitted IV   Error");
  console.log("------      ---------   ---------   -----");
  
  let totalError = 0;
  for (const p of marketPoints) {
    const k = Math.log(p.strike / forward);
    const w = SVI.w(sviParams, k);
    const fittedIV = Math.sqrt(w / T);
    const error = (fittedIV - p.iv) * 100;
    totalError += Math.abs(error);
    
    console.log(
      `${p.strike.toString().padStart(6)}      ` +
      `${(p.iv*100).toFixed(2)}%       ` +
      `${(fittedIV*100).toFixed(2)}%      ` +
      `${error >= 0 ? '+' : ''}${error.toFixed(2)}%`
    );
  }
  
  const avgError = totalError / marketPoints.length;
  console.log(`\nAverage absolute error: ${avgError.toFixed(2)}%`);
  
  await prisma.$disconnect();
}

main().catch(console.error);
