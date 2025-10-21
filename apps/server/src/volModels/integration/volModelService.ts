// Single-calculus adapter: λ·g shift on quotes, factor inventory on trades.

import { IntegratedSmileModel } from "../integratedSmileModel";
import { FactorVec, ZeroFactors, axpy, dot } from "../factors/FactorSpace";
import { factorGreeksFiniteDiff } from "../factors/factorGreeks";
import { timeToExpiryYears } from "../../utils/time";

export type Side = "BUY" | "SELL";
export type OptionType = "C" | "P";

type SymbolState = {
  model: IntegratedSmileModel;
  forward: number;
  lambda: FactorVec;      // cost per unit factor exposure (tunable)
  inventory: FactorVec;   // running factor inventory
};

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const DEFAULT_FORWARDS: Record<string, number> = { BTC: 45000, ETH: 3000 };
const DEFAULT_LAMBDA: FactorVec = [
  0.08,   // L0 - 10x for testing
  0.64,   // S0 - 10x
  0.32,   // C0 - 10x
  0.24,   // Sneg - 10x
  0.16,   // Spos - 10x
  0.04    // F - 10x
];

function nowMs() { return Date.now(); }
function ensureMs(expiryOrYears: number): number {
  return expiryOrYears > 1e10
    ? Math.floor(expiryOrYears)
    : Math.floor(nowMs() + Math.max(expiryOrYears, 0) * YEAR_MS);
}
const FACTOR_CFG = {
  bMin: 1e-6,
  sigmaMin: 1e-6,
  rhoMax: 0.999,
  sMax: 5,
  c0Min: 0.01,
  buckets: [],
  edgeParams: new Map(),
  rbfWidth: 0,
  ridgeLambda: 0,
  maxL0Move: 0,
  maxS0Move: 0,
  maxC0Move: 0
};
class VolModelService {
  private symbols = new Map<string, SymbolState>();

  private ensure(symbol: string): SymbolState {
    let s = this.symbols.get(symbol);
    if (!s) {
      s = {
        model: new IntegratedSmileModel(symbol as any),
        forward: DEFAULT_FORWARDS[symbol] ?? DEFAULT_FORWARDS.BTC,
        lambda: [...DEFAULT_LAMBDA],
        inventory: [...ZeroFactors],
      };
      this.symbols.set(symbol, s);
    }
    return s;
  }

  updateSpot(symbol: string, forward: number) {
    const s = this.ensure(symbol);
    s.forward = forward;
  }
  updateForward(symbol: string, forward: number) { this.updateSpot(symbol, forward); }

  // ------ READ/WRITE FACTORS (λ, I) ------
  getFactors(symbol: string) {
    const s = this.ensure(symbol);
    return {
      lambda: s.lambda,
      inventory: s.inventory,
      lambdaDotInventory: dot(s.lambda, s.inventory),
    };
  }
  setLambda(symbol: string, lambda: FactorVec) {
    const s = this.ensure(symbol);
    s.lambda = lambda;
    return this.getFactors(symbol);
  }
  clearInventory(symbol: string) {
    const s = this.ensure(symbol);
    s.inventory = [...ZeroFactors];
    return this.getFactors(symbol);
  }

  calibrateExpiry(
    symbol: string,
    expiryMs: number,
    marketQuotes: Array<{ strike: number; iv: number; weight?: number }>,
    spot: number
  ) {
    const s = this.ensure(symbol);
    s.model.calibrateFromMarket(expiryMs, marketQuotes, spot);
    console.log(`[volService] Calibrated ${symbol} expiry ${new Date(expiryMs).toISOString().split('T')[0]} with ${marketQuotes.length} quotes`);
    return true;
  }

