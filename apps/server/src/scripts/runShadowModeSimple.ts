#!/usr/bin/env ts-node
/**
 * Shadow Mode - Full Smile Real Market Data
 */

process.env.USE_PC_FIT = 'true';

import WebSocket from 'ws';
import { IntegratedSmileModel } from '../volModels/integratedSmileModel';
import { initConfigManager } from '../config/configManager';
import { initTradingController } from '../config/tradingController';

// Initialize
const cm = initConfigManager();
const tc = initTradingController();
const ism = new IntegratedSmileModel('BTC');

console.log('='.repeat(60));
console.log('SHADOW MODE - FULL SMILE TEST');
console.log('='.repeat(60));
console.log('Config:', cm.getSummary());
console.log('Mode:', tc.getMode().mode);
console.log();

// Connect to Deribit
const ws = new WebSocket('wss://test.deribit.com/ws/api/v2');

// Near-term expiry (about 1 week out)
const EXPIRY_DATE = '24OCT25';  // ~1 week from now
const EXPIRY_MS = new Date('2025-10-24').getTime();

// Track market data
const marketData = new Map<number, { iv: number, mid: number, bid: number, ask: number }>();
let spot = 100000;  // Will update from index
let tickCount = 0;
let calibrated = false;

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
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
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
    
    // Subscribe to all of them
    const channels = instruments.map((inst: any) => 
      `ticker.${inst.instrument_name}.100ms`
    );
    
    console.log(`📡 Subscribing to ${channels.length} instruments...\n`);
    
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'public/subscribe',
      params: { channels }
    }));
  }
  
  // Handle ticker updates
  if (msg.params?.channel?.includes('ticker')) {
    const d = msg.params.data;
    const instName = d.instrument_name;
    
    // Parse strike from instrument name: BTC-24OCT25-95000-C
    const parts = instName.split('-');
    const strike = parseInt(parts[2]);
    
    if (d.mark_iv && d.mark_price && d.best_bid_price && d.best_ask_price) {
      marketData.set(strike, {
        iv: d.mark_iv / 100,  // Convert from % to decimal
        mid: d.mark_price,
        bid: d.best_bid_price,
        ask: d.best_ask_price
      });
      
      // NEW: Feed data to ISM for continuous refitting
      // Find this section (around line 80-90):
    if (calibrated) {
        const spread = Math.max(d.best_ask_price - d.best_bid_price, 0.0005);
        const size = 1.0;  // Could use volume if available
        const tick = 0.0001;
    
        // ✅ BETTER WEIGHT: Capped between 10-3000
        const weight = Math.min(
        Math.max(
            size / Math.pow(Math.max(spread, tick), 2),
            10    // Min weight
        ),
        3000  // Max weight (down from 10k)
        );
    
        ism.updateMarketData(EXPIRY_MS, strike, d.mark_price, spot, weight);
    }
        
      // Once we have data spanning a wide enough range, calibrate
      if (!calibrated && marketData.size >= 15) {
        const strikes = Array.from(marketData.keys()).sort((a, b) => a - b);
        const minStrike = Math.min(...strikes);
        const maxStrike = Math.max(...strikes);
        const range = maxStrike - minStrike;
        
        // Only calibrate if we have at least 40K strike range (covers 10Δ)
        if (range >= 40000) {
          console.log(`\n🔧 Calibrating with ${marketData.size} strikes (${minStrike}-${maxStrike})...\n`);
          
          const marketQuotes = Array.from(marketData.entries()).map(([strike, data]) => ({
            strike,
            iv: data.iv,
            weight: 1.0
          }));
          
          try {
            ism.calibrateFromMarket(EXPIRY_MS, marketQuotes, spot);
            calibrated = true;
            console.log('\n✅ Calibration complete! Now generating quotes...\n');
          } catch (err: any) {
            console.error('❌ Calibration failed:', err.message);
          }
        }
      }
      
      // Generate quotes after calibration
      if (calibrated) {
        tickCount++;
        
        // Log every 20th tick for a random strike
        if (tickCount % 20 === 0) {
          const strikes = Array.from(marketData.keys());
          const randomStrike = strikes[Math.floor(Math.random() * strikes.length)];
          const mktData = marketData.get(randomStrike)!;
          
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
            console.log(`  Market: bid=${mktData.bid.toFixed(4)} ask=${mktData.ask.toFixed(4)} mid=${mktData.mid.toFixed(4)}`);
            console.log(`  Model:  bid=${quote.bid.toFixed(4)} ask=${quote.ask.toFixed(4)} (${quote.bidSize} x ${quote.askSize})`);
            console.log(`  Edge:   ${(quote.edge * 10000).toFixed(2)} bps`);
            console.log();
          } catch (err: any) {
            console.error(`Error quoting ${randomStrike}:`, err.message);
          }
        }
      }
    }
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

// Stop after 60 seconds
setTimeout(() => {
  console.log('\n' + '='.repeat(60));
  console.log(`COMPLETE! Processed ${tickCount} ticks across ${marketData.size} strikes`);
  console.log('='.repeat(60));
  ws.close();
  process.exit(0);
}, 60000);