/**
 * Quote Engine Adapter
 * Bridges the integrated smile model to external quote engines / UIs.
 */

import { IntegratedSmileModel } from "./integratedSmileModel";

// Request/response types
export interface QuoteRequest {
  symbol: string;
  strike: number;
  expiryMs: number;               // absolute timestamp (ms)
  optionType: "C" | "P";
  side: "BUY" | "SELL" | "BOTH";
  size: number;
  clientId?: string;
  marketIV?: number;              // optional ATM market IV (decimal)
}

export interface Quote {
  symbol: string;
  strike: number;
  expiryMs: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  edge: number;
  timestamp: Date;
}

export interface Fill {
  symbol: string;
  strike: number;
  expiryMs: number;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: Date;
  clientId?: string;
}

export interface RiskMetrics {
  totalVega: number;
  totalGamma: number;
  totalTheta: number;
  buckets: { name: string; vega: number; gamma: number; edge: number }[];
  smileAdjustments: { level: number; skew: number; leftWing: number; rightWing: number };
}

export class QuoteEngineAdapter {
  private model: IntegratedSmileModel;
  private symbol: string;
  private forward: number; // forward, not spot

  private callbackHandlers: {
    onQuoteUpdate?: (quotes: Quote[]) => void;
    onFill?: (fill: Fill) => void;
    onRiskUpdate?: (risk: RiskMetrics) => void;
  } = {};

  constructor(symbol: string, forward: number) {
    this.symbol = symbol;
    this.forward = forward;
    this.model = new IntegratedSmileModel(); // no initialize()
  }

  /** Get a single quote */
  getQuote(req: QuoteRequest): Quote {
    const q = this.model.getQuote(
      req.expiryMs,
      req.strike,
      this.forward,
      req.optionType,
      req.marketIV
    );

    // Size gating
    let bidSize = q.bidSize;
    let askSize = q.askSize;
    if (req.side === "BUY") askSize = Math.min(askSize, req.size);
    if (req.side === "SELL") bidSize = Math.min(bidSize, req.size);

    return {
      symbol: this.symbol,
      strike: req.strike,
      expiryMs: req.expiryMs,
      bid: q.bid,
      ask: q.ask,
      bidSize,
      askSize,
      mid: (q.bid + q.ask) / 2,
      edge: q.edge,
      timestamp: new Date(),
    };
  }

  /** Get multiple quotes (for quote grids) */
  getQuoteGrid(strikes: number[], expiryMs: number, optionType: "C" | "P" = "C"): Quote[] {
    return strikes.map((strike) =>
      this.getQuote({
        symbol: this.symbol,
        strike,
        expiryMs,
        optionType,
        side: "BOTH",
        size: 100,
      })
    );
  }

  /** Execute a trade (customer side) */
  executeTrade(
    strike: number,
    expiryMs: number,
    side: "BUY" | "SELL",
    size: number,
    price?: number,
    optionType: "C" | "P" = "C",
    clientId?: string
  ): Fill {
    // If no price given, take our current quote
    if (price == null) {
      const q = this.getQuote({
        symbol: this.symbol,
        strike,
        expiryMs,
        optionType,
        side,
        size,
      });
      price = side === "BUY" ? q.ask : q.bid;
    }

    // Signed size from CUSTOMER perspective (BUY means we SELL => negative)
    const signedSize = side === "BUY" ? -Math.abs(size) : Math.abs(size);

    // Inform the model
    this.model.onTrade({
      expiryMs,
      strike,
      forward: this.forward,
      optionType,
      price,
      size: signedSize,
      time: Date.now(),
    });

    const fill: Fill = {
      symbol: this.symbol,
      strike,
      expiryMs,
      side,
      price,
      size,
      timestamp: new Date(),
      clientId,
    };

    this.notifyFill(fill);
    this.notifyQuoteUpdate(expiryMs);
    this.notifyRiskUpdate();

    return fill;
  }

  /** Risk metrics proxy */
  getRiskMetrics(): RiskMetrics {
    const inv = this.model.getInventorySummary();
    const sa = inv.smileAdjustments;

    const buckets = Object.entries(inv.byBucket || {}).map(([name, m]: [string, any]) => ({
      name,
      vega: m.vega ?? 0,
      gamma: m.gamma ?? 0,
      edge: m.edgeRequired ?? 0,
    }));

    return {
      totalVega: inv.totalVega ?? 0,
      totalGamma: 0,
      totalTheta: 0,
      buckets,
      smileAdjustments: {
        level: sa.deltaL0,
        skew: sa.deltaS0,
        leftWing: sa.deltaSNeg,
        rightWing: sa.deltaSPos,
      },
    };
  }

