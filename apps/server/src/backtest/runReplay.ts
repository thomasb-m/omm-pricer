#!/usr/bin/env ts-node
/**
 * Replay Harness for Target Curve Pricing
 * WITH Snapper + CC Micro-Alpha
 * 
 * Simulates fills from historical tape and validates pricing behavior
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { 
  computeTargetCurvePricing,
  type TargetCurvePricingInput,
  type TargetCurvePricingOutput
} from '../volModels/inventory/targetCurvePricing';
import { updatePCOnFill, type FillSide } from '../volModels/inventory/pcUpdate';
import { snapToBook } from '../pricing/snapper';
import { computeCCAlpha } from '../pricing/ccAlpha';

// ============================================================
// TYPES
// ============================================================

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

interface ReplayConfig {
  tick: number;
  hBase: number;
  S_policy: number;
  S_max: number;
  rScale: number;
  alphaPC: number;
  queueFillShare: number;
  
  // Snapper config
  snapperPolicy: 'join' | 'smart';
  stepFrac: number;
  minStepLots: number;
  edgeStepMinTicks: number;
  cooldownMs: number;
  makerFee: number;
  minNotional: number;
  
  // Alpha config
  enableAlpha: boolean;
  alphaK: number;
  alphaMaxTicks: number;
}

interface SimState {
  Q: number;
  CC: number;
  PC: number | null;
  r: number;
  lastQuote?: TargetCurvePricingOutput;
  filledBuy: number;
  filledSell: number;
  filledNotional: number;
  lastBidUpdateMs: number;
  lastAskUpdateMs: number;
}

interface CsvRow {
  ts: number;
  tenor?: string;
  strike?: number;
  CC: number;
  PC: number;
  r: number;
  bid: number;
  ask: number;
  sizeBid: number;
  sizeAsk: number;
  Q: number;
  targetAtBid: number;
  targetAtAsk: number;
  willingnessBid: number;
  willingnessAsk: number;
  tradePx?: number;
  tradeSz?: number;
  buyFill: number;
  sellFill: number;
  participation?: number;
  bidAction?: string;
  askAction?: string;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function computeCCFromTape(t: TapeTick): number {
  return (t.bid + t.ask) / 2;
}

function passiveFillAtPrice(
  tradeSz: number,
  ourSize: number,
  depthOnSide?: number,
  fillShare: number = 0.5
): number {
  if (!tradeSz || ourSize <= 0) return 0;
  
  const depth = Math.max(ourSize, depthOnSide ?? ourSize);
  const share = Math.min(1, ourSize / depth) * fillShare;
  
  return Math.floor(tradeSz * share);
}

// ============================================================
// MAIN REPLAY FUNCTION
// ============================================================

async function runReplay(
  inputNdjson: string,
  outputCsv: string,
  cfg: ReplayConfig,
  init: SimState
): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(inputNdjson),
    crlfDelay: Infinity
  });

  const out = fs.createWriteStream(outputCsv, { flags: 'w' });
  
  // Write CSV header
  out.write([
    'ts', 'tenor', 'strike', 'CC', 'PC', 'r',
    'bid', 'ask', 'sizeBid', 'sizeAsk',
    'Q', 'targetAtBid', 'targetAtAsk', 'willingnessBid', 'willingnessAsk',
    'tradePx', 'tradeSz', 'buyFill', 'sellFill', 'participation',
    'bidAction', 'askAction'
  ].join(',') + '\n');

  let s: SimState = { ...init };
  let tickCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    
    try {
      const t: TapeTick = JSON.parse(line);
      tickCount++;

      // ========================================================
      // STEP 1: CC MICRO-ALPHA NUDGE (if enabled)
      // ========================================================
      let CC = computeCCFromTape(t);
      
      if (cfg.enableAlpha && t.depthBid && t.depthAsk) {
        const alphaResult = computeCCAlpha({
          bid: t.bid,
          ask: t.ask,
          depthBid: t.depthBid,
          depthAsk: t.depthAsk,
          ofiZ: 0,
          k: cfg.alphaK,
          maxClipTicks: cfg.alphaMaxTicks,
          rvZ: 0
        });
        
        CC += alphaResult.deltaPrice;
      }

      // ========================================================
      // STEP 2: PC GRAVITY (continuous recentering)
      // ========================================================
      const rRaw = s.r * cfg.rScale;
      const pc0 = s.PC ?? CC;
      const pcTarget = CC - rRaw * s.Q;
      const PC = (1 - cfg.alphaPC) * pc0 + cfg.alphaPC * pcTarget;

      // ========================================================
      // STEP 3: GENERATE BASE QUOTE (target curve)
      // ========================================================
      const quote = computeTargetCurvePricing({
        ccMid: CC,
        pcMid: PC,
        currentPosition: s.Q,
        costPerLot: rRaw,
        minTick: cfg.tick,
        halfSpread: cfg.hBase,
        policySize: cfg.S_policy,
        maxSize: cfg.S_max
      });

      // ========================================================
      // STEP 4: SNAP TO BOOK (join/step-ahead)
      // ========================================================
      const alphaMicro = 0;
      
      const bidSnap = snapToBook({
        side: 'bid',
        modelPrice: quote.bid,
        displayLots: quote.bidSize,
        replenishLots: quote.replenishBid,
        bestPrice: t.bid,
        queueDepth: t.depthBid,
        CC,
        tick: cfg.tick,
        makerFee: cfg.makerFee,
        alphaMicro,
        rvZ: 0,
        policy: cfg.snapperPolicy,
        stepFrac: cfg.stepFrac,
        minStepLots: cfg.minStepLots,
        edgeStepMinTicks: cfg.edgeStepMinTicks,
        minNotional: cfg.minNotional,
        lastUpdateMs: s.lastBidUpdateMs,
        nowMs: t.ts,
        cooldownMs: cfg.cooldownMs
      });

      const askSnap = snapToBook({
        side: 'ask',
        modelPrice: quote.ask,
        displayLots: quote.askSize,
        replenishLots: quote.replenishAsk,
        bestPrice: t.ask,
        queueDepth: t.depthAsk,
        CC,
        tick: cfg.tick,
        makerFee: cfg.makerFee,
        alphaMicro,
        rvZ: 0,
        policy: cfg.snapperPolicy,
        stepFrac: cfg.stepFrac,
        minStepLots: cfg.minStepLots,
        edgeStepMinTicks: cfg.edgeStepMinTicks,
        minNotional: cfg.minNotional,
        lastUpdateMs: s.lastAskUpdateMs,
        nowMs: t.ts,
        cooldownMs: cfg.cooldownMs
      });

      // Final prices and sizes from snapper
      const finalBid = bidSnap.price;
      const finalAsk = askSnap.price;
      const finalBidSize = bidSnap.displayLots;
      const finalAskSize = askSnap.displayLots;

      // ========================================================
      // STEP 5: SIMULATE FILLS
      // ========================================================
      let buyFill = 0;
      let sellFill = 0;
      let participation: number | undefined;

      if (t.tradePx !== undefined && t.tradeSz) {
        if (t.tradePx <= finalBid) {
          buyFill = Math.min(finalBidSize, t.tradeSz);
        } else if (t.tradePx >= finalAsk) {
          sellFill = Math.min(finalAskSize, t.tradeSz);
        } else if (t.tradePx === finalBid) {
          buyFill = passiveFillAtPrice(t.tradeSz, finalBidSize, t.depthBid, cfg.queueFillShare);
        } else if (t.tradePx === finalAsk) {
          sellFill = passiveFillAtPrice(t.tradeSz, finalAskSize, t.depthAsk, cfg.queueFillShare);
        }

        if (t.depthBid && t.tradePx === finalBid && finalBidSize > 0) {
          participation = Math.min(1, finalBidSize / t.depthBid);
        }
        if (t.depthAsk && t.tradePx === finalAsk && finalAskSize > 0) {
          participation = Math.min(1, finalAskSize / t.depthAsk);
        }
      }

      // ========================================================
      // STEP 6: APPLY FILLS WITH CONTINUOUS PC UPDATE
      // ========================================================
      if (buyFill > 0) {
        const update = updatePCOnFill({
          pc: PC,
          cc: CC,
          r: rRaw,
          Q: s.Q,
          side: 'bid',
          price: finalBid,
          postedSize: finalBidSize,
          fillSize: buyFill,
          kTrade: 1.0,
          gamma: 1.0,
          alphaInv: 0.1
        });
        
        s.Q = update.QAfter;
        s.PC = update.pcAfter;
        s.filledBuy += buyFill;
        s.filledNotional += buyFill * (t.tradePx ?? finalBid);
      }
      
      if (sellFill > 0) {
        const update = updatePCOnFill({
          pc: PC,
          cc: CC,
          r: rRaw,
          Q: s.Q,
          side: 'ask',
          price: finalAsk,
          postedSize: finalAskSize,
          fillSize: sellFill,
          kTrade: 1.0,
          gamma: 1.0,
          alphaInv: 0.1
        });
        
        s.Q = update.QAfter;
        s.PC = update.pcAfter;
        s.filledSell += sellFill;
        s.filledNotional += sellFill * (t.tradePx ?? finalAsk);
      }
      
      if (!buyFill && !sellFill) {
        s.PC = PC;
      }

      // Update snapper timestamps
      if (bidSnap.action !== 'skip') {
        s.lastBidUpdateMs = t.ts;
      }
      if (askSnap.action !== 'skip') {
        s.lastAskUpdateMs = t.ts;
      }

      // ========================================================
      // STEP 7: WRITE CSV ROW
      // ========================================================
      const row: CsvRow = {
        ts: t.ts,
        tenor: t.tenor,
        strike: t.strike,
        CC,
        PC: s.PC ?? CC,
        r: rRaw,
        bid: finalBid,
        ask: finalAsk,
        sizeBid: finalBidSize,
        sizeAsk: finalAskSize,
        Q: s.Q,
        targetAtBid: quote.diagnostics.targetAtBid,
        targetAtAsk: quote.diagnostics.targetAtAsk,
        willingnessBid: quote.diagnostics.willingnessBid,
        willingnessAsk: quote.diagnostics.willingnessAsk,
        tradePx: t.tradePx,
        tradeSz: t.tradeSz,
        buyFill,
        sellFill,
        participation,
        bidAction: bidSnap.action,
        askAction: askSnap.action
      };

      out.write([
        row.ts, row.tenor ?? '', row.strike ?? '',
        row.CC.toFixed(6), row.PC.toFixed(6), row.r.toFixed(8),
        row.bid.toFixed(6), row.ask.toFixed(6), row.sizeBid, row.sizeAsk,
        row.Q, row.targetAtBid.toFixed(2), row.targetAtAsk.toFixed(2),
        row.willingnessBid.toFixed(2), row.willingnessAsk.toFixed(2),
        row.tradePx?.toFixed(6) ?? '', row.tradeSz ?? '',
        row.buyFill, row.sellFill, row.participation?.toFixed(3) ?? '',
        row.bidAction ?? '', row.askAction ?? ''
      ].join(',') + '\n');

      s.CC = CC;
      s.lastQuote = quote;

    } catch (err) {
      console.error(`Error processing line ${tickCount}:`, err);
    }
  }

  out.end();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('REPLAY SUMMARY');
  console.log('='.repeat(60));
  console.log(`Ticks processed: ${tickCount}`);
  console.log(`Fills: Buy=${s.filledBuy}, Sell=${s.filledSell}`);
  console.log(`Final position: ${s.Q} lots`);
  console.log(`Notional filled: ${s.filledNotional.toFixed(6)}`);
  console.log(`Output written to: ${outputCsv}`);
  console.log('='.repeat(60) + '\n');
}

// ============================================================
// CLI ENTRY POINT
// ============================================================

if (require.main === module) {
  const [,, inFile, outFile] = process.argv;
  
  if (!inFile || !outFile) {
    console.error('Usage: ts-node runReplay.ts <tape.ndjson> <out.csv>');
    process.exit(1);
  }

  const cfg: ReplayConfig = {
    tick: 0.0001,
    hBase: 0.0001,
    S_policy: 10,
    S_max: 1000,
    rScale: 1.0,
    alphaPC: 0.1,
    queueFillShare: 0.5,
    
    // Snapper settings
    snapperPolicy: 'smart',     // 'join' or 'smart'
    stepFrac: 0.25,
    minStepLots: 3,
    edgeStepMinTicks: 0.3,
    cooldownMs: 100,
    makerFee: -0.00002,
    minNotional: 0.0001,
    
    // Alpha settings
    enableAlpha: true,          // Set to false to disable
    alphaK: 0.05,
    alphaMaxTicks: 0.5
  };

  const init: SimState = {
    Q: 0,
    CC: 0,
    PC: null,
    r: 0.0001 / 10,  // r = h / s₀
    filledBuy: 0,
    filledSell: 0,
    filledNotional: 0,
    lastBidUpdateMs: 0,
    lastAskUpdateMs: 0
  };

  runReplay(inFile, outFile, cfg, init).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}