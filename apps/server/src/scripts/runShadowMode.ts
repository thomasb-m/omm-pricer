#!/usr/bin/env ts-node
/**
 * Shadow Mode - Full System Test
 * 
 * Connects to live market data, generates quotes, logs what we would trade
 */

import WebSocket from 'ws';
import { IntegratedSmileModel } from '../volModels/integratedSmileModel';
import { initConfigManager } from '../config/configManager';
import { initTradingController } from '../config/tradingController';

interface Instrument {
  name: string;
  strike: number;
  expiry: number;
  type: 'C' | 'P';
}

class ShadowModeRunner {
  private ws: WebSocket | null = null;
  private ism: IntegratedSmileModel;
  private instruments: Instrument[] = [];
  private forward: number = 100000; // BTC spot approx
  private tickCount: number = 0;
  
  constructor() {
    // Initialize config
    const cm = initConfigManager();
    console.log('[Shadow] Config:', cm.getSummary());
    
    // Initialize trading controller
    const tc = initTradingController();
    console.log('[Shadow] Mode:', tc.getMode());
    
    // Initialize pricing model
    this.ism = new IntegratedSmileModel('BTC');
    console.log('[Shadow] ISM initialized\n');
  }
  
  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.ws = new WebSocket('wss://test.deribit.com/ws/api/v2');
      
      this.ws.on('open', () => {
        console.log('✅ Connected to Deribit testnet\n');
        resolve();
      });
      
      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data.toString()));
      });
      
      this.ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
      });
    });
  }
  
  private handleMessage(msg: any): void {
    if (msg.result && Array.isArray(msg.result)) {
      // Instrument list received
      this.onInstruments(msg.result);
    } else if (msg.params?.channel?.includes('ticker')) {
      // Ticker update
      this.onTicker(msg.params.channel, msg.params.data);
    }
  }
  
  private onInstruments(instruments: any[]): void {
    // Pick a few ATM options
    const now = Date.now();
    const weekFromNow = now + (7 * 24 * 60 * 60 * 1000);
    
    this.instruments = instruments
      .filter(i => {
        const expiry = new Date(i.expiration_timestamp).getTime();
        return expiry > now && expiry < weekFromNow;
      })
      .filter(i => {
        // Near ATM (95k - 105k)
        return i.strike >= 95000 && i.strike <= 105000;
      })
      .slice(0, 5) // Just 5 instruments for testing
      .map(i => ({
        name: i.instrument_name,
        strike: i.strike,
        expiry: new Date(i.expiration_timestamp).getTime(),
        type: i.option_type === 'call' ? 'C' as const : 'P' as const
      }));
    
    console.log(`📋 Selected ${this.instruments.length} instruments:`);
    this.instruments.forEach(i => {
      console.log(`   ${i.name} (strike=${i.strike}, type=${i.type})`);
    });
    console.log();
    
    // Subscribe to tickers
    if (this.instruments.length > 0) {
      this.subscribeToTickers();
    }
  }
  
  private subscribeToTickers(): void {
    const channels = this.instruments.map(i => `ticker.${i.name}.100ms`);
    
    this.ws?.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'public/subscribe',
      params: { channels }
    }));
    
    console.log('✅ Subscribed to tickers\n');
  }
  
  private onTicker(channel: string, data: any): void {
    const instrumentName = channel.split('.')[1];
    const instrument = this.instruments.find(i => i.name === instrumentName);
    
    if (!instrument) return;
    
    this.tickCount++;
    
    // Get quote from ISM
    const quote = this.ism.getQuote(
      instrument.expiry,
      instrument.strike,
      this.forward,
      instrument.type,
      data.mark_iv / 100, // Convert IV from % to decimal
      Date.now()
    );
    
    // Log every 10th tick
    if (this.tickCount % 10 === 0) {
      console.log(`[SHADOW] ${instrument.name}`);
      console.log(`  Market: bid=${data.best_bid_price} ask=${data.best_ask_price} iv=${data.mark_iv}%`);
      console.log(`  Model:  bid=${quote.bid.toFixed(4)} ask=${quote.ask.toFixed(4)} sizes=${quote.bidSize}x${quote.askSize}`);
      console.log(`  Edge:   ${(quote.edge * 10000).toFixed(2)} bps, PC=${quote.pcMid.toFixed(4)} CC=${quote.ccMid.toFixed(4)}`);
      console.log();
    }
  }
  
  async run(): Promise<void> {
    console.log('='.repeat(60));
    console.log('SHADOW MODE - LIVE MARKET DATA + PRICING');
    console.log('='.repeat(60));
    console.log();
    
    await this.connect();
    
    // Get instruments
    console.log('Fetching instruments...');
    this.ws?.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'public/get_instruments',
      params: {
        currency: 'BTC',
        kind: 'option',
        expired: false
      }
    }));
    
    // Run for 60 seconds
    console.log('Running for 60 seconds...\n');
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    console.log('\n' + '='.repeat(60));
    console.log('SHADOW MODE COMPLETE!');
    console.log('='.repeat(60));
    console.log(`Total ticks processed: ${this.tickCount}`);
    console.log();
    
    this.ws?.close();
    process.exit(0);
  }
}

// Run it
const runner = new ShadowModeRunner();
runner.run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});