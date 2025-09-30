/**
 * Quote Engine Adapter
 * Integrates the smile-based volatility model with existing quote engines
 */

import { IntegratedSmileModel } from './integratedSmileModel';
import { ModelConfig } from './config/modelConfig';

// Standard quote engine interfaces
export interface QuoteRequest {
  symbol: string;
  strike: number;
  expiry: number;
  side: 'BUY' | 'SELL' | 'BOTH';
  size: number;
  clientId?: string;
}

export interface Quote {
  symbol: string;
  strike: number;
  expiry: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  edge: number;
  volatility: number;
  timestamp: Date;
}

export interface Fill {
  symbol: string;
  strike: number;
  expiry: number;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: Date;
  clientId?: string;
}

export interface RiskMetrics {
  totalVega: number;
  totalGamma: number;
  totalTheta: number;
  buckets: {
    name: string;
    vega: number;
    gamma: number;
    edge: number;
  }[];
  smileAdjustments: {
    level: number;
    skew: number;
    leftWing: number;
    rightWing: number;
  };
}

/**
 * Adapter class that bridges the vol model to quote engines
 */
export class QuoteEngineAdapter {
  private model: IntegratedSmileModel;
  private symbol: string;
  private spot: number;
  private callbackHandlers: {
    onQuoteUpdate?: (quotes: Quote[]) => void;
    onFill?: (fill: Fill) => void;
    onRiskUpdate?: (risk: RiskMetrics) => void;
  } = {};

  constructor(
    symbol: string,
    spot: number,
    config?: ModelConfig
  ) {
    this.symbol = symbol;
    this.spot = spot;
    this.model = new IntegratedSmileModel(config);
    this.model.initialize({ spot });
  }

  /**
   * Get a single quote
   */
  getQuote(request: QuoteRequest): Quote {
    const quote = this.model.getQuote(
      request.strike,
      request.expiry
    );

    // Adjust sizes based on request
    let bidSize = quote.bidSize;
    let askSize = quote.askSize;

    if (request.side === 'BUY') {
      askSize = Math.min(askSize, request.size);
    } else if (request.side === 'SELL') {
      bidSize = Math.min(bidSize, request.size);
    }

    return {
      symbol: this.symbol,
      strike: request.strike,
      expiry: request.expiry,
      bid: quote.bid,
      ask: quote.ask,
      bidSize,
      askSize,
      mid: (quote.bid + quote.ask) / 2,
      edge: quote.edge,
      volatility: quote.ccMid, // Using CC as the "fair" vol
      timestamp: new Date()
    };
  }

  /**
   * Get multiple quotes (for quote grids)
   */
  getQuoteGrid(
    strikes: number[],
    expiry: number
  ): Quote[] {
    return strikes.map(strike => 
      this.getQuote({
        symbol: this.symbol,
        strike,
        expiry,
        side: 'BOTH',
        size: 100
      })
    );
  }

  /**
   * Execute a trade
   */
  executeTrade(
    strike: number,
    expiry: number,
    side: 'BUY' | 'SELL',
    size: number,
    price?: number,
    clientId?: string
  ): Fill {
    // Get current quote if no price specified
    if (!price) {
      const quote = this.getQuote({
        symbol: this.symbol,
        strike,
        expiry,
        side,
        size
      });
      price = side === 'BUY' ? quote.ask : quote.bid;
    }

    // Execute in the model
    const execution = this.model.executeTrade(
      strike,
      expiry,
      side,
      size,
      price
    );

    const fill: Fill = {
      symbol: this.symbol,
      strike,
      expiry,
      side,
      price: execution.price,
      size: execution.size,
      timestamp: new Date(),
      clientId
    };

    // Trigger callbacks
    this.notifyFill(fill);
    this.notifyQuoteUpdate(expiry);
    this.notifyRiskUpdate();

    return fill;
  }

  /**
   * Get current risk metrics
   */
  getRiskMetrics(): RiskMetrics {
    const inventory = (this.model as any).inventoryController.getInventory();
    const smileAdj = (this.model as any).inventoryController.getSmileAdjustments();
    
    const buckets = Object.entries(inventory.byBucket).map(([name, metrics]: [string, any]) => ({
      name,
      vega: metrics.vega,
      gamma: metrics.gamma,
      edge: metrics.edgeRequired || 0
    }));

    return {
      totalVega: inventory.total.vega,
      totalGamma: inventory.total.gamma,
      totalTheta: inventory.total.theta,
      buckets,
      smileAdjustments: {
        level: smileAdj.deltaL0,
        skew: smileAdj.deltaS0,
        leftWing: smileAdj.deltaSNeg,
        rightWing: smileAdj.deltaSPos
      }
    };
  }

