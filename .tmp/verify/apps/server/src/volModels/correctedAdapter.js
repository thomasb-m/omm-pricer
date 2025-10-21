"use strict";
/**
 * Corrected Adapter with Proper Trade Side Logic
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorrectedAdapter = void 0;
const integratedSmileModel_1 = require("./integratedSmileModel");
class CorrectedAdapter {
    model;
    spot;
    expiry = 0.08;
    debug = false;
    constructor(spot, debug = false) {
        this.spot = spot;
        this.debug = debug;
        this.model = new integratedSmileModel_1.IntegratedSmileModel('BTC');
        if (this.debug) {
            console.log('Model initialized - surfaces will auto-create on first quote');
        }
    }
    updateSpot(newSpot) {
        this.spot = newSpot;
        console.log(`CorrectedAdapter spot updated to ${newSpot}`);
    }
    getQuote(strike, expiry = this.expiry, marketIV) {
        // Pass spot to the model's getQuote method
        return this.model.getQuote(expiry, strike, this.spot, marketIV);
    }
    executeCustomerTrade(strike, expiry = this.expiry, customerSide, size, price) {
        if (!price) {
            const quote = this.getQuote(strike, expiry);
            price = customerSide === 'BUY' ? quote.ask : quote.bid;
        }
        const ourPositionChange = customerSide === 'BUY' ? -size : size;
        const ourAction = customerSide === 'BUY' ? 'SELLING' : 'BUYING';
        const resultingPosition = customerSide === 'BUY' ? 'SHORT' : 'LONG';
        if (this.debug) {
            console.log(`\n📊 Trade Execution:`);
            console.log(`  Customer: ${customerSide}S ${size} @ ${price.toFixed(2)}`);
            console.log(`  We are: ${ourAction} (position change: ${ourPositionChange > 0 ? '+' : ''}${ourPositionChange})`);
            console.log(`  Result: Getting ${resultingPosition}`);
            console.log(`  Expected: Vols should ${resultingPosition === 'SHORT' ? 'RISE ↑' : 'FALL ↓'}`);
        }
        const trade = {
            expiry,
            strike,
            price,
            size: ourPositionChange,
            spot: this.spot,
            time: Date.now()
        };
        this.model.onTrade(trade);
        return {
            customerSide,
            ourAction,
            strike,
            price,
            size,
            ourPositionChange,
            resultingPosition
        };
    }
    getInventory() {
        return this.model.getInventorySummary();
    }
    formatQuotes(strikes, expiry = this.expiry) {
        console.log('\nStrike | Bid    | Ask    | Edge  | Size  | Mid Vol');
        console.log('---------------------------------------------------');
        for (const strike of strikes) {
            const q = this.getQuote(strike, expiry);
            const midPrice = (q.bid + q.ask) / 2;
            const midVol = Math.sqrt(midPrice / (this.spot * 0.4) / expiry) * 100;
            console.log(`${strike.toString().padStart(6)} | ` +
                `${q.bid.toFixed(2).padStart(6)} | ` +
                `${q.ask.toFixed(2).padStart(6)} | ` +
                `${q.edge.toFixed(2).padStart(5)} | ` +
                `${q.bidSize}/${q.askSize.toString().padEnd(3)} | ` +
                `${midVol.toFixed(1)}%`);
        }
    }
}
exports.CorrectedAdapter = CorrectedAdapter;
