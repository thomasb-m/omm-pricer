/**
 * Smile-aware inventory adjustments
 * Adjusts the entire smile shape based on inventory, not just local bumps
 */

import { SVIParams, SVI } from './dualSurfaceModel';
import { ModelConfig, getDefaultConfig } from './config/modelConfig';
import type { TraderMetrics } from './dualSurfaceModel';

export interface InventoryImpact {
  deltaL0: number;   // ATM level adjustment
  deltaS0: number;   // Skew adjustment  
  deltaC0: number;   // Curvature adjustment
  deltaSNeg: number; // Left wing adjustment
  deltaSPos: number; // Right wing adjustment
}

export class SmileAdjuster {
  /**
   * Calculate how inventory should adjust the smile
   * Based on market microstructure effects
   */
  static calculateSmileImpact(
    inventory: Map<string, { vega: number; count: number }>,
    config: ModelConfig
  ): InventoryImpact {
    let deltaL0 = 0;
    let deltaS0 = 0;
    let deltaC0 = 0;
    let deltaSNeg = 0;
    let deltaSPos = 0;
    
    // Process each bucket's contribution
    for (const [bucket, inv] of inventory) {
      if (Math.abs(inv.vega) < 0.1) continue;
      
      // Get edge requirement for this bucket
      const bucketConfig = config.buckets.find((b: any) => b.name === bucket);
      if (!bucketConfig) continue;
      
      const { E0, kappa, gamma, Vref } = bucketConfig.edgeParams;
      const normalized = Math.abs(inv.vega) / Vref;
      const edgeTicks = -Math.sign(inv.vega) * (E0 + kappa * Math.pow(normalized, gamma));
      
      // Convert edge to vol adjustments based on bucket
      // These are calibrated impacts - would be fitted to real market behavior
      
      switch (bucket) {
        case 'atm':
          deltaL0 += edgeTicks * 0.001;
          deltaC0 += Math.sign(inv.vega) * edgeTicks * 0.0002;
          break;
          
        case 'rr25':
          if (inv.vega < 0) {
            deltaS0 += edgeTicks * 0.0003;
            deltaSNeg += -edgeTicks * 0.0002;
            deltaL0 += edgeTicks * 0.0002;
          } else {
            deltaS0 -= edgeTicks * 0.0003;
            deltaSNeg -= -edgeTicks * 0.0002;
            deltaL0 -= edgeTicks * 0.0002;
          }
          
          if (inv.vega < 0 && bucket.includes('call')) {
            deltaSPos += -edgeTicks * 0.0002;
          }
          break;
          
        case 'rr10':
          if (inv.vega < 0) {
            deltaSNeg += -edgeTicks * 0.0003;
            deltaS0 += edgeTicks * 0.0002;
          } else {
            deltaSNeg -= -edgeTicks * 0.0003;
            deltaS0 -= edgeTicks * 0.0002;
          }
          break;
          
        case 'wings':
          if (inv.vega < 0) {
            deltaSNeg += -edgeTicks * 0.0004;
            deltaS0 += edgeTicks * 0.0001;
          }
          break;
      }
    }
    
    return {
      deltaL0,
      deltaS0,
      deltaC0,
      deltaSNeg,
      deltaSPos
    };
  }
  
  /**
   * Apply smile adjustments to SVI parameters
   */
  static adjustSVIForInventory(
    baseCC: SVIParams,
    inventory: Map<string, { vega: number; count: number }>,
    config: ModelConfig
  ): SVIParams {
    const baseMetrics = SVI.toMetrics(baseCC);
    const impact = this.calculateSmileImpact(inventory, config);
    
    const adjustedMetrics: TraderMetrics = {
      L0: baseMetrics.L0 + impact.deltaL0,
      S0: baseMetrics.S0 + impact.deltaS0,
      C0: baseMetrics.C0 + impact.deltaC0,
      S_neg: baseMetrics.S_neg + impact.deltaSNeg,
      S_pos: baseMetrics.S_pos + impact.deltaSPos
    };
    
    const sviConfig = {
      bMin: config.svi.bMin,
      sigmaMin: config.svi.sigmaMin,
      rhoMax: config.svi.rhoMax,
      sMax: config.svi.slopeMax,
      c0Min: config.svi.c0Min,
      buckets: [],
      edgeParams: new Map(),
      rbfWidth: 0,
      ridgeLambda: 0,
      maxL0Move: 0,
      maxS0Move: 0,
      maxC0Move: 0
    };
    
    const adjustedSVI = SVI.fromMetrics(adjustedMetrics, sviConfig);
    
    if (SVI.validate(adjustedSVI, sviConfig)) {
      return adjustedSVI;
    } else {
      console.warn('Adjusted SVI failed validation, returning base');
      return baseCC;
    }
  }
  
