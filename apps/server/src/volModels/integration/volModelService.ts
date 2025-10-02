// Lightweight integration layer between QuoteEngine and your IntegratedSmileModel.
// Matches the QuoteEngine's expectations: updateSpot, getQuoteWithIV, onCustomerTrade, getInventory.

import { IntegratedSmileModel } from "../IntegratedSmileModel";


type Side = "BUY" | "SELL";
type OptionType = "C" | "P";

interface SymbolState {
  model: IntegratedSmileModel;
  forward: number;
}

class VolModelService {
  private symbols = new Map<string, SymbolState>();

  private ensure(symbol: string): SymbolState {
    let s = this.symbols.get(symbol);
    if (!s) {
      const model = new IntegratedSmileModel(symbol as any);
      s = { model, forward: 45000 };
      this.symbols.set(symbol, s);
    }
    return s;
  }

  updateSpot(symbol: string, forward: number) {
    const s = this.ensure(symbol);
    s.forward = forward;
  }

  /**
   * Quote path used by QuoteEngine.getQuote()
   * It calls your model.getQuote(forward is passed in), and returns what QE expects.
   */
  getQuoteWithIV(
    symbol: string,
    expiryMs: number,
    strike: number,
    optionType: OptionType,
    marketIV?: number
  ) {
    const s = this.ensure(symbol);

    const q = s.model.getQuote(
      expiryMs,
      strike,
      s.forward,
      optionType,
      marketIV
    );

    // Shape it exactly the way QuoteEngine expects to consume:
    return {
      bid: q.bid,
      ask: q.ask,
      bidSize: q.bidSize,
      askSize: q.askSize,
      mid: (q.bid + q.ask) / 2,
      spread: Math.max(0, q.ask - q.bid),
      edge: q.edge,
      pcMid: q.pcMid,
      ccMid: q.ccMid,
      bucket: q.bucket,
    };
  }

  /**
   * Route a customer trade into the model so inventory/PC adjust.
   * QuoteEngine already provides 'side' as CUSTOMER side. We'll pass size signed from customer perspective:
   *  - BUY => +size
   *  - SELL => -size
   */
  onCustomerTrade(
    symbol: string,
    strike: number,
    side: Side,
    size: number,
    price: number,
    expiryMs: number,
    optionType: OptionType,
    timestamp?: number
  ) {
    const s = this.ensure(symbol);
    const signedSize = side === "BUY" ? Math.max(0, size) : -Math.max(0, size);

    s.model.onTrade({
      expiryMs,
      strike,
      forward: s.forward,
      optionType,
      price,
      size: signedSize,      // signed from CUSTOMER perspective (per your model’s docstring)
      time: timestamp ?? Date.now(),
    });
  }

  /**
   * Inventory summary for UI/logging.
   */
  getInventory(symbol: string) {
    const s = this.ensure(symbol);
    return s.model.getInventorySummary();
  }
}

export const volService = new VolModelService();
