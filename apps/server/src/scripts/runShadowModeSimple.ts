#!/usr/bin/env ts-node
/**
 * Shadow Mode - Full Smile Real Market Data
 */

process.env.USE_PC_FIT = 'true';

import WebSocket from 'ws';
import { IntegratedSmileModel } from '../volModels/integratedSmileModel';
import { initConfigManager } from '../config/configManager';
import { initTradingController } from '../config/tradingController';
import { safeMid, toUSD } from '../utils/units';
import { getMarketSpec } from '../markets/index';

// Initialize
const cm = initConfigManager();
const tc = initTradingController();
const ism = new IntegratedSmileModel('BTC');

console.log('='.repeat(60));
console.log('SHADOW MODE - FULL SMILE TEST');
console.log('='.repeat(60));
// console.log('Config:', cm.getSummary());
console.log('Mode:', tc.getMode().mode);
console.log();

// Connect to Deribit
const ws = new WebSocket('wss://test.deribit.com/ws/api/v2');

// Near-term expiry (about 1 week out)
const EXPIRY_DATE = '24OCT25';  // ~1 week from now
const EXPIRY_MS = new Date('2025-10-24').getTime();

// Track market data
const marketData = new Map<number, {
  iv: number;
  midNorm: number;
  midUSD: number;
  bidNorm?: number;
  askNorm?: number;
  bidUSD?: number;
  askUSD?: number;
}>();
let spot = 100000;  // Will update from index
let tickCount = 0;
let calibrated = false;
let finished = false;

const DATA_WINDOW_MS = 60_000;
const MAX_WAIT_FOR_DATA_MS = 180_000;
let stopTimer: NodeJS.Timeout | null = null;
let fallbackTimer: NodeJS.Timeout | null = null;
let subscribeTemplateIndex = 0;
let pendingSubscribeNames: string[] = [];
const CHANNEL_TEMPLATES = ['raw', '100ms'];
const SUB_CHUNK = 40;
let nextRpcId = 10;
const pendingSubscribeBatches = new Map<number, { template: string; channels: string[] }>();
const failedSubscriptions = new Set<string>();
let lastSnapshotTick = 0;
const SNAPSHOT_TICK_INTERVAL = 200;
const marketSpec = getMarketSpec('BTC');
const MARKET_TICK_NORM = marketSpec.minTick;

function startFallbackTimer() {
  if (!fallbackTimer) {
    fallbackTimer = setTimeout(() => {
      finish('⚠️ Timeout waiting for market data');
    }, MAX_WAIT_FOR_DATA_MS);
  }
}

function cancelFallbackTimer() {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function scheduleStopTimer() {
  if (!stopTimer) {
    stopTimer = setTimeout(() => finish(), DATA_WINDOW_MS);
  }
}

function resetStopTimer() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  scheduleStopTimer();
}

function finish(reason?: string) {
  if (finished) return;
  finished = true;

  if (stopTimer) clearTimeout(stopTimer);
  if (fallbackTimer) clearTimeout(fallbackTimer);

  console.log('\n' + '='.repeat(60));
  if (reason) {
    console.log(reason);
  }
  console.log(`COMPLETE! Processed ${tickCount} ticks across ${marketData.size} strikes`);
  console.log('='.repeat(60));
  if (failedSubscriptions.size > 0) {
    const sample = Array.from(failedSubscriptions).slice(0, 10);
    console.warn(
      `[Deribit] Failed to subscribe to ${failedSubscriptions.size} instruments: ${sample.join(', ')}${
        failedSubscriptions.size > sample.length ? ', ...' : ''
      }`
    );
  }
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
  process.exit(0);
}

function sendRpc(method: string, params: Record<string, unknown>, id?: number): number {
  const rpcId = typeof id === 'number' ? id : nextRpcId++;
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }));
  return rpcId;
}