  /**
   * Visualize the smile adjustment
   */
  static compareSmiles(
    baseCC: SVIParams,
    adjustedPC: SVIParams,
    spot: number,
    T: number
  ): void {
    console.log('\nSmile Comparison (CC vs PC with inventory adjustment):');
    console.log('Strike | Delta | CC Vol | PC Vol | Diff');
    console.log('-'.repeat(50));
    
    const strikes = [
      spot * 0.80,
      spot * 0.90,
      spot * 0.95,
      spot * 1.00,
      spot * 1.05,
      spot * 1.10,
      spot * 1.20
    ];
    
    for (const strike of strikes) {
      const k = Math.log(strike / spot);
      
      const ccVar = SVI.w(baseCC, k);
      const pcVar = SVI.w(adjustedPC, k);
      
      const ccVol = Math.sqrt(ccVar / T) * 100;
      const pcVol = Math.sqrt(pcVar / T) * 100;
      const diff = pcVol - ccVol;
      
      const delta = 50 * Math.exp(-2 * k * k);
      
      console.log(
        `${strike.toFixed(0).padStart(6)} | ` +
        `${delta.toFixed(0).padStart(5)} | ` +
        `${ccVol.toFixed(1).padStart(6)} | ` +
        `${pcVol.toFixed(1).padStart(6)} | ` +
        `${diff > 0 ? '+' : ''}${diff.toFixed(2)}`
      );
    }
  }
}

function testSmileAdjuster() {
  const config = getDefaultConfig();
  
  const baseMetrics: TraderMetrics = {
    L0: 0.04,
    S0: -0.001,
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
  };
  
  const sviConfig = {
    bMin: config.svi.bMin,
    sigmaMin: config.svi.sigmaMin,
    rhoMax: config.svi.rhoMax,
    sMax: config.svi.slopeMax,
    c0Min: config.svi.c0Min,
    buckets: [],
    edgeParams: new Map(),
    rbfWidth: 0,
    ridgeLambda: 0,
    maxL0Move: 0,
    maxS0Move: 0,
    maxC0Move: 0
  };
  
  const baseCC = SVI.fromMetrics(baseMetrics, sviConfig);
  
  const inventory = new Map<string, { vega: number; count: number }>();
  inventory.set('rr25', { vega: -100, count: 1 });
  
  console.log('Inventory: SHORT 100 vega in 25-delta puts\n');
  
  const impact = SmileAdjuster.calculateSmileImpact(inventory, config);
  
  console.log('Expected smile adjustments:');
  console.log(`  ΔL0 (ATM level):    ${(impact.deltaL0 * 100).toFixed(2)}% vol`);
  console.log(`  ΔS0 (Skew):         ${(impact.deltaS0 * 100).toFixed(3)}% vol/unit`);
  console.log(`  ΔC0 (Curvature):    ${impact.deltaC0.toFixed(4)}`);
  console.log(`  ΔS_neg (Left wing): ${(impact.deltaSNeg * 100).toFixed(3)}% vol/unit`);
  console.log(`  ΔS_pos (Right wing):${(impact.deltaSPos * 100).toFixed(3)}% vol/unit`);
  
  const adjustedPC = SmileAdjuster.adjustSVIForInventory(baseCC, inventory, config);
  
  SmileAdjuster.compareSmiles(baseCC, adjustedPC, 100, 0.25);
  
  console.log('\nInterpretation:');
  console.log('  • Skew increased (puts more expensive relative to calls)');
  console.log('  • Left wing lowered (far OTM puts cheaper)');
  console.log('  • Small ATM lift (general vol increase)');
  console.log('  • This matches real market behavior when dealers are short puts');
  
  console.log('\n' + '='.repeat(60));
}

if (require.main === module) {
  testSmileAdjuster();
}
