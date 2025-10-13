#!/usr/bin/env ts-node
/**
 * Analyze Replay Results
 * 
 * Computes key metrics from replay CSV:
 * - Participation rate
 * - Tracking error (Q vs Q*)
 * - Fill edge
 * - Size utilization
 */

import * as fs from 'fs';
import * as readline from 'readline';

interface ReplayRow {
  ts: number;
  CC: number;
  PC: number;
  r: number;
  Q: number;
  targetAtBid: number;
  targetAtAsk: number;
  sizeBid: number;
  sizeAsk: number;
  buyFill: number;
  sellFill: number;
  tradeSz?: number;
}

interface Metrics {
  totalTicks: number;
  totalFills: number;
  totalBuyFills: number;
  totalSellFills: number;
  totalTapeVolume: number;
  participationRate: number;
  
  trackingErrors: number[];
  medianTrackingError: number;
  p95TrackingError: number;
  
  fillEdges: number[];
  avgFillEdge: number;
  
  sizeUtilization: {
    avgBidUtil: number;
    avgAskUtil: number;
  };
  
  finalPosition: number;
}

function parseRow(line: string): ReplayRow | null {
  const parts = line.split(',');
  if (parts.length < 15) return null;
  
  return {
    ts: parseInt(parts[0]),
    CC: parseFloat(parts[3]),
    PC: parseFloat(parts[4]),
    r: parseFloat(parts[5]),
    Q: parseFloat(parts[10]),
    targetAtBid: parseFloat(parts[11]),
    targetAtAsk: parseFloat(parts[12]),
    sizeBid: parseInt(parts[8]),
    sizeAsk: parseInt(parts[9]),
    buyFill: parseInt(parts[17]) || 0,
    sellFill: parseInt(parts[18]) || 0,
    tradeSz: parts[16] ? parseInt(parts[16]) : undefined
  };
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

async function analyze(csvFile: string): Promise<Metrics> {
    const rl = readline.createInterface({
      input: fs.createReadStream(csvFile),
      crlfDelay: Infinity
    });
  
    let isHeader = true;
    let totalTicks = 0;
    let totalFillEvents = 0;      // ✅ Events (rows with fills)
    let totalBuyFills = 0;        // ✅ Lots bought
    let totalSellFills = 0;       // ✅ Lots sold
    let totalTapeVolume = 0;
    
    const trackingErrors: number[] = [];
    const fillEdges: number[] = [];
    let totalBidSize = 0;
    let totalAskSize = 0;
    let postedCount = 0;
    
    let lastCC = 0;
    let finalPosition = 0;
  
    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      
      const row = parseRow(line);
      if (!row) continue;
      
      totalTicks++;
      
      // Tracking error: |Q - Q*(PC)|
      const targetAtPC = -(row.PC - row.CC) / row.r;
      const trackingError = Math.abs(row.Q - targetAtPC);
      trackingErrors.push(trackingError);
      
      // Size utilization
      if (row.sizeBid > 0 || row.sizeAsk > 0) {
        totalBidSize += row.sizeBid;
        totalAskSize += row.sizeAsk;
        postedCount++;
      }
      
      // Fills - count both events and lots
      let hadFill = false;
      
      if (row.buyFill > 0) {
        totalBuyFills += row.buyFill;
        fillEdges.push(row.PC - lastCC);
        hadFill = true;
      }
      
      if (row.sellFill > 0) {
        totalSellFills += row.sellFill;
        fillEdges.push(row.PC - lastCC);
        hadFill = true;
      }
      
      if (hadFill) {
        totalFillEvents++;
      }
      
      // Tape volume
      if (row.tradeSz) {
        totalTapeVolume += row.tradeSz;
      }
      
      lastCC = row.CC;
      finalPosition = row.Q;
    }
  
    const totalFillLots = totalBuyFills + totalSellFills;
    const participationRate = totalTapeVolume > 0 
      ? totalFillLots / totalTapeVolume 
      : 0;
  
    return {
      totalTicks,
      totalFills: totalFillEvents,        // ✅ Events
      totalBuyFills,                       // ✅ Lots
      totalSellFills,                      // ✅ Lots
      totalTapeVolume,
      participationRate,
      
      trackingErrors,
      medianTrackingError: percentile(trackingErrors, 0.5),
      p95TrackingError: percentile(trackingErrors, 0.95),
      
      fillEdges,
      avgFillEdge: fillEdges.reduce((a, b) => a + b, 0) / (fillEdges.length || 1),
      
      sizeUtilization: {
        avgBidUtil: postedCount > 0 ? totalBidSize / postedCount : 0,
        avgAskUtil: postedCount > 0 ? totalAskSize / postedCount : 0
      },
      
      finalPosition
    };
  }

  function printMetrics(m: Metrics): void {
    console.log('\n' + '='.repeat(60));
    console.log('REPLAY METRICS ANALYSIS');
    console.log('='.repeat(60));
    
    console.log('\n📊 VOLUME METRICS');
    console.log(`Total ticks:          ${m.totalTicks}`);
    console.log(`Fill events:          ${m.totalFills}`);
    console.log(`Fill lots:            ${m.totalBuyFills + m.totalSellFills}`);
    console.log(`  Buy lots:           ${m.totalBuyFills}`);
    console.log(`  Sell lots:          ${m.totalSellFills}`);
    console.log(`Tape volume:          ${m.totalTapeVolume} lots`);
    console.log(`Participation rate:   ${(m.participationRate * 100).toFixed(2)}%`);
    
    console.log('\n📈 TRACKING ERROR (|Q - Q*(PC)|)');
    console.log(`Median:               ${m.medianTrackingError.toFixed(2)} lots`);
    console.log(`95th percentile:      ${m.p95TrackingError.toFixed(2)} lots`);
    
    console.log('\n💰 FILL EDGE (PC - CC)');
    console.log(`Average:              ${(m.avgFillEdge * 10000).toFixed(2)} bps`);
    console.log(`Total edge events:    ${m.fillEdges.length}`);
    
    console.log('\n📏 SIZE UTILIZATION');
    console.log(`Avg bid size:         ${m.sizeUtilization.avgBidUtil.toFixed(1)} lots`);
    console.log(`Avg ask size:         ${m.sizeUtilization.avgAskUtil.toFixed(1)} lots`);
    
    console.log('\n🎯 FINAL STATE');
    console.log(`Final position:       ${m.finalPosition} lots`);
    
    console.log('\n' + '='.repeat(60) + '\n');
  }

// CLI
if (require.main === module) {
  const [,, csvFile] = process.argv;
  
  if (!csvFile) {
    console.error('Usage: ts-node analyzeReplay.ts <replay.csv>');
    process.exit(1);
  }

  analyze(csvFile)
    .then(metrics => {
      printMetrics(metrics);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}