function requestNextSubscribeBatch() {
  if (pendingSubscribeNames.length === 0) return;

  const template = CHANNEL_TEMPLATES[subscribeTemplateIndex];
  const chunk = pendingSubscribeNames.splice(0, SUB_CHUNK);
  if (chunk.length === 0) return;

  const channels = chunk.map((name) => `ticker.${name}.${template}`);
  console.log(
    `[Deribit] Subscribing to ${channels.length} channels using template "${template}" (remaining=${pendingSubscribeNames.length})`
  );
  const id = sendRpc('public/subscribe', { channels });
  pendingSubscribeBatches.set(id, { template, channels });
}

function extractSubscribedChannels(result: any): string[] {
  if (!result) return [];
  if (Array.isArray(result.subscriptions)) return result.subscriptions;
  if (Array.isArray(result.subscribe)) return result.subscribe;
  if (Array.isArray(result.channels)) return result.channels;
  if (typeof result === 'object' && result !== null) {
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) {
        return value.filter((v) => typeof v === 'string') as string[];
      }
    }
  }
  return [];
}

function instrumentFromChannel(channel: string): string {
  const parts = channel.split('.');
  return parts.length >= 3 ? parts[1] : channel;
}

function logModelVsMarketSnapshot(label: string) {
  const strikes = Array.from(marketData.keys()).sort((a, b) => a - b);
  if (strikes.length === 0) {
    console.log(`[${label}] No market data cached yet, skipping snapshot.`);
    return;
  }

  const rows: Array<{
    strike: number;
    marketMidNorm: number;
    marketMidUSD: number;
    marketBidNorm?: number;
    marketAskNorm?: number;
    marketBidUSD?: number;
    marketAskUSD?: number;
    modelMidNorm: number;
    modelMidUSD: number;
    modelBidNorm: number;
    modelAskNorm: number;
    modelBidUSD: number;
    modelAskUSD: number;
    ccMidNorm: number;
    diffNorm: number;
    diffBps: number;
  }> = [];
  const errors: string[] = [];

  for (const strike of strikes) {
    const data = marketData.get(strike);
    if (!data) continue;

    try {
      const quote = ism.getQuote(
        EXPIRY_MS,
        strike,
        spot,
        'C',
        data.iv,
        Date.now()
      );
      const diff = quote.pcMid - data.midNorm;
      const scale = Math.max(data.midNorm, 1e-4);
      rows.push({
        strike,
        marketMidNorm: data.midNorm,
        marketMidUSD: data.midUSD,
        marketBidNorm: data.bidNorm,
        marketAskNorm: data.askNorm,
        marketBidUSD: data.bidUSD,
        marketAskUSD: data.askUSD,
        modelMidNorm: quote.pcMid,
        modelMidUSD: toUSD(quote.pcMid, spot),
        modelBidNorm: quote.bid,
        modelAskNorm: quote.ask,
        modelBidUSD: toUSD(quote.bid, spot),
        modelAskUSD: toUSD(quote.ask, spot),
        ccMidNorm: quote.ccMid,
        diffNorm: diff,
        diffBps: (diff / scale) * 1e4,
      });
    } catch (err: any) {
      errors.push(`${strike}: ${err?.message ?? err}`);
    }
  }

  if (rows.length === 0) {
    console.log(`[${label}] Unable to price any strikes yet.`);
    if (errors.length > 0) {
      console.warn(`[${label}] Pricing errors encountered: ${errors.join('; ')}`);
    }
    return;
  }

  console.log(`\n[${label}] Model vs Market snapshot (${rows.length} strikes, tick ${tickCount})`);
  const printable = rows.map((r) => ({
    strike: r.strike,
    market_mid_norm: r.marketMidNorm.toFixed(6),
    market_mid_usd: r.marketMidUSD.toFixed(2),
    market_bid_norm: r.marketBidNorm !== undefined ? r.marketBidNorm.toFixed(6) : '—',
    market_ask_norm: r.marketAskNorm !== undefined ? r.marketAskNorm.toFixed(6) : '—',
    market_bid_usd: r.marketBidUSD !== undefined ? r.marketBidUSD.toFixed(2) : '—',
    market_ask_usd: r.marketAskUSD !== undefined ? r.marketAskUSD.toFixed(2) : '—',
    model_mid_norm: r.modelMidNorm.toFixed(6),
    model_mid_usd: r.modelMidUSD.toFixed(2),
    model_bid_norm: r.modelBidNorm.toFixed(6),
    model_ask_norm: r.modelAskNorm.toFixed(6),
    model_bid_usd: r.modelBidUSD.toFixed(2),
    model_ask_usd: r.modelAskUSD.toFixed(2),
    cc_mid_norm: r.ccMidNorm.toFixed(6),
    diff_norm: r.diffNorm.toFixed(6),
    diff_bps: Number.isFinite(r.diffBps) ? r.diffBps.toFixed(1) : '—',
  }));
  console.table(printable);

  const meanAbs = rows.reduce((acc, r) => acc + Math.abs(r.diffBps), 0) / rows.length;
  const maxAbs = rows.reduce((acc, r) => Math.max(acc, Math.abs(r.diffBps)), 0);
  console.log(
    `  Avg |model-market| = ${meanAbs.toFixed(1)} bps, max = ${maxAbs.toFixed(1)} bps`
  );

  if (errors.length > 0) {
    console.warn(`[${label}] ${errors.length} strikes failed to price: ${errors.slice(0, 5).join('; ')}`);
  }
}

