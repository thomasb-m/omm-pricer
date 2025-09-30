/**
 * Standalone test for the inventory controller
 * Shows how inventory drives PC adjustments
 */

import { InventoryController, EdgeLadder, BumpSolver } from './controllers/inventoryController';
import { getDefaultConfig } from './config/modelConfig';
import { SVIParams } from './dualSurfaceModel';

function runInventoryTest() {
  console.log('\n' + '='.repeat(50));
  console.log('INVENTORY CONTROLLER TEST');
  console.log('='.repeat(50) + '\n');
  
  const config = getDefaultConfig('BTC');
  const controller = new InventoryController(config);
  
  // ===== Test 1: Edge Ladder =====
  console.log('Test 1: Edge Ladder (how edge scales with inventory)\n');
  console.log('For 25-delta bucket:');
  
  const positions = [-200, -100, -50, 0, 50, 100, 200];
  for (const pos of positions) {
    const edge = EdgeLadder.calculateEdge(pos, config, 'rr25');
    const direction = edge > 0 ? '↑ PC > CC' : edge < 0 ? '↓ PC < CC' : '= PC = CC';
    console.log(`  Position: ${pos.toString().padStart(4)} vega → Edge: ${edge.toFixed(2).padStart(6)} ticks ${direction}`);
  }
  
  // ===== Test 2: Trade Simulation =====
  console.log('\n' + '-'.repeat(50));
  console.log('\nTest 2: Trade Simulation\n');
  
  // Initial state
  console.log('Initial: No position, PC = CC\n');
  
  // Trade 1: Sell 100 lots
  const strike1 = 95;
  const vega1 = 0.5;
  controller.updateInventory(strike1, -100, vega1, 'rr25');
  
  let edge = controller.getCurrentEdge('rr25');
  let inventory = controller.getInventoryState();
  
  console.log('After SELLING 100 lots of 25-delta put:');
  console.log(`  Strike: ${strike1}`);
  console.log(`  Position: -100 lots (SHORT)`);
  console.log(`  Vega inventory: ${inventory.byBucket.get('rr25')?.signedVega.toFixed(1)}`);
  console.log(`  Required edge: ${edge.toFixed(2)} ticks`);
  console.log(`  → PC moves ${Math.abs(edge).toFixed(2)} ticks ${edge > 0 ? 'ABOVE' : 'BELOW'} CC`);
  console.log(`  → Quotes become ${edge > 0 ? 'HIGHER' : 'LOWER'} to ${edge > 0 ? 'discourage more selling' : 'encourage buying'}\n`);
  
  // Trade 2: Sell more
  controller.updateInventory(strike1, -100, vega1, 'rr25');
  
  edge = controller.getCurrentEdge('rr25');
  inventory = controller.getInventoryState();
  
  console.log('After SELLING another 100 lots:');
  console.log(`  Total position: -200 lots`);
  console.log(`  Vega inventory: ${inventory.byBucket.get('rr25')?.signedVega.toFixed(1)}`);
  console.log(`  Required edge: ${edge.toFixed(2)} ticks`);
  console.log(`  → Edge requirement increased due to larger position\n`);
  
  // Trade 3: Buy some back
  controller.updateInventory(strike1, 50, vega1, 'rr25');
  
  edge = controller.getCurrentEdge('rr25');
  inventory = controller.getInventoryState();
  
  console.log('After BUYING back 50 lots:');
  console.log(`  Total position: -150 lots`);
  console.log(`  Vega inventory: ${inventory.byBucket.get('rr25')?.signedVega.toFixed(1)}`);
  console.log(`  Required edge: ${edge.toFixed(2)} ticks`);
  console.log(`  → Edge requirement reduced\n`);
  
  // ===== Test 3: Bump Generation =====
  console.log('-'.repeat(50));
  console.log('\nTest 3: Variance Bump Generation\n');
  
  // Create a sample CC surface
  const cc: SVIParams = {
    a: 0.03,
    b: 0.5,
    rho: -0.2,
    sigma: 0.2,
    m: 0
  };
  
  const T = 0.25;  // 3 months
  const spot = 100;
  
  // Generate bumps for current inventory
  const bumps = controller.generateBumps('rr25', cc, T, spot, [95, 96, 97]);
  
  console.log(`Generated ${bumps.length} bump(s) for 25-delta bucket:`);
  for (const bump of bumps) {
    const strike = Math.round(spot * Math.exp(bump.k));
    console.log(`  Strike ~${strike}: amplitude=${bump.alpha.toFixed(4)}, width=${bump.lam.toFixed(3)}`);
  }
  
  // ===== Test 4: Different Buckets =====
  console.log('\n' + '-'.repeat(50));
  console.log('\nTest 4: Edge Requirements by Bucket\n');
  
  const testVega = -100;  // Short 100 vega
  const buckets = ['wings', 'rr10', 'rr25', 'atm'];
  
  console.log(`For ${testVega} vega position:`);
  for (const bucket of buckets) {
    const e = EdgeLadder.calculateEdge(testVega, config, bucket);
    console.log(`  ${bucket.padEnd(6)}: ${e.toFixed(2).padStart(6)} ticks required`);
  }
  console.log('\nNote: ATM requires more edge than wings (higher risk)\n');
  
  // ===== Test 5: Rebasing =====
  console.log('-'.repeat(50));
  console.log('\nTest 5: Rebasing (when CC moves)\n');
  
  console.log('Scenario: CC moves but we want to preserve edge\n');
  
  // New CC with higher vol
  const newCC: SVIParams = {
    a: 0.04,  // Higher ATM vol
    b: 0.5,
    rho: -0.2,
    sigma: 0.2,
    m: 0
  };
  
  const oldBumps = controller.generateBumps('rr25', cc, T, spot, [95]);
  const newBumps = controller.rebaseBumps(cc, newCC, oldBumps, T, spot);
  
  console.log('Original bumps:', oldBumps.length);
  console.log('Rebased bumps:', newBumps.length);
  console.log('\n→ Bumps adjusted to maintain same cash edge with new CC');
  
  console.log('\n' + '='.repeat(50));
  console.log('TEST COMPLETE');
  console.log('='.repeat(50) + '\n');
}

// Run the test
runInventoryTest();