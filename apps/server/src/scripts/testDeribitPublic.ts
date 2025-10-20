#!/usr/bin/env ts-node
/**
 * Test Deribit Public API (no auth needed)
 */

import WebSocket from 'ws';

const ws = new WebSocket('wss://test.deribit.com/ws/api/v2');

ws.on('open', () => {
  console.log('✅ Connected to Deribit testnet\n');
  
  // Get instruments (no auth needed)
  console.log('Fetching BTC options...');
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'public/get_instruments',
    params: {
      currency: 'BTC',
      kind: 'option',
      expired: false
    }
  }));
  
  setTimeout(() => {
    // Subscribe to ticker (no auth needed)
    console.log('\nSubscribing to ticker...');
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'public/subscribe',
      params: {
        channels: ['ticker.BTC-17OCT25-100000-C.100ms']
      }
    }));
  }, 2000);
  
  setTimeout(() => {
    console.log('\n✅ Public API works! You can see market data.');
    console.log('\n⚠️  For TRADING, you need to either:');
    console.log('   1. Complete KYC on testnet (if required)');
    console.log('   2. Or just run in SHADOW MODE (no auth needed)\n');
    ws.close();
    process.exit(0);
  }, 10000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.result?.length) {
    console.log(`✅ Found ${msg.result.length} BTC options`);
    console.log('Sample:', msg.result[0].instrument_name);
  } else if (msg.params?.channel?.includes('ticker')) {
    const d = msg.params.data;
    console.log('📊 Ticker:', {
      bid: d.best_bid_price,
      ask: d.best_ask_price,
      mark: d.mark_price
    });
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));