ws.on('open', () => {
  console.log('✅ Connected to Deribit\n');
  
  // First, get the index price
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'public/get_index_price',
    params: {
      index_name: 'btc_usd'
    }
  }));
  
  // Get all instruments for this expiry
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'public/get_instruments',
    params: {
      currency: 'BTC',
      kind: 'option',
      expired: false
    }
  }));
  
  startFallbackTimer();
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  const channel = msg.params?.channel;
  const payload = msg.params?.data;
  
  if (msg.error) {
    console.error('[Deribit] RPC error:', msg.error);
  }
  
  if (msg.method === 'heartbeat') {
    const hbType = msg.params?.type ?? 'unknown';
    console.log(`[Deribit] Heartbeat received (${hbType})`);
    sendRpc('public/test', {});
    return;
  }
  
  // Handle index price response
  if (msg.id === 1 && msg.result) {
    spot = msg.result.index_price;
    console.log(`📊 BTC Index: ${spot.toFixed(2)}\n`);
  }
  
  // Handle instruments list
  if (msg.id === 2 && msg.result) {
    const instruments = msg.result.filter((inst: any) => 
      inst.instrument_name.includes(`-${EXPIRY_DATE}-`) && 
      inst.instrument_name.endsWith('-C')  // Calls only for simplicity
    );
    
    console.log(`🎯 Found ${instruments.length} call options for ${EXPIRY_DATE}\n`);
    
    if (instruments.length === 0) {
      console.error('❌ No instruments found for this expiry. Try a different date.');
      process.exit(1);
    }
    
    pendingSubscribeNames = instruments.map((inst: any) => inst.instrument_name);
    subscribeTemplateIndex = 0;
    pendingSubscribeBatches.clear();
    const strikes = instruments
      .map((inst: any) => parseInt(inst.instrument_name.split('-')[2], 10))
      .filter((n: number) => Number.isFinite(n))
      .sort((a: number, b: number) => a - b);
    if (strikes.length > 0) {
      console.log(
        `[universe] ${instruments.length} calls | strikes ${strikes[0]}–${strikes[strikes.length - 1]}`
      );
    }
    console.log(`📡 Preparing subscriptions for ${pendingSubscribeNames.length} instruments...\n`);
    requestNextSubscribeBatch();
  }

  if (typeof msg.id === 'number' && pendingSubscribeBatches.has(msg.id)) {
    const batch = pendingSubscribeBatches.get(msg.id)!;
    pendingSubscribeBatches.delete(msg.id);

    const rawResult = msg.result ?? {};
    const subscriptions = extractSubscribedChannels(rawResult);
    const successFlag = Boolean(rawResult?.success);
    const effectiveSubscriptions =
      subscriptions.length > 0
        ? subscriptions
        : successFlag
        ? batch.channels
        : [];
    console.log(
      `✅ Subscription response (${batch.template}): requested=${batch.channels.length}, accepted=${effectiveSubscriptions.length}`
    );

    if (effectiveSubscriptions.length === 0) {
      console.warn('[Deribit] Subscription result payload:', rawResult);
    }

    const acceptedSet = new Set(effectiveSubscriptions);
    const missing = batch.channels
      .filter((ch) => !acceptedSet.has(ch))
      .map(instrumentFromChannel);

    if (effectiveSubscriptions.length === 0 && subscribeTemplateIndex < CHANNEL_TEMPLATES.length - 1) {
      pendingSubscribeNames = Array.from(new Set([...pendingSubscribeNames, ...missing]));
      subscribeTemplateIndex++;
      const fallbackTemplate = CHANNEL_TEMPLATES[subscribeTemplateIndex];
      console.warn(
        `[Deribit] No channels accepted for template "${batch.template}". Falling back to "${fallbackTemplate}".`
      );
      pendingSubscribeBatches.clear();
      requestNextSubscribeBatch();
      return;
    } else if (effectiveSubscriptions.length === 0) {
      missing.forEach((name) => failedSubscriptions.add(name));
    } else if (missing.length > 0) {
      pendingSubscribeNames = Array.from(new Set([...pendingSubscribeNames, ...missing]));
    }

    if (pendingSubscribeBatches.size === 0 && pendingSubscribeNames.length > 0) {
      requestNextSubscribeBatch();
    }
  }
  
  // Handle ticker updates
  if ((msg.method === 'subscription' || channel?.includes('ticker')) && typeof channel === 'string' && channel.startsWith('ticker.')) {
    handleTicker(channel, payload);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', () => {
  if (!finished) {
    finish('⚠️ Connection closed unexpectedly');
  }
});

