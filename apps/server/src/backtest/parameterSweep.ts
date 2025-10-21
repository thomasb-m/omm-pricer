#!/usr/bin/env ts-node
/**
 * Parameter Sweep for Target Curve Pricing
 * 
 * Tests different combinations of rScale, S_policy, and alphaPC
 * to find optimal balance between participation and tracking error
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

interface SweepConfig {
  rScale: number;
  S_policy: number;
  alphaPC: number;
}

interface SweepResult extends SweepConfig {
  participation: number;
  medianTracking: number;
  p95Tracking: number;
  avgFillEdge: number;
  fillLots: number;
  avgBidSize: number;
  avgAskSize: number;
}

const configs: SweepConfig[] = [
  // GPT's recommended sweep
  { rScale: 10, S_policy: 20,  alphaPC: 0.10 },
  { rScale: 8,  S_policy: 20,  alphaPC: 0.10 },
  { rScale: 8,  S_policy: 50,  alphaPC: 0.10 },
  { rScale: 6,  S_policy: 50,  alphaPC: 0.10 },
  { rScale: 6,  S_policy: 50,  alphaPC: 0.00 },
  
  // Additional sweet spot search
  { rScale: 8,  S_policy: 100, alphaPC: 0.10 },
  { rScale: 7,  S_policy: 50,  alphaPC: 0.10 },
  { rScale: 7,  S_policy: 100, alphaPC: 0.10 },
];

function updateReplayConfig(cfg: SweepConfig): void {
  const filePath = 'apps/server/src/backtest/runReplay.ts';
  let content = fs.readFileSync(filePath, 'utf-8');
  
  // Replace config values
  content = content.replace(
    /rScale:\s*[\d.]+/,
    `rScale: ${cfg.rScale}`
  );
  content = content.replace(
    /S_policy:\s*\d+/,
    `S_policy: ${cfg.S_policy}`
  );
  content = content.replace(
    /alphaPC:\s*[\d.]+/,
    `alphaPC: ${cfg.alphaPC}`
  );
  
  fs.writeFileSync(filePath, content);
}

function parseMetricsOutput(output: string): Partial<SweepResult> {
  const lines = output.split('\n');
  
  const result: Partial<SweepResult> = {};
  
  for (const line of lines) {
    if (line.includes('Participation rate:')) {
      const match = line.match(/([\d.]+)%/);
      if (match) result.participation = parseFloat(match[1]);
    }
    if (line.includes('Median:') && line.includes('lots')) {
      const match = line.match(/([\d.]+) lots/);
      if (match) result.medianTracking = parseFloat(match[1]);
    }
    if (line.includes('95th percentile:')) {
      const match = line.match(/([\d.]+) lots/);
      if (match) result.p95Tracking = parseFloat(match[1]);
    }
    if (line.includes('Average:') && line.includes('bps')) {
      const match = line.match(/([-\d.]+) bps/);
      if (match) result.avgFillEdge = parseFloat(match[1]);
    }
    if (line.includes('Fill lots:')) {
      const match = line.match(/Fill lots:\s+(\d+)/);
      if (match) result.fillLots = parseInt(match[1]);
    }
    if (line.includes('Avg bid size:')) {
      const match = line.match(/([\d.]+) lots/);
      if (match) result.avgBidSize = parseFloat(match[1]);
    }
    if (line.includes('Avg ask size:')) {
      const match = line.match(/([\d.]+) lots/);
      if (match) result.avgAskSize = parseFloat(match[1]);
    }
  }
  
  return result;
}

function runSweep(): SweepResult[] {
  const results: SweepResult[] = [];
  
  console.log('\n' + '='.repeat(70));
  console.log('PARAMETER SWEEP - TARGET CURVE PRICING');
  console.log('='.repeat(70));
  console.log(`Testing ${configs.length} configurations...\n`);
  
  // Generate tape once
  console.log('📊 Generating tape data...');
  execSync('npx ts-node apps/server/src/backtest/generateTape.ts 1000 data/tape.ndjson', {
    stdio: 'inherit'
  });
  
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    
    console.log(`\n[${i + 1}/${configs.length}] Testing: rScale=${cfg.rScale}, S_policy=${cfg.S_policy}, α=${cfg.alphaPC}`);
    
    // Update config
    updateReplayConfig(cfg);
    
    // Run replay
    console.log('  Running replay...');
    execSync('npx ts-node apps/server/src/backtest/runReplay.ts data/tape.ndjson out/replay.csv', {
      stdio: 'pipe'
    });
    
    // Analyze
    console.log('  Analyzing metrics...');
    const output = execSync('npx ts-node apps/server/src/backtest/analyzeReplay.ts out/replay.csv', {
      encoding: 'utf-8'
    });
    
    const metrics = parseMetricsOutput(output);
    
    const result: SweepResult = {
      ...cfg,
      participation: metrics.participation || 0,
      medianTracking: metrics.medianTracking || 0,
      p95Tracking: metrics.p95Tracking || 0,
      avgFillEdge: metrics.avgFillEdge || 0,
      fillLots: metrics.fillLots || 0,
      avgBidSize: metrics.avgBidSize || 0,
      avgAskSize: metrics.avgAskSize || 0
    };
    
    results.push(result);
    
    console.log(`  ✓ Part: ${result.participation.toFixed(2)}%, Track: ${result.medianTracking.toFixed(2)}, Edge: ${result.avgFillEdge.toFixed(2)}bps`);
  }
  
  return results;
}

function printSummary(results: SweepResult[]): void {
  console.log('\n' + '='.repeat(70));
  console.log('SWEEP RESULTS SUMMARY');
  console.log('='.repeat(70));
  console.log();
  
  // Table header
  console.log('rScale  S_pol  α     Part%  Med.Track  P95.Track  Edge(bps)  FillLots  AvgSz');
  console.log('-'.repeat(70));
  
  // Sort by participation descending
  const sorted = [...results].sort((a, b) => b.participation - a.participation);
  
  for (const r of sorted) {
    const trackOk = r.medianTracking <= r.S_policy / 4 ? '✓' : '✗';
    const edgeOk = r.avgFillEdge >= 0 ? '✓' : '✗';
    
    console.log(
      `${r.rScale.toString().padStart(6)}  ` +
      `${r.S_policy.toString().padStart(5)}  ` +
      `${r.alphaPC.toFixed(2)}  ` +
      `${r.participation.toFixed(2).padStart(5)}  ` +
      `${r.medianTracking.toFixed(2).padStart(9)} ${trackOk}  ` +
      `${r.p95Tracking.toFixed(2).padStart(9)}  ` +
      `${r.avgFillEdge.toFixed(2).padStart(9)} ${edgeOk}  ` +
      `${r.fillLots.toString().padStart(8)}  ` +
      `${((r.avgBidSize + r.avgAskSize) / 2).toFixed(1).padStart(5)}`
    );
  }
  
  console.log();
  console.log('Legend:');
  console.log('  ✓ Med.Track: Median tracking error ≤ S_policy/4');
  console.log('  ✓ Edge: Fill edge ≥ 0 (not adversely selected)');
  console.log();
  
  // Find best config
  const best = sorted.find(r => 
    r.participation >= 10 && 
    r.medianTracking <= r.S_policy / 4 &&
    r.avgFillEdge >= 0
  );
  
  if (best) {
    console.log('🎯 RECOMMENDED CONFIG:');
    console.log(`   rScale = ${best.rScale}, S_policy = ${best.S_policy}, α = ${best.alphaPC}`);
    console.log(`   Achieves ${best.participation.toFixed(2)}% participation with ${best.medianTracking.toFixed(2)} lot tracking error`);
  } else {
    console.log('⚠️  No config met all targets (≥10% participation, tight tracking, non-negative edge)');
    console.log('   Consider: increase S_policy or reduce rScale');
  }
  
  console.log('\n' + '='.repeat(70) + '\n');
}

function saveToCsv(results: SweepResult[], filename: string): void {
  const header = 'rScale,S_policy,alphaPC,participation,medianTracking,p95Tracking,avgFillEdge,fillLots,avgBidSize,avgAskSize\n';
  const rows = results.map(r => 
    `${r.rScale},${r.S_policy},${r.alphaPC},${r.participation},${r.medianTracking},${r.p95Tracking},${r.avgFillEdge},${r.fillLots},${r.avgBidSize},${r.avgAskSize}`
  ).join('\n');
  
  fs.writeFileSync(filename, header + rows);
  console.log(`📁 Results saved to: ${filename}`);
}

// Main
if (require.main === module) {
  console.log('🚀 Starting parameter sweep...');
  console.log('   This will take ~5 minutes\n');
  
  const results = runSweep();
  printSummary(results);
  saveToCsv(results, 'out/sweep_results.csv');
  
  console.log('✅ Sweep complete!');
}