  /** Update forward (perp) */
  updateForward(newForward: number): void {
    this.forward = newForward;
    this.notifyQuoteUpdate();
  }

  /** Events */
  on(event: "quote" | "fill" | "risk", handler: Function): void {
    if (event === "quote") this.callbackHandlers.onQuoteUpdate = handler as any;
    if (event === "fill") this.callbackHandlers.onFill = handler as any;
    if (event === "risk") this.callbackHandlers.onRiskUpdate = handler as any;
  }

  /** Internals */
  private defaultExpiryMs(): number {
    // default: 1 week ahead
    return Date.now() + 7 * 24 * 3600 * 1000;
  }

  private notifyQuoteUpdate(expiryMs?: number): void {
    if (!this.callbackHandlers.onQuoteUpdate) return;
    const strikes = this.generateStrikeGrid(this.forward);
    const ems = expiryMs ?? this.defaultExpiryMs();
    const quotes = this.getQuoteGrid(strikes, ems, "C");
    this.callbackHandlers.onQuoteUpdate(quotes);
  }

  private notifyFill(fill: Fill): void {
    this.callbackHandlers.onFill?.(fill);
  }

  private notifyRiskUpdate(): void {
    this.callbackHandlers.onRiskUpdate?.(this.getRiskMetrics());
  }

  private generateStrikeGrid(base: number): number[] {
    const strikes: number[] = [];
    const m = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];
    for (const x of m) strikes.push(Math.round(base * x));
    return strikes;
  }

  /** Pretty-printer */
  formatQuoteTable(strikes: number[], expiryMs: number): string {
    const quotes = this.getQuoteGrid(strikes, expiryMs);
    let table = "Strike | Bid    | Ask    | Mid    | Edge   | Size\n";
    table += "--------------------------------------------------\n";
    for (const q of quotes) {
      table += `${q.strike.toString().padStart(6)} | `;
      table += `${q.bid.toFixed(2).padStart(6)} | `;
      table += `${q.ask.toFixed(2).padStart(6)} | `;
      table += `${q.mid.toFixed(2).padStart(6)} | `;
      table += `${q.edge.toFixed(2).padStart(6)} | `;
      table += `${q.bidSize}/${q.askSize}\n`;
    }
    return table;
  }
}

/** Example WebSocket integration */
export class WebSocketQuoteEngine {
  private adapter: QuoteEngineAdapter;
  private ws: any; // Your WebSocket implementation

  constructor(symbol: string, forward: number) {
    this.adapter = new QuoteEngineAdapter(symbol, forward);
    this.adapter.on("quote", (quotes) => this.broadcastQuotes(quotes));
    this.adapter.on("fill", (fill) => this.broadcastFill(fill));
    this.adapter.on("risk", (risk) => this.broadcastRisk(risk));
  }

  handleMessage(message: any): void {
    switch (message.type) {
      case "QUOTE_REQUEST": {
        // Expect: { strike, expiryMs, optionType, size, side }
        const quote = this.adapter.getQuote({
          symbol: (this.adapter as any)["symbol"],
          strike: message.strike,
          expiryMs: message.expiryMs,
          optionType: message.optionType ?? "C",
          side: message.side ?? "BOTH",
          size: message.size ?? 100,
          clientId: message.clientId,
          marketIV: message.marketIV,
        });
        this.sendQuote(message.clientId, quote);
        break;
      }
      case "TRADE": {
        // Expect: { strike, expiryMs, optionType, side, size, price? }
        const fill = this.adapter.executeTrade(
          message.strike,
          message.expiryMs,
          message.side,
          message.size,
          message.price,
          message.optionType ?? "C",
          message.clientId
        );
        break;
      }
      case "FORWARD_UPDATE": {
        this.adapter.updateForward(message.forward);
        break;
      }
    }
  }

  private broadcastQuotes(quotes: Quote[]): void {
    this.ws?.broadcast({ type: "QUOTES", data: quotes });
  }
  private broadcastFill(fill: Fill): void {
    this.ws?.broadcast({ type: "FILL", data: fill });
  }
  private broadcastRisk(risk: RiskMetrics): void {
    this.ws?.broadcast({ type: "RISK_UPDATE", data: risk });
  }
  private sendQuote(clientId: string, quote: Quote): void {
    this.ws?.send(clientId, { type: "QUOTE_RESPONSE", data: quote });
  }
}
