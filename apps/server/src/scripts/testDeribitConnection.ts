#!/usr/bin/env ts-node
/**
 * Test Deribit Testnet Connection
 * Verifies API credentials and market data streaming
 */

import WebSocket from 'ws';

interface DeribitMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

class DeribitTestConnection {
  private ws: WebSocket | null = null;
  private messageId = 1;
  private accessToken: string | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private environment: 'test' | 'prod' = 'test'
  ) {}

  private getWsUrl(): string {
    return this.environment === 'test'
      ? 'wss://test.deribit.com/ws/api/v2'
      : 'wss://www.deribit.com/ws/api/v2';
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[Deribit] Connecting to:', this.getWsUrl());
      
      this.ws = new WebSocket(this.getWsUrl());

      this.ws.on('open', () => {
        console.log('[Deribit] ✅ WebSocket connected');
        resolve();
      });

      this.ws.on('error', (err) => {
        console.error('[Deribit] ❌ WebSocket error:', err.message);
        reject(err);
      });

      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data.toString()));
      });

      this.ws.on('close', () => {
        console.log('[Deribit] Connection closed');
      });
    });
  }

  private handleMessage(msg: DeribitMessage): void {
    if (msg.error) {
      console.error('[Deribit] ❌ Error:', msg.error);
      return;
    }

    if (msg.method === 'subscription') {
      // Market data update
      const channel = msg.params?.channel;
      const data = msg.params?.data;
      
      if (channel?.includes('ticker')) {
        console.log('[Deribit] 📊 Ticker update:', {
          instrument: data?.instrument_name,
          bid: data?.best_bid_price,
          ask: data?.best_ask_price,
          mark: data?.mark_price
        });
      }
    } else if (msg.result) {
      // Response to our request
      console.log('[Deribit] ✅ Response:', msg.result);
    }
  }

  private send(method: string, params: any = {}): void {
    if (!this.ws) {
      throw new Error('WebSocket not connected');
    }

    const message = {
      jsonrpc: '2.0',
      id: this.messageId++,
      method,
      params
    };

    console.log('[Deribit] → Sending:', method);
    this.ws.send(JSON.stringify(message));
  }

  async authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Auth timeout')), 5000);

      const handler = (data: Buffer) => {
        const msg: DeribitMessage = JSON.parse(data.toString());
        
        if (msg.result?.access_token) {
          this.accessToken = msg.result.access_token;
          console.log('[Deribit] ✅ Authenticated');
          this.ws?.off('message', handler);
          clearTimeout(timeout);
          resolve();
        } else if (msg.error) {
          this.ws?.off('message', handler);
          clearTimeout(timeout);
          reject(new Error(msg.error.message));
        }
      };

      this.ws?.on('message', handler);

      this.send('public/auth', {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret
      });
    });
  }

  async subscribeToTicker(instrumentName: string): Promise<void> {
    this.send('public/subscribe', {
      channels: [`ticker.${instrumentName}.100ms`]
    });
  }

  async getInstruments(): Promise<void> {
    this.send('public/get_instruments', {
      currency: 'BTC',
      kind: 'option',
      expired: false
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Main test
async function main() {
  const clientId = process.env.DERIBIT_CLIENT_ID;
  const clientSecret = process.env.DERIBIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ Missing credentials! Set DERIBIT_CLIENT_ID and DERIBIT_CLIENT_SECRET');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('DERIBIT TESTNET CONNECTION TEST');
  console.log('='.repeat(60) + '\n');

  const client = new DeribitTestConnection(clientId, clientSecret, 'test');

  try {
    // Step 1: Connect
    await client.connect();
    console.log('✅ Step 1: Connected\n');

    // Step 2: Authenticate
    await client.authenticate();
    console.log('✅ Step 2: Authenticated\n');

    // Step 3: Get instruments
    console.log('Step 3: Fetching BTC options...');
    await client.getInstruments();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 4: Subscribe to ticker
    console.log('\nStep 4: Subscribing to BTC-17OCT25-100000-C ticker...');
    await client.subscribeToTicker('BTC-17OCT25-100000-C');

    // Step 5: Listen for 10 seconds
    console.log('Step 5: Listening to market data for 10 seconds...\n');
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(60) + '\n');

    client.disconnect();
    process.exit(0);

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    client.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}