function handleTicker(channel: string, data: any) {
  if (!data || typeof data.instrument_name !== 'string') return;

  const instName = data.instrument_name;
  const parts = instName.split('-');
  if (parts.length < 3) return;
  const strike = parseInt(parts[2], 10);
  if (!Number.isFinite(strike)) return;

  const markPrice = typeof data.mark_price === 'number' ? data.mark_price : undefined;
  const markIvPct = typeof data.mark_iv === 'number' ? data.mark_iv : null;
  if (markIvPct === null) return;

  const bidUSD = typeof data.best_bid_price === 'number' ? data.best_bid_price : undefined;
  const askUSD = typeof data.best_ask_price === 'number' ? data.best_ask_price : undefined;
  const rawMid = safeMid(bidUSD, askUSD, markPrice);
  if (rawMid === undefined || spot <= 0) return;

  const midNorm = marketSpec.premiumConvention === 'QUOTE'
    ? rawMid
    : marketSpec.fromBaseToQuoted(rawMid, spot);
  const bidNorm = bidUSD !== undefined
    ? (marketSpec.premiumConvention === 'QUOTE' ? bidUSD : marketSpec.fromBaseToQuoted(bidUSD, spot))
    : undefined;
  const askNorm = askUSD !== undefined
    ? (marketSpec.premiumConvention === 'QUOTE' ? askUSD : marketSpec.fromBaseToQuoted(askUSD, spot))
    : undefined;

  const midUSD = marketSpec.fromQuotedToBase(midNorm, spot);
  const bidUSDConv = bidNorm !== undefined ? marketSpec.fromQuotedToBase(bidNorm, spot) : undefined;
  const askUSDConv = askNorm !== undefined ? marketSpec.fromQuotedToBase(askNorm, spot) : undefined;

  marketData.set(strike, {
    iv: markIvPct / 100,
    midNorm,
    midUSD,
    bidNorm,
    askNorm,
    bidUSD: bidUSDConv,
    askUSD: askUSDConv,
  });

  tickCount++;
  cancelFallbackTimer();
  if (!stopTimer) {
    scheduleStopTimer();
  } else if (calibrated) {
    resetStopTimer();
  }

  if (!calibrated) {
    attemptCalibration();
  } else if (tickCount % 20 === 0) {
    logSampleQuote();
  }

  // Feed live updates back into the ISM once calibrated
  if (calibrated) {
    const spreadNorm = Math.max(
      (askNorm !== undefined && bidNorm !== undefined) ? askNorm - bidNorm : 0,
      MARKET_TICK_NORM
    );
    const size = 1.0;
    const weight = Math.min(
      Math.max(size / Math.pow(spreadNorm, 2), 10),
      3000
    );
    ism.updateMarketData(
      EXPIRY_MS,
      strike,
      midNorm,
      spot,
      weight,
      {
        bid: bidNorm,
        ask: askNorm,
        midUSD,
        bidUSD: bidUSDConv,
        askUSD: askUSDConv,
        denom: 'QUOTE',
      }
    );
  }

  if (calibrated && tickCount - lastSnapshotTick >= SNAPSHOT_TICK_INTERVAL) {
    logModelVsMarketSnapshot(`Snapshot@${tickCount}`);
    lastSnapshotTick = tickCount;
  }
}