  /**
   * Update spot price
   */
  updateSpot(newSpot: number): void {
    this.spot = newSpot;
    // You might want to recalculate all quotes here
    this.notifyQuoteUpdate();
  }

  /**
   * Register callback handlers
   */
  on(event: 'quote' | 'fill' | 'risk', handler: Function): void {
    switch(event) {
      case 'quote':
        this.callbackHandlers.onQuoteUpdate = handler as any;
        break;
      case 'fill':
        this.callbackHandlers.onFill = handler as any;
        break;
      case 'risk':
        this.callbackHandlers.onRiskUpdate = handler as any;
        break;
    }
  }

  /**
   * Private notification methods
   */
  private notifyQuoteUpdate(expiry?: number): void {
    if (this.callbackHandlers.onQuoteUpdate) {
      // Get quotes for common strikes
      const strikes = this.generateStrikeGrid(this.spot);
      const quotes = this.getQuoteGrid(strikes, expiry || 0.08);
      this.callbackHandlers.onQuoteUpdate(quotes);
    }
  }

  private notifyFill(fill: Fill): void {
    if (this.callbackHandlers.onFill) {
      this.callbackHandlers.onFill(fill);
    }
  }

  private notifyRiskUpdate(): void {
    if (this.callbackHandlers.onRiskUpdate) {
      this.callbackHandlers.onRiskUpdate(this.getRiskMetrics());
    }
  }

  private generateStrikeGrid(spot: number): number[] {
    // Generate a standard strike grid
    const strikes: number[] = [];
    const moneyness = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];
    for (const m of moneyness) {
      strikes.push(Math.round(spot * m));
    }
    return strikes;
  }

  /**
   * Utility method to format quotes for display
   */
  formatQuoteTable(strikes: number[], expiry: number): string {
    const quotes = this.getQuoteGrid(strikes, expiry);
    let table = 'Strike | Bid    | Ask    | Mid    | Edge  | Vol   | Size\n';
    table += '-----------------------------------------------------------\n';
    
    for (const q of quotes) {
      table += `${q.strike.toString().padStart(6)} | `;
      table += `${q.bid.toFixed(2).padStart(6)} | `;
      table += `${q.ask.toFixed(2).padStart(6)} | `;
      table += `${q.mid.toFixed(2).padStart(6)} | `;
      table += `${q.edge.toFixed(2).padStart(5)} | `;
      table += `${(q.volatility * 100).toFixed(1).padStart(5)}% | `;
      table += `${q.bidSize}/${q.askSize}\n`;
    }
    
    return table;
  }
}

/**
 * Example WebSocket integration
 */
export class WebSocketQuoteEngine {
  private adapter: QuoteEngineAdapter;
  private ws: any; // Your WebSocket implementation

  constructor(symbol: string, spot: number) {
    this.adapter = new QuoteEngineAdapter(symbol, spot);
    
    // Register callbacks
    this.adapter.on('quote', (quotes) => this.broadcastQuotes(quotes));
    this.adapter.on('fill', (fill) => this.broadcastFill(fill));
    this.adapter.on('risk', (risk) => this.broadcastRisk(risk));
  }

  handleMessage(message: any): void {
    switch(message.type) {
      case 'QUOTE_REQUEST':
        const quote = this.adapter.getQuote(message.data);
        this.sendQuote(message.clientId, quote);
        break;
        
      case 'TRADE':
        const fill = this.adapter.executeTrade(
          message.strike,
          message.expiry,
          message.side,
          message.size,
          message.price,
          message.clientId
        );
        break;
        
      case 'SPOT_UPDATE':
        this.adapter.updateSpot(message.spot);
        break;
    }
  }

  private broadcastQuotes(quotes: Quote[]): void {
    // Broadcast to all connected clients
    this.ws?.broadcast({
      type: 'QUOTES',
      data: quotes
    });
  }

  private broadcastFill(fill: Fill): void {
    this.ws?.broadcast({
      type: 'FILL',
      data: fill
    });
  }

  private broadcastRisk(risk: RiskMetrics): void {
    this.ws?.broadcast({
      type: 'RISK_UPDATE',
      data: risk
    });
  }

  private sendQuote(clientId: string, quote: Quote): void {
    this.ws?.send(clientId, {
      type: 'QUOTE_RESPONSE',
      data: quote
    });
  }
}