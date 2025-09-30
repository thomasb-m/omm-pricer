/**
 * Simple diagnostic to show the asymmetry problem
 */

import { SmileInventoryController } from './smileInventoryController';
import { ModelConfig, getDefaultConfig } from './config/modelConfig';

function testSymmetry() {
  console.log('\n' + '='.repeat(60));
  console.log('EDGE CALCULATION SYMMETRY TEST');
  console.log('='.repeat(60));
  
  const config = getDefaultConfig('BTC');
  const controller = new SmileInventoryController(config);
  
  // Test various inventory levels
  const testLevels = [
    { vega: -30, label: 'Very Short' },
    { vega: -10, label: 'Short' },
    { vega: 0, label: 'Flat' },
    { vega: 10, label: 'Long' },
    { vega: 30, label: 'Very Long' }
  ];
  
  console.log('\nTesting smile adjustments for different positions:');
  console.log('Position  | Vega  | ΔL0     | ΔS0     ');
  console.log('-'.repeat(45));
  
  for (const test of testLevels) {
    // Clear and set new inventory
    controller.clearInventory();
    
    if (test.vega !== 0) {
      // Simulate ATM position
      controller.updateInventory(100, test.vega > 0 ? 100 : -100, Math.abs(test.vega) / 100, 'atm');
    }
    
    const adjustments = controller.calculateSmileAdjustments();
    
    console.log(
      `${test.label.padEnd(10)} | ${test.vega.toString().padStart(4)} | ` +
      `${(adjustments.deltaL0 * 100).toFixed(3).padStart(7)}% | ` +
      `${(adjustments.deltaS0 * 100).toFixed(3).padStart(7)}%`
    );
  }
  
  console.log('\n' + '-'.repeat(45));
  console.log('\n⚠️  ASYMMETRY CHECK:');
  
  // Find the specific issue
  controller.clearInventory();
  controller.updateInventory(100, -100, 10, 'atm');  // Short 10 vega
  const shortAdj = controller.calculateSmileAdjustments();
  
  controller.clearInventory();
  controller.updateInventory(100, 100, 10, 'atm');   // Long 10 vega
  const longAdj = controller.calculateSmileAdjustments();
  
  console.log(`\nWith 10 vega ATM position:`);
  console.log(`  SHORT: ΔL0 = ${(shortAdj.deltaL0 * 100).toFixed(3)}%`);
  console.log(`  LONG:  ΔL0 = ${(longAdj.deltaL0 * 100).toFixed(3)}%`);
  
  if (Math.abs(shortAdj.deltaL0) === Math.abs(longAdj.deltaL0) && longAdj.deltaL0 <= 0) {
    console.log(`\n✅ SYMMETRIC: Long and short create equal but opposite adjustments`);
  } else if (longAdj.deltaL0 === 0) {
    console.log(`\n❌ ASYMMETRIC: Long positions don't reduce vols!`);
    console.log(`   This is the bug - Math.abs() or Math.max() preventing negative adjustments`);
  } else {
    console.log(`\n⚠️  PARTIAL: Some asymmetry detected`);
  }
  
  console.log('\n' + '='.repeat(60));
}

testSymmetry();