function attemptCalibration() {
  if (calibrated || marketData.size < 15) return;

  const strikes = Array.from(marketData.keys()).sort((a, b) => a - b);
  const minStrike = strikes[0];
  const maxStrike = strikes[strikes.length - 1];
  const range = maxStrike - minStrike;

  if (range < 40000) return;

  console.log(`\n🔧 Calibrating with ${marketData.size} strikes (${minStrike}-${maxStrike})...\n`);
  const minTick = MARKET_TICK_NORM;

  const marketQuotes = Array.from(marketData.entries())
    .filter(([, data]) => data.midNorm > 2 * minTick && data.iv > 0.05 && data.iv < 3.0)
    .map(([strike, data]) => ({
      strike,
      iv: data.iv,
      weight: 1.0
    }));

  if (marketQuotes.length < 10) {
    console.log(`⏳ Only ${marketQuotes.length} liquid quotes, waiting for more data...`);
    return;
  }

  console.log(`✅ Found ${marketQuotes.length} liquid quotes for calibration`);
  try {
    ism.calibrateFromMarket(EXPIRY_MS, marketQuotes, spot);
    calibrated = true;
    console.log('\n✅ Calibration complete! Now generating quotes...\n');
    resetStopTimer();
    logSampleQuote();
    logModelVsMarketSnapshot('Initial calibration');
    lastSnapshotTick = tickCount;
  } catch (err: any) {
    console.error('❌ Calibration failed:', err.message);
  }
}

function logSampleQuote() {
  if (!calibrated || marketData.size === 0) return;
  const strikes = Array.from(marketData.keys());
  const randomStrike = strikes[Math.floor(Math.random() * strikes.length)];
  const mktData = marketData.get(randomStrike);
  if (!mktData) return;

  try {
    const quote = ism.getQuote(
      EXPIRY_MS,
      randomStrike,
      spot,
      'C',
      mktData.iv,
      Date.now()
    );

    const instName = `BTC-${EXPIRY_DATE}-${randomStrike}-C`;
    console.log(`[Tick ${tickCount}] ${instName}`);
    console.log(`  Market (norm): bid=${(mktData.bidNorm ?? 0).toFixed(6)} ask=${(mktData.askNorm ?? 0).toFixed(6)} mid=${mktData.midNorm.toFixed(6)}`);
    console.log(`  Market (USD):  ${mktData.midUSD.toFixed(2)} | bid=${(mktData.bidUSD ?? 0).toFixed(2)} ask=${(mktData.askUSD ?? 0).toFixed(2)}`);
    console.log(`  Model (norm):  bid=${quote.bid.toFixed(6)} ask=${quote.ask.toFixed(6)} (${quote.bidSize} x ${quote.askSize})`);
    console.log(`  Model (USD):   mid=${toUSD(quote.pcMid, spot).toFixed(2)}`);
    console.log(`  Edge:   ${(quote.edge * 10000).toFixed(2)} bps`);
    console.log();
  } catch (err: any) {
    console.error(`Error quoting ${randomStrike}:`, err.message);
  }
}
