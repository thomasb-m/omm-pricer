// Lightweight integration layer between QuoteEngine and your IntegratedSmileModel.
// Matches the QuoteEngine's expectations: updateSpot, getQuoteWithIV, onCustomerTrade, getInventory.

import { IntegratedSmileModel } from '../integratedSmileModel';


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

    // === λ·g mid shift (keep original width) ===
const cc = s.model.getCCSVI(expiryMs);
let adjBid = q.bid, adjAsk = q.ask, adjPcMid = q.pcMid ?? mid;
try {
  if (cc) {
    const isCall = optionType === "C";
    const T = Math.max(timeToExpiryYears(expiryMs), 1e-8);
    const g = factorGreeksFiniteDiff(cc, strike, T, s.forward, isCall);
    const ladg = dot(s.factors.lambda, g);
    const half = Math.max(0, (q.ask - q.bid) / 2);
    adjPcMid = (q.pcMid ?? mid) + (Number.isFinite(ladg) ? ladg : 0);
    adjBid = Math.max(0, adjPcMid - half);
    adjAsk = adjPcMid + half;
  }
} catch (_e) {
  // keep original quotes on any calc issue
}

return {
  bid: adjBid,
  ask: adjAsk,
  bidSize: q.bidSize,
  askSize: q.askSize,
  mid: (adjBid + adjAsk) / 2,
  spread: Math.max(0, adjAsk - adjBid),
  edge: q.edge,
  ccMid: q.ccMid,
  pcMid: adjPcMid,
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
