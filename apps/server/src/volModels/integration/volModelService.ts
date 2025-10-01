// apps/server/src/volModels/integration/volModelService.ts

import { IntegratedSmileModel } from "../integratedSmileModel";

// ---- Types exposed by the service
export type Side = "BUY" | "SELL";
export type OptionType = "C" | "P";

export interface QuoteOut {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  spread: number;
  edge: number;
  ccMid?: number;   // if you want to expose later
  pcMid?: number;   // if you want to expose later
  bucket?: string;
}

// ---- Internal per-symbol state
type SymbolState = {
  model: IntegratedSmileModel;
  forward: number;              // current forward (perp)
};

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

// Conservative default forward if none set yet
const DEFAULT_FORWARDS: Record<string, number> = {
  BTC: 45000,
  ETH: 3000,
};

function nowMs(): number {
  return Date.now();
}

function ensureMs(expiryOrYears: number): number {
  // Back-compat helper:
  // If input is "small" (e.g. 0.08 years), treat as years-from-now → convert to ms.
  // If input is a big number (> 10^10), assume it's already a ms timestamp.
  if (expiryOrYears > 1e10) return Math.floor(expiryOrYears); // ms epoch
  const Tyears = Math.max(expiryOrYears, 0);
  return Math.floor(nowMs() + Tyears * YEAR_MS);
}

class VolModelService {
  private symbols: Map<string, SymbolState> = new Map();

  // Get or create model for a symbol
  private getState(symbol: string): SymbolState {
    let s = this.symbols.get(symbol);
    if (!s) {
      s = {
        model: new IntegratedSmileModel(), // default product config inside
        forward: DEFAULT_FORWARDS[symbol] ?? DEFAULT_FORWARDS.BTC,
      };
      this.symbols.set(symbol, s);
    }
    return s;
  }

  // === Public API ===

  /**
   * Update the "spot" used by the model, which in our setup is the **forward** (perp).
   * Keep this in sync with quoteEngine.updateForward(...)
   */
  updateSpot(symbol: string, forward: number): void {
    const s = this.getState(symbol);
    s.forward = forward;
  }

  updateForward(symbol: string, forward: number): void {
    this.updateSpot(symbol, forward);
  }

  /**
   * Get a quote, with optional ATM market IV to recalibrate.
   * Back-compat: if expiry is passed in YEARS, we convert to ms from now.
   */
  getQuoteWithIV(
    symbol: string,
    strike: number,
    expiryMsOrYears: number,
    marketIV?: number,
    optionType: OptionType = "C"
  ): QuoteOut {
    const s = this.getState(symbol);
    const expiryMs = ensureMs(expiryMsOrYears);

    const q = s.model.getQuote(expiryMs, strike, s.forward, optionType, marketIV);
    const mid = (q.bid + q.ask) / 2;

    return {
      bid: q.bid,
      ask: q.ask,
      bidSize: q.bidSize,
      askSize: q.askSize,
      mid,
      spread: q.ask - q.bid,
      edge: q.edge,
      ccMid: q.ccMid,   // available if you want to surface it
      pcMid: q.pcMid,   // available if you want to surface it
      bucket: q.bucket, // useful for UI
    };
  }

  /**
   * Record a customer trade into the model.
   * Preferred signature: include expiryMs and optionType.
   * Back-compat shim: we accept calls without those, but we log a warning and
   * apply a 1w default expiry and 'C' option type.
   */
  onCustomerTrade(
    symbol: string,
    strike: number,
    side: Side,
    size: number,
    price: number,
    expiryMs?: number,
    optionType: OptionType = "C",
    tradeTimeMs?: number,
    marketIV?: number            // <- optional: ATM IV used at trade time
  ): true {
    const s = this.getState(symbol);
  
    let exp = expiryMs;
    if (!exp) {
      console.warn(`[volService] onCustomerTrade missing expiryMs. Using 7d default (back-compat).`);
      exp = nowMs() + 7 * 24 * 3600 * 1000;
    }
  
    // ✅ Ensure the surface exists & is calibrated for this expiry before we book the trade
    //    (this will create/update the surface keyed by exp)
    s.model.getQuote(exp!, strike, s.forward, optionType, marketIV);
  
    // Use CUSTOMER-side sign: BUY -> we are short -> negative size
    const signedSize = side === "BUY" ? -Math.abs(size) : Math.abs(size);
  
    s.model.onTrade({
      expiryMs: exp!,
      strike,
      forward: s.forward,
      optionType,
      price,
      size: signedSize,                 // keep customer-side convention
      time: tradeTimeMs ?? nowMs(),
    });
  
    return true;
  }

  /**
   * Get inventory summary for a symbol (vega by bucket, smile adjustments, etc.)
   */
  getInventory(symbol: string) {
    const s = this.getState(symbol);
    return s.model.getInventorySummary();
  }
}

// Export singleton
export const volService = new VolModelService();
