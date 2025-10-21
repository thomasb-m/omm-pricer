"use strict";
/**
 * Diagnostic tool to find where the asymmetry is happening
 */
Object.defineProperty(exports, "__esModule", { value: true });
const smileInventoryController_1 = require("./smileInventoryController");
const modelConfig_1 = require("./config/modelConfig");
function testSymmetry() {
    console.log('\n' + '='.repeat(60));
    console.log('EDGE CALCULATION SYMMETRY TEST');
    console.log('='.repeat(60));
    const config = (0, modelConfig_1.getDefaultConfig)('BTC');
    const controller = new smileInventoryController_1.SmileInventoryController(config);
    // Test various inventory levels
    const testLevels = [
        { vega: -30, label: 'Very Short' },
        { vega: -10, label: 'Short' },
        { vega: 0, label: 'Flat' },
        { vega: 10, label: 'Long' },
        { vega: 30, label: 'Very Long' }
    ];
    console.log('\nTesting smile adjustments for different positions:');
    console.log('Position  | Vega  | ΔL0     | ΔS0     | Edge Req');
    console.log('-'.repeat(55));
    for (const test of testLevels) {
        // Simulate ATM position
        controller.updateInventory(100, test.vega > 0 ? 100 : -100, test.vega, 'atm');
        const adjustments = controller.calculateSmileAdjustments();
        // Get edge required from inventory state
        const invState = controller.getInventoryState();
        const atmInv = invState.get('atm');
        const edgeReq = atmInv ? atmInv.edgeRequired : 0;
        console.log(`${test.label.padEnd(10)} | ${test.vega.toString().padStart(4)} | ` +
            `${(adjustments.deltaL0 * 100).toFixed(3).padStart(7)}% | ` +
            `${(adjustments.deltaS0 * 100).toFixed(3).padStart(7)}% | ` +
            `${edgeReq.toFixed(2).padStart(8)}`);
        // Reset for next test
        controller.updateInventory(100, test.vega > 0 ? -100 : 100, -test.vega, 'atm');
    }
    console.log('\n' + '-'.repeat(55));
    console.log('\n⚠️  ISSUES TO CHECK:');
    console.log('\n1. Is ΔL0 symmetric? (should be negative when long)');
    console.log('2. Is edge requirement signed correctly?');
    console.log('3. Are there any Math.abs() calls preventing negative adjustments?');
    // Now let's check the actual code logic
    console.log('\n' + '-'.repeat(55));
    console.log('\nDirect calculation test:');
    // Simulate the edge calculation directly
    const E0 = config.buckets[0].edgeParams.E0;
    const Vref = config.buckets[0].edgeParams.Vref;
    for (const test of testLevels) {
        // What the calculation SHOULD be
        const correctEdge = (test.vega / Vref) * E0;
        // What it might be doing wrong
        const wrongEdge1 = Math.abs(test.vega / Vref) * E0; // Always positive
        const wrongEdge2 = Math.max(0, (test.vega / Vref) * E0); // Never negative
        console.log(`\nVega ${test.vega}:`);
        console.log(`  Correct (signed):   ${correctEdge.toFixed(3)}`);
        console.log(`  Wrong (absolute):   ${wrongEdge1.toFixed(3)}`);
        console.log(`  Wrong (max 0):      ${wrongEdge2.toFixed(3)}`);
    }
    console.log('\n' + '='.repeat(60));
    console.log('The fix needed in smileInventoryController.ts:');
    console.log('1. Remove Math.abs() from edge calculations');
    console.log('2. Allow negative deltaL0 when long');
    console.log('3. Make sure all adjustments can go negative');
    console.log('='.repeat(60));
}
testSymmetry();
