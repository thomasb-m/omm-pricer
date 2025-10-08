"use strict";
/**
 * Multi-trade test scenario
 * Shows how smile evolves with complex inventory
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMultiTradeScenario = runMultiTradeScenario;
const integratedSmileModel_1 = require("./integratedSmileModel");
function runMultiTradeScenario() {
    console.log('\n' + '='.repeat(70));
    console.log('MULTI-TRADE SCENARIO - REALISTIC MARKET MAKING SESSION');
    console.log('='.repeat(70) + '\n');
    const model = new integratedSmileModel_1.IntegratedSmileModel('BTC');
    const expiry = 0.25; // 3 months
    const spot = 100;
    // Initialize with typical market conditions
    const initialMetrics = {
        L0: 0.04, // 20% vol for 3M
        S0: -0.002, // Slight put skew (normal market)
        C0: 0.5,
        S_neg: -0.8,
        S_pos: 0.9
    };
    model.updateCC(expiry, initialMetrics);
    console.log('Market opened with 20% ATM vol, slight put skew\n');
    // Helper function to show state
    const showState = (title) => {
        console.log('\n' + '-'.repeat(70));
        console.log(title);
        console.log('-'.repeat(70) + '\n');
        const strikes = [90, 95, 100, 105, 110];
        console.log('Strike | Bid    | Ask    | Mid    | CC Mid | Edge  | Vol   | Size');
        console.log('-'.repeat(70));
        for (const strike of strikes) {
            const quote = model.getQuote(expiry, strike, spot);
            const k = Math.log(strike / spot);
            // Get the vol for display
            const surface = model.surfaces.get(expiry);
            const pcVar = surface ? surface.pc.w(k) : 0;
            const vol = Math.sqrt(pcVar / expiry) * 100;
            console.log(`${strike.toString().padStart(6)} | ` +
                `${quote.bid.toFixed(2).padStart(6)} | ` +
                `${quote.ask.toFixed(2).padStart(6)} | ` +
                `${quote.pcMid.toFixed(2).padStart(6)} | ` +
                `${quote.ccMid.toFixed(2).padStart(6)} | ` +
                `${quote.edge.toFixed(2).padStart(5)} | ` +
                `${vol.toFixed(1).padStart(5)}% | ` +
                `${quote.bidSize}/${quote.askSize}`);
        }
        const summary = model.getInventorySummary();
        console.log(`\nTotal Vega: ${summary.totalVega.toFixed(1)}`);
        // Show inventory by bucket
        console.log('\nInventory by bucket:');
        for (const [bucket, data] of Object.entries(summary.byBucket)) {
            if (data.vega !== 0) {
                console.log(`  ${bucket}: ${data.vega.toFixed(1)} vega`);
            }
        }
        // Show smile adjustments
        const adj = summary.smileAdjustments;
        if (Math.abs(adj.deltaL0) + Math.abs(adj.deltaS0) + Math.abs(adj.deltaSNeg) > 0.0001) {
            console.log('\nSmile adjustments:');
            console.log(`  Level: ${(adj.deltaL0 * 100).toFixed(3)}% vol`);
            console.log(`  Skew:  ${(adj.deltaS0 * 100).toFixed(3)}% vol/unit`);
            console.log(`  L-wing: ${(adj.deltaSNeg * 100).toFixed(3)}% vol/unit`);
        }
    };
    // Show initial state
    showState('INITIAL STATE - Empty book');
    // TRADE 1: Customer sells 25-delta puts
    console.log('\n' + '='.repeat(70));
    console.log('TRADE 1: Customer SELLS 200 lots of 95 strike (25-delta put)');
    console.log('Market maker perspective: We BUY puts (long vol, short skew)');
    const trade1 = {
        expiry,
        strike: 95,
        price: 5.34, // Near mid
        size: -200, // Negative = we sold to customer = we're short
        spot,
        time: Date.now()
    };
    model.onTrade(trade1);
    showState('After Trade 1 - Short 25d puts');
    // TRADE 2: Another customer buys ATM straddle
    console.log('\n' + '='.repeat(70));
    console.log('TRADE 2: Customer BUYS 100 lots ATM straddle');
    console.log('Market maker perspective: We SELL straddle (short ATM vol)');
    const trade2 = {
        expiry,
        strike: 100,
        price: 7.97,
        size: -100, // Selling ATM
        spot,
        time: Date.now() + 1000
    };
    model.onTrade(trade2);
    showState('After Trade 2 - Short 25d puts + Short ATM');
    // TRADE 3: Hedge trade - buy some 10-delta puts
    console.log('\n' + '='.repeat(70));
    console.log('TRADE 3: We BUY 150 lots of 90 strike (10-delta put) as hedge');
    const trade3 = {
        expiry,
        strike: 90,
        price: 3.39,
        size: 150, // Positive = we bought
        spot,
        time: Date.now() + 2000
    };
    model.onTrade(trade3);
    showState('After Trade 3 - Mixed inventory across strikes');
    // TRADE 4: Customer lifts offer on OTM calls
    console.log('\n' + '='.repeat(70));
    console.log('TRADE 4: Customer BUYS 100 lots of 110 calls (wings)');
    const trade4 = {
        expiry,
        strike: 110,
        price: 14.92,
        size: -100,
        spot,
        time: Date.now() + 3000
    };
    model.onTrade(trade4);
    showState('After Trade 4 - Complex inventory across smile');
    // TRADE 5: Unwind some risk
    console.log('\n' + '='.repeat(70));
    console.log('TRADE 5: Unwind - We BUY back 100 lots of 95 puts');
    const trade5 = {
        expiry,
        strike: 95,
        price: 5.40, // Paying slightly above mid to close
        size: 100, // Buying back
        spot,
        time: Date.now() + 4000
    };
    model.onTrade(trade5);
    showState('After Trade 5 - Partially unwound');
    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('SCENARIO SUMMARY');
    console.log('='.repeat(70) + '\n');
    console.log('Trades executed:');
    console.log('  1. Sold 200x 95 puts  (customer selling pressure)');
    console.log('  2. Sold 100x 100 ATM  (straddle seller)');
    console.log('  3. Bought 150x 90 puts (hedge/inventory management)');
    console.log('  4. Sold 100x 110 calls (customer buying OTM)');
    console.log('  5. Bought 100x 95 puts (risk reduction)');
    const finalSummary = model.getInventorySummary();
    console.log('\nFinal inventory:');
    console.log(`  Total vega: ${finalSummary.totalVega.toFixed(1)}`);
    for (const [bucket, data] of Object.entries(finalSummary.byBucket)) {
        if (data.vega !== 0) {
            console.log(`  ${bucket}: ${data.vega.toFixed(1)} vega`);
        }
    }
    console.log('\nKey observations:');
    console.log('  • Smile should steepen when net short puts');
    console.log('  • ATM vol should lift when short gamma');
    console.log('  • Quotes should widen on inventory-heavy strikes');
    console.log('  • PC diverges from CC based on positioning');
    console.log('\n' + '='.repeat(70) + '\n');
}
// Run the scenario
if (require.main === module) {
    runMultiTradeScenario();
}
