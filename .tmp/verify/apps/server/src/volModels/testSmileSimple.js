"use strict";
/**
 * Simple test to show smile adjustment concept
 * No complex imports, just the core idea
 */
Object.defineProperty(exports, "__esModule", { value: true });
function testSmileAdjustment() {
    console.log('\n' + '='.repeat(60));
    console.log('SMILE ADJUSTMENT CONCEPT');
    console.log('='.repeat(60) + '\n');
    console.log('When you SELL 25-delta puts:\n');
    console.log('Current localized bump approach:');
    console.log('  • Only affects the 95 strike');
    console.log('  • Other strikes unchanged');
    console.log('  • Not realistic market behavior\n');
    console.log('Better smile-wide adjustment:');
    console.log('  • Increase skew (S0): Puts become more expensive vs calls');
    console.log('  • Lower left wing (S_neg): Far OTM puts get cheaper');
    console.log('  • Small ATM lift (L0): General vol increase');
    console.log('  • Right wing unchanged (S_pos): Calls unaffected\n');
    console.log('Example impact on volatilities:');
    console.log('Strike | Before | After  | Change');
    console.log('-'.repeat(40));
    // Simulated vols showing the pattern
    const impacts = [
        { strike: 80, before: 22.0, after: 21.5, desc: 'Far OTM put' },
        { strike: 90, before: 20.0, after: 20.2, desc: '10d put' },
        { strike: 95, before: 19.0, after: 19.5, desc: '25d put' },
        { strike: 100, before: 18.0, after: 18.2, desc: 'ATM' },
        { strike: 105, before: 19.0, after: 19.1, desc: '25d call' },
        { strike: 110, before: 20.0, after: 20.0, desc: '10d call' },
        { strike: 120, before: 22.0, after: 22.0, desc: 'Far OTM call' }
    ];
    for (const { strike, before, after, desc } of impacts) {
        const change = after - before;
        const sign = change > 0 ? '+' : '';
        console.log(`${strike.toString().padStart(6)} | ` +
            `${before.toFixed(1).padStart(6)}% | ` +
            `${after.toFixed(1).padStart(6)}% | ` +
            `${sign}${change.toFixed(1).padStart(4)}%  ${desc}`);
    }
    console.log('\nKey observations:');
    console.log('  1. Put skew increases (95-105 spread wider)');
    console.log('  2. Far OTM puts decrease (you already supplied there)');
    console.log('  3. ATM gets small bump (general risk premium)');
    console.log('  4. Calls largely unchanged (asymmetric impact)');
    console.log('\nThis matches real dealer behavior!');
    console.log('='.repeat(60) + '\n');
}
// Run it
testSmileAdjustment();
