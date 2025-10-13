#!/usr/bin/env ts-node
/**
 * Generate Synthetic Tape Data for Backtesting
 * 
 * Creates realistic market data with trades for testing target curve pricing
 */

import * as fs from 'fs';

interface TapeTick {
  ts: number;
  bid: number;
  ask: number;
  tradePx?: number;
  tradeSz?: number;
  tenor?: string;
  strike?: number;
  depthBid?: number;
  depthAsk?: number;
}

function generateTape(
  numTicks: number,
  outputFile: string
): void {
  const out = fs.createWriteStream(outputFile, { flags: 'w' });

  // BTC option parameters (matching your test)
  const strike = 111000;
  const tenor = '7d';
  const midStart = 0.0233;  // Starting fair value
  const spread = 0.0003;    // 3 bps spread
  
  let currentMid = midStart;
  let currentPosition = 0;
  let ts = Date.now();

  console.log(`Generating ${numTicks} ticks...`);

  for (let i = 0; i < numTicks; i++) {
    // Random walk for mid (small moves)
    const drift = (Math.random() - 0.5) * 0.0001;
    currentMid = Math.max(0.01, currentMid + drift);

    const bid = currentMid - spread / 2;
    const ask = currentMid + spread / 2;

    // Generate trade 20% of the time
    let tradePx: number | undefined;
    let tradeSz: number | undefined;
    let depthBid: number | undefined;
    let depthAsk: number | undefined;

    if (Math.random() < 0.2) {
      // Trade occurs
      const isBuy = Math.random() > 0.5;
      
      if (isBuy) {
        // Customer buys (hits our ask)
        tradePx = ask;
        tradeSz = Math.floor(Math.random() * 50) + 10;  // 10-60 lots
        depthAsk = Math.floor(Math.random() * 200) + 100;  // 100-300 lots depth
      } else {
        // Customer sells (hits our bid)
        tradePx = bid;
        tradeSz = Math.floor(Math.random() * 50) + 10;
        depthBid = Math.floor(Math.random() * 200) + 100;
      }
    }

    const tick: TapeTick = {
      ts,
      bid: Math.round(bid * 1e6) / 1e6,
      ask: Math.round(ask * 1e6) / 1e6,
      tradePx: tradePx ? Math.round(tradePx * 1e6) / 1e6 : undefined,
      tradeSz,
      tenor,
      strike,
      depthBid,
      depthAsk
    };

    out.write(JSON.stringify(tick) + '\n');

    // Advance time by 1-10 seconds
    ts += Math.floor(Math.random() * 9000) + 1000;
  }

  out.end();

  console.log(`✅ Generated ${numTicks} ticks`);
  console.log(`📁 Output: ${outputFile}`);
  console.log(`📊 Starting mid: ${midStart.toFixed(6)}`);
  console.log(`📊 Ending mid: ${currentMid.toFixed(6)}`);
}

// CLI
if (require.main === module) {
  const [,, numTicksStr, outFile] = process.argv;
  
  if (!numTicksStr || !outFile) {
    console.error('Usage: ts-node generateTape.ts <numTicks> <output.ndjson>');
    console.error('Example: ts-node generateTape.ts 1000 data/tape.ndjson');
    process.exit(1);
  }

  const numTicks = parseInt(numTicksStr, 10);
  
  if (isNaN(numTicks) || numTicks <= 0) {
    console.error('Error: numTicks must be a positive integer');
    process.exit(1);
  }

  // Ensure directory exists
  const dir = outFile.substring(0, outFile.lastIndexOf('/'));
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  generateTape(numTicks, outFile);
}