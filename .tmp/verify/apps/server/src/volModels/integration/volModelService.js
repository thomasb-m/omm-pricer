"use strict";
// Single-calculus adapter: λ·g shift on quotes, factor inventory on trades.
Object.defineProperty(exports, "__esModule", { value: true });
exports.volService = void 0;
const integratedSmileModel_1 = require("../integratedSmileModel");
const FactorSpace_1 = require("../factors/FactorSpace");
const factorGreeks_1 = require("../factors/factorGreeks");
const time_1 = require("../../utils/time");
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const DEFAULT_FORWARDS = { BTC: 45000, ETH: 3000 };
const DEFAULT_LAMBDA = [0.50, 0.20, 0.10, 0.15, 0.10, 0.30];
function nowMs() { return Date.now(); }
function ensureMs(expiryOrYears) {
    return expiryOrYears > 1e10
        ? Math.floor(expiryOrYears)
        : Math.floor(nowMs() + Math.max(expiryOrYears, 0) * YEAR_MS);
}
class VolModelService {
    symbols = new Map();
    ensure(symbol) {
        let s = this.symbols.get(symbol);
        if (!s) {
            s = {
                model: new integratedSmileModel_1.IntegratedSmileModel(symbol),
                forward: DEFAULT_FORWARDS[symbol] ?? DEFAULT_FORWARDS.BTC,
                lambda: [...DEFAULT_LAMBDA],
                inventory: [...FactorSpace_1.ZeroFactors],
            };
            this.symbols.set(symbol, s);
        }
        return s;
    }
    updateSpot(symbol, forward) {
        const s = this.ensure(symbol);
        s.forward = forward;
    }
    updateForward(symbol, forward) { this.updateSpot(symbol, forward); }
    // ------ READ/WRITE FACTORS (λ, I) ------
    getFactors(symbol) {
        const s = this.ensure(symbol);
        return {
            lambda: s.lambda,
            inventory: s.inventory,
            lambdaDotInventory: (0, FactorSpace_1.dot)(s.lambda, s.inventory),
        };
    }
    setLambda(symbol, lambda) {
        const s = this.ensure(symbol);
        s.lambda = lambda;
        return this.getFactors(symbol);
    }
    clearInventory(symbol) {
        const s = this.ensure(symbol);
        s.inventory = [...FactorSpace_1.ZeroFactors];
        return this.getFactors(symbol);
    }
    // ------ QUOTES WITH λ·g SHIFT ------
    getQuoteWithIV(symbol, strike, expiryMsOrYears, marketIV, // ← Move marketIV before optionType
    optionType = "C") {
        const s = this.ensure(symbol);
        const expiryMs = ensureMs(expiryMsOrYears);
        // Base quotes from the model (PC/CC separation done inside)
        const q = s.model.getQuote(expiryMs, strike, s.forward, optionType, marketIV);
        const rawMid = (q.bid + q.ask) / 2;
        const half = Math.max(0, (q.ask - q.bid) / 2);
        // Compute CC-based factor greeks and apply λ·g as a parallel mid shift
        let bid = q.bid, ask = q.ask, adjPcMid = q.pcMid ?? rawMid;
        let ladg = 0;
        try {
            const cc = s.model.getCCSVI(expiryMs);
            if (cc) {
                const T = Math.max((0, time_1.timeToExpiryYears)(expiryMs), 1e-8);
                const isCall = optionType === "C";
                const g = (0, factorGreeks_1.factorGreeksFiniteDiff)(cc, strike, T, s.forward, isCall);
                ladg = (0, FactorSpace_1.dot)(s.lambda, g);
                adjPcMid = (q.pcMid ?? rawMid) + (Number.isFinite(ladg) ? ladg : 0);
                bid = Math.max(0, adjPcMid - half);
                ask = adjPcMid + half;
                // Lightweight debug (safe to keep or comment out)
                // console.debug(`[quote λ·g] ${symbol} K=${strike} T=${T.toFixed(4)} ladg=${ladg.toFixed(4)} mid=${rawMid.toFixed(4)}→${adjPcMid.toFixed(4)}`);
            }
        }
        catch {
            // keep original q on any calc issue
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
    onCustomerTrade(symbol, strike, side, size, price, expiryMs, optionType, timestamp, marketIV) {
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
                console.log(`[volService] Computing factor greeks: K=${strike}, T=${(0, time_1.timeToExpiryYears)(expiryMs, t)}, F=${s.forward}, optionType=${optionType}`);
                const T = Math.max((0, time_1.timeToExpiryYears)(expiryMs, t), 1e-8);
                const isCall = optionType === "C";
                const g = (0, factorGreeks_1.factorGreeksFiniteDiff)(cc, strike, T, s.forward, isCall);
                console.log(`[volService] Factor greeks: g=[${g.map(x => x.toFixed(6)).join(', ')}]`);
                console.log(`[volService] I_old=[${s.inventory.map(x => x.toFixed(2)).join(', ')}]`);
                s.inventory = (0, FactorSpace_1.axpy)(s.inventory, signedSize, g);
                console.log(`[volService] I_new=[${s.inventory.map(x => x.toFixed(2)).join(', ')}] (signedSize=${signedSize})`);
            }
            else {
                console.warn(`[volService] No CC surface found for expiryMs=${expiryMs}`);
            }
        }
        catch (err) {
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
    getInventory(symbol) {
        const s = this.ensure(symbol);
        return s.model.getInventorySummary();
    }
}
exports.volService = new VolModelService();
