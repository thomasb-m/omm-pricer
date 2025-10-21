"use strict";
/**
 * Simple multi-trade test that works
 */
Object.defineProperty(exports, "__esModule", { value: true });
const integratedSmileModel_1 = require("./integratedSmileModel");
function runSimpleMultiTrade() {
    console.log('\n' + '='.repeat(70));
    console.log('MULTI-TRADE SCENARIO');
    console.log('='.repeat(70) + '\n');
    const model = new integratedSmileModel_1.IntegratedSmileModel('BTC');
    const expiry = 0.25; // 3 months
    const spot = 100;
    // Initialize
    const initialMetrics = {
        L0: 0.04,
        S0: -0.002,
        C0: 0.5,
        S_neg: -0.8,
        S_pos: 0.9
    };
    model.updateCC(expiry, initialMetrics);
    console.log('Market initialized\n');
    // Helper to show quotes
    const showQuotes = (title) => {
        console.log('\n' + title);
        console.log('-'.repeat(50));
        console.log('Strike | Bid    | Ask    | Edge  | Size');
        console.log('-'.repeat(50));
        const strikes = [90, 95, 100, 105, 110];
        for (const strike of strikes) {
            const quote = model.getQuote(expiry, strike, spot);
            console.log(`${strike.toString().padStart(6)} | ` +
                `${quote.bid.toFixed(2).padStart(6)} | ` +
                `${quote.ask.toFixed(2).padStart(6)} | ` +
                `${quote.edge.toFixed(2).padStart(5)} | ` +
                `${quote.bidSize}/${quote.askSize}`);
        }
        const summary = model.getInventorySummary();
        console.log(`\nTotal Vega: ${summary.totalVega.toFixed(1)}`);
    };
    // Initial state
    showQuotes('INITIAL - No inventory');
    // Trade 1: Sell 200x 95 puts
    console.log('\n' + '='.repeat(50));
    console.log('TRADE 1: Sell 200x 95 puts');
    model.onTrade({
        expiry,
        strike: 95,
        price: 5.34,
        size: -200,
        spot,
        time: Date.now()
    });
    showQuotes('After Trade 1');
    // Trade 2: Sell 100x ATM
    console.log('\n' + '='.repeat(50));
    console.log('TRADE 2: Sell 100x ATM (100 strike)');
    model.onTrade({
        expiry,
        strike: 100,
        price: 7.97,
        size: -100,
        spot,
        time: Date.now() + 1000
    });
    showQuotes('After Trade 2');
    // Trade 3: Buy 150x 90 puts (hedge)
    console.log('\n' + '='.repeat(50));
    console.log('TRADE 3: Buy 150x 90 puts (hedge)');
    model.onTrade({
        expiry,
        strike: 90,
        price: 3.39,
        size: 150,
        spot,
        time: Date.now() + 2000
    });
    showQuotes('After Trade 3');
    // Trade 4: Sell 100x 110 calls
    console.log('\n' + '='.repeat(50));
    console.log('TRADE 4: Sell 100x 110 calls');
    model.onTrade({
        expiry,
        strike: 110,
        price: 14.92,
        size: -100,
        spot,
        time: Date.now() + 3000
    });
    showQuotes('After Trade 4');
    // Trade 5: Buy back 100x 95 puts
    console.log('\n' + '='.repeat(50));
    console.log('TRADE 5: Buy back 100x 95 puts');
    model.onTrade({
        expiry,
        strike: 95,
        price: 5.40,
        size: 100,
        spot,
        time: Date.now() + 4000
    });
    showQuotes('After Trade 5 - Final position');
    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    const finalSummary = model.getInventorySummary();
    console.log('\nFinal inventory by bucket:');
    for (const [bucket, data] of Object.entries(finalSummary.byBucket)) {
        if (data.vega !== 0) {
            console.log(`  ${bucket}: ${data.vega.toFixed(1)} vega`);
        }
    }
    const adj = finalSummary.smileAdjustments;
    console.log('\nSmile adjustments:');
    console.log(`  Level:  ${(adj.deltaL0 * 100).toFixed(3)}%`);
    console.log(`  Skew:   ${(adj.deltaS0 * 100).toFixed(3)}%`);
    console.log(`  L-wing: ${(adj.deltaSNeg * 100).toFixed(3)}%`);
    console.log(`  R-wing: ${(adj.deltaSPos * 100).toFixed(3)}%`);
    console.log('\n' + '='.repeat(70) + '\n');
}
// Run it
runSimpleMultiTrade();