  // ------ QUOTES WITH λ·g SHIFT ------
  getQuoteWithIV(
    symbol: string,
    strike: number,
    expiryMsOrYears: number,
    marketIV?: number,        // ← Move marketIV before optionType
    optionType: OptionType = "C"
  ) {
    
    const s = this.ensure(symbol);
    const expiryMs = ensureMs(expiryMsOrYears);

    // Base quotes from the model (PC/CC separation done inside)
    const q = s.model.getQuote(expiryMs, strike, s.forward, optionType, marketIV);
    const rawMid = (q.bid + q.ask) / 2;
    const half   = Math.max(0, (q.ask - q.bid) / 2);

    // Compute CC-based factor greeks and apply λ·g as a parallel mid shift
    let bid = q.bid, ask = q.ask, adjPcMid = q.pcMid ?? rawMid;
    let ladg = 0;
    try {
      const cc = s.model.getCCSVI(expiryMs);
      if (cc) {
        const T = Math.max(timeToExpiryYears(expiryMs), 1e-8);
        const isCall = optionType === "C";
        const g = factorGreeksFiniteDiff(cc, strike, T, s.forward, isCall, FACTOR_CFG);
        ladg = dot(s.lambda, g);
        adjPcMid = q.pcMid ?? rawMid;
        bid = Math.max(0, adjPcMid - half);
        ask = adjPcMid + half;

        // Optional debug logging
        if (process.env.NODE_ENV === 'development') {
          // console.debug(`[quote] K=${strike} T=${T.toFixed(4)} ccMid=${rawMid.toFixed(4)} pcMid=${adjPcMid.toFixed(4)} ladg_diag=${ladg.toFixed(4)}`);
        }
      }
    } catch (err) {
      // Fall back to model's PC on any error
      console.error('[volService.getQuoteWithIV] Error computing diagnostics:', err);
      adjPcMid = q.pcMid ?? rawMid;
      bid = Math.max(0, adjPcMid - half);
      ask = adjPcMid + half;
    }

    return {
      bid,
      ask,
      bidSize: q.bidSize,
      askSize: q.askSize,
      mid: (bid + ask) / 2,
      spread: Math.max(0, ask - bid),
      edge: q.edge,
      pcMid: adjPcMid,
      ccMid: q.ccMid,
      bucket: q.bucket,
      ladg, // expose inventory edge for UI/observability
    };
  }

  // ------ TRADES UPDATE INVENTORY (I ← I + q·g) AND INFORM MODEL ------
  onCustomerTrade(
    symbol: string,
    strike: number,
    side: Side,
    size: number,
    price: number,
    expiryMs: number,
    optionType: OptionType,
    timestamp?: number,
    marketIV?: number
  ) {
    const s = this.ensure(symbol);
    const t = timestamp ?? nowMs();

    console.log(`[volService.onCustomerTrade] marketIV=${marketIV}, expiryMs=${expiryMs}`);
    // Ensure the surface exists (will also (re)calibrate if marketIV provided)
    s.model.getQuote(expiryMs, strike, s.forward, optionType, marketIV);

    // Ensure the surface exists (will also (re)calibrate if marketIV provided)
    s.model.getQuote(expiryMs, strike, s.forward, optionType, marketIV);

    // Verify surface was created properly
    const cc = s.model.getCCSVI(expiryMs);
    if (cc) {
      console.log(`[volService] CC after getQuote: a=${cc.a}, b=${cc.b}, rho=${cc.rho}, sigma=${cc.sigma}, m=${cc.m}`);
      if (cc.a === null || !Number.isFinite(cc.a)) {
        console.error(`[volService] INVALID CC: a=${cc.a} - surface calibration failed`);
  }
}

    // Customer side → signed size for our inventory: BUY => we are short
    const signedSize = side === "BUY" ? -Math.abs(size) : +Math.abs(size);

    // Update factor inventory via CC-based greeks at trade point
try {
  const cc = s.model.getCCSVI(expiryMs);
  if (cc) {
    console.log(`[volService] Computing factor greeks: K=${strike}, T=${timeToExpiryYears(expiryMs, t)}, F=${s.forward}, optionType=${optionType}`);
    const T = Math.max(timeToExpiryYears(expiryMs, t), 1e-8);
    const isCall = optionType === "C";
    const g = factorGreeksFiniteDiff(cc, strike, T, s.forward, isCall, FACTOR_CFG);
    console.log(`[volService] Factor greeks: g=[${g.map(x => x.toFixed(6)).join(', ')}]`);
    console.log(`[volService] I_old=[${s.inventory.map(x => x.toFixed(2)).join(', ')}]`);
    s.inventory = axpy(s.inventory, signedSize, g);
    console.log(`[volService] I_new=[${s.inventory.map(x => x.toFixed(2)).join(', ')}] (signedSize=${signedSize})`);
  } else {
    console.warn(`[volService] No CC surface found for expiryMs=${expiryMs}`);
  }
} catch (err) {
  console.error(`[volService] Factor inventory update FAILED:`, err);
  // best-effort inventory; model booking still happens
}

    // Book into model (inventory-aware PC inside model adjusts too)
    s.model.onTrade({
      expiryMs,
      strike,
      forward: s.forward,
      optionType,
      price,
      size: signedSize, // customer-signed convention (negative when we sell)
      time: t,
    });

    return true;
  }

  getInventory(symbol: string) {
    const s = this.ensure(symbol);
    return s.model.getInventorySummary();
  }
  
  getFactorInventory(symbol: string) {
    const s = this.ensure(symbol);
    return {
      inventory: s.inventory,
      lambda: s.lambda,
      lambdaDotInventory: dot(s.lambda, s.inventory)
    };
  }
}

export const volService = new VolModelService();
