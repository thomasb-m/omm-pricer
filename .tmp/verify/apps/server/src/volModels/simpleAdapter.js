"use strict";
/**
 * Simple Adapter for IntegratedSmileModel
 * Directly matches the actual model interface
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimpleAdapter = void 0;
const integratedSmileModel_1 = require("./integratedSmileModel");
class SimpleAdapter {
    model;
    spot;
    expiry = 0.08; // 30 days
    constructor(spot) {
        this.spot = spot;
        this.model = new integratedSmileModel_1.IntegratedSmileModel('BTC');
        // Initialize CC (Core Curve)
        const initialMetrics = {
            L0: 0.04, // 20% vol
            S0: 0.001,
            C0: 0.5,
            S_neg: -0.8,
            S_pos: 0.9
        };
        this.model.updateCC(this.expiry, initialMetrics);
    }
    getQuote(strike, expiry = this.expiry) {
        return this.model.getQuote(expiry, strike, this.spot);
    }
    executeTrade(strike, expiry = this.expiry, side, size, price) {
        // Get quote if no price
        if (!price) {
            const quote = this.getQuote(strike, expiry);
            price = side === 'BUY' ? quote.ask : quote.bid;
        }
        // Create trade execution object
        const trade = {
            expiry,
            strike,
            price,
            size: side === 'SELL' ? -size : size, // Negative for sells
            spot: this.spot,
            time: Date.now()
        };
        // Execute via onTrade
        this.model.onTrade(trade);
        return trade;
    }
    getInventory() {
        return this.model.getInventorySummary();
    }
    formatQuotes(strikes, expiry = this.expiry) {
        console.log('\nStrike | Bid    | Ask    | Edge  | Size');
        console.log('------------------------------------------');
        for (const strike of strikes) {
            const q = this.getQuote(strike, expiry);
            console.log(`${strike.toString().padStart(6)} | ` +
                `${q.bid.toFixed(2).padStart(6)} | ` +
                `${q.ask.toFixed(2).padStart(6)} | ` +
                `${q.edge.toFixed(2).padStart(5)} | ` +
                `${q.bidSize}/${q.askSize}`);
        }
    }
}
exports.SimpleAdapter = SimpleAdapter;
// Test it
function testAdapter() {
    console.log('\n' + '='.repeat(60));
    console.log('SIMPLE ADAPTER TEST');
    console.log('='.repeat(60));
    const adapter = new SimpleAdapter(100);
    const strikes = [90, 95, 100, 105, 110];
    // Initial quotes
    console.log('\nInitial quotes:');
    adapter.formatQuotes(strikes);
    // Execute some trades
    console.log('\n' + '-'.repeat(60));
    console.log('Executing trades...');
    const fill1 = adapter.executeTrade(95, 0.08, 'SELL', 100);
    console.log(`Fill: SELL 100x95 @ ${fill1.price.toFixed(2)}`);
    const fill2 = adapter.executeTrade(100, 0.08, 'SELL', 50);
    console.log(`Fill: SELL 50x100 @ ${fill2.price.toFixed(2)}`);
    // Updated quotes
    console.log('\nQuotes after trades:');
    adapter.formatQuotes(strikes);
    // Show inventory
    const inv = adapter.getInventory();
    console.log(`\nTotal Vega: ${inv.totalVega.toFixed(1)}`);
    console.log('\n' + '='.repeat(60));
}
testAdapter();
