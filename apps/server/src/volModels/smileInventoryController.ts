/**
 * Smile-based Inventory Controller
 * Adjusts entire smile shape based on inventory, not local bumps
 */

import { SVIParams, SVI, TraderMetrics } from './dualSurfaceModel';
import { ModelConfig } from './config/modelConfig';

export interface SmileAdjustments {
  deltaL0: number;   // ATM level change
  deltaS0: number;   // Skew change
  deltaC0: number;   // Curvature change
  deltaSNeg: number; // Left wing change
  deltaSPos: number; // Right wing change
}

export interface InventoryBucket {
  vega: number;
  count: number;
  strikes: number[];
  edgeRequired?: number;
}

export class SmileInventoryController {
  private inventory: Map<string, InventoryBucket>;
  private config: ModelConfig;
  
  constructor(config: ModelConfig) {
    this.config = config;
    this.inventory = new Map();
  }
  
  /**
   * Update inventory after trade
   */
  updateInventory(strike: number, size: number, vega: number, bucket: string): void {
    let bucketInv = this.inventory.get(bucket);
    
    if (!bucketInv) {
      bucketInv = {
        vega: 0,
        count: 0,
        strikes: [],
        edgeRequired: 0
      };
      this.inventory.set(bucket, bucketInv);
    }
    
    bucketInv.vega += size * vega;
    bucketInv.count += 1;
    
    if (!bucketInv.strikes.includes(strike)) {
      bucketInv.strikes.push(strike);
    }
  }
  
  /**
   * Calculate smile adjustments based on inventory
   * This is the key function that maps inventory to smile changes
   */
  calculateSmileAdjustments(): SmileAdjustments {
    let deltaL0 = 0;
    let deltaS0 = 0;
    let deltaC0 = 0;
    let deltaSNeg = 0;
    let deltaSPos = 0;
    
    for (const [bucket, inv] of this.inventory) {
      if (Math.abs(inv.vega) < 0.1) continue;
      
      // Get edge requirement for this bucket
      const bucketConfig = this.config.buckets.find(b => b.name === bucket);
      if (!bucketConfig) continue;
      
      const { E0, kappa, gamma, Vref } = bucketConfig.edgeParams;
      
      // Calculate required edge (negative sign for SHORT position wanting higher prices)
      const normalized = Math.abs(inv.vega) / Vref;
      const edgeRequired = -Math.sign(inv.vega) * (E0 + kappa * Math.pow(normalized, gamma));
      
      // Store for diagnostics
      inv.edgeRequired = edgeRequired;
      
      // Convert edge to smile parameter changes
      // REDUCED: Was 0.01, now 0.0001 for reasonable adjustments
      const TICK_TO_VOL = 0.005;  // 0.5% vol per tick — just for debugging visibility
      
      switch (bucket) {
        case 'atm':
          // ATM inventory mainly affects level and curvature
          deltaL0 += edgeRequired * TICK_TO_VOL * 1.0;
          deltaC0 += Math.sign(inv.vega) * Math.abs(edgeRequired) * 0.0001;
          break;
          
        case 'rr25':
          // 25-delta inventory affects skew and wings
          if (inv.vega < 0) {
            // SHORT 25d puts - market maker wants higher prices
            deltaS0 += Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;  // Increase skew
            deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2; // Lower left wing
            deltaL0 += Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;   // Small ATM lift
          } else {
            // LONG 25d puts - market maker wants lower prices
            deltaS0 -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
            deltaL0 -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
          }
          break;
          
        case 'rr10':
          // 10-delta mainly affects wings
          if (inv.vega < 0) {
            deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaS0 += Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
          } else {
            deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaS0 -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
          }
          break;
          
        case 'wings':
          // Far wings - mostly affects wing slopes  
          deltaL0 += edgeRequired * TICK_TO_VOL * 0.1;  // Allow signed adjustment
          deltaSNeg += -edgeRequired * TICK_TO_VOL * 0.4;
          deltaS0 += edgeRequired * TICK_TO_VOL * 0.1;
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
   * Apply adjustments to create PC from CC
   */
  adjustSVIForInventory(ccParams: SVIParams): SVIParams {
    // Get base metrics
    const baseMetrics = SVI.toMetrics(ccParams);
    
    // Calculate adjustments
    const adjustments = this.calculateSmileAdjustments();
    
    // FIXED: Allow L0 to decrease when long (removed Math.max wrapper)
    const adjustedMetrics: TraderMetrics = {
      L0: baseMetrics.L0 + adjustments.deltaL0,  // Can now go down when long!
      S0: baseMetrics.S0 + adjustments.deltaS0,
      C0: Math.max(0.1, baseMetrics.C0 + adjustments.deltaC0),
      S_neg: baseMetrics.S_neg + adjustments.deltaSNeg,
      S_pos: baseMetrics.S_pos + adjustments.deltaSPos
    };
    
    // Ensure L0 stays positive (but allows decrease)
    if (adjustedMetrics.L0 <= 0) {
      adjustedMetrics.L0 = 0.001;  // Minimum positive value
    }
    
    // Convert back to SVI
    const sviConfig = this.createSVIConfig();
let adjustedSVI = SVI.fromMetrics(adjustedMetrics, sviConfig);

// ✅ Backoff loop: shrink the adjustment until valid
if (!SVI.validate(adjustedSVI, sviConfig)) {
  let scale = 0.5;
  const base = SVI.toMetrics(ccParams);
  while (scale > 1e-3) {
    const m: TraderMetrics = {
      L0: base.L0 + adjustments.deltaL0 * scale,
      S0: base.S0 + adjustments.deltaS0 * scale,
      C0: Math.max(0.1, base.C0 + adjustments.deltaC0 * scale),
      S_neg: base.S_neg + adjustments.deltaSNeg * scale,
      S_pos: base.S_pos + adjustments.deltaSPos * scale,
    };
    const candidate = SVI.fromMetrics(m, sviConfig);
    if (SVI.validate(candidate, sviConfig)) { adjustedSVI = candidate; break; }
    scale *= 0.5;
  }
  // If still invalid, keep CC but at least log it
  if (!SVI.validate(adjustedSVI, sviConfig)) {
    console.warn('Adjusted SVI still invalid after backoff; using CC (no PC separation).');
    return ccParams;
  }
}

return adjustedSVI;
  }
  
  /**
   * Create SVI config from model config
   */
  createSVIConfig(): any {
    return {
      bMin: this.config.svi.bMin,
      sigmaMin: this.config.svi.sigmaMin,
      rhoMax: this.config.svi.rhoMax,
      sMax: this.config.svi.slopeMax,
      c0Min: this.config.svi.c0Min,
      buckets: [],
      edgeParams: new Map(),
      rbfWidth: 0,
      ridgeLambda: 0,
      maxL0Move: 0,
      maxS0Move: 0,
      maxC0Move: 0
    };
  }
  
  /**
   * Get inventory state
   */
  getInventoryState(): Map<string, InventoryBucket> {
    return new Map(this.inventory);
  }
  
  /**
   * Get inventory summary
   */
  getInventory() {
    const total = { vega: 0, gamma: 0, theta: 0 };
    const byBucket: any = {};
    
    for (const [bucket, inv] of this.inventory) {
      total.vega += inv.vega;
      byBucket[bucket] = {
        vega: inv.vega,
        count: inv.count
      };
    }
    
    return {
      total,
      totalVega: total.vega,
      byBucket,
      smileAdjustments: this.calculateSmileAdjustments()
    };
  }
  // Return required edge (ticks) for a bucket given *our* signed vega
  getRequiredEdgeForBucket(bucket: string, signedVega: number): number {
    const cfg = this.config.buckets.find(b => b.name === bucket);
    if (!cfg) return 0;
    const { E0, kappa, gamma, Vref } = cfg.edgeParams;
    const sign = -Math.sign(signedVega); // short vega → want PC > CC (positive edge)
    const normalized = Math.abs(signedVega) / Math.max(Vref, 1e-6);
    return sign * (E0 + kappa * Math.pow(normalized, gamma));
  }

  // Solve ridge-regularized RBF alphas (tiny helper)
  solveRbfAlphas(
    targets: Array<{ k: number; deltaW: number }>,
    centers: number[],
    width: number,
    ridgeLambda: number
  ): number[] {
    const n = targets.length, m = centers.length;
    if (n === 0 || m === 0) return Array(m).fill(0);

    const Phi: number[][] = Array.from({ length: n }, () => Array(m).fill(0));
    const y: number[] = targets.map(t => t.deltaW);

    for (let i = 0; i < n; i++) {
      const ki = targets[i].k;
      for (let j = 0; j < m; j++) {
        const d = (ki - centers[j]) / width;
        Phi[i][j] = Math.exp(-0.5 * d * d);
      }
    }

    // (Phi'Phi + λI) a = Phi' y
    const Pt = (A:number[][])=>A[0].map((_,j)=>A.map(r=>r[j]));
    const mul = (A:number[][],B:number[][])=>A.map(r=>B[0].map((_,j)=>r.reduce((s,v,k)=>s+v*B[k][j],0)));
    const addRidge = (M:number[][],lam:number)=>M.map((r,i)=>r.map((v,j)=>v+(i===j?lam:0)));

    const PhiT = Pt(Phi);
    const A = addRidge(mul(PhiT,Phi), ridgeLambda);
    const bcol = mul(PhiT, [y.map(v=>v)]).map(r=>r[0]);

    // Gaussian elimination (small m)
    const aug = A.map((row,i)=>[...row, bcol[i]]);
    for (let i=0;i<m;i++){
      let p=i;
      for (let r=i+1;r<m;r++) if (Math.abs(aug[r][i])>Math.abs(aug[p][i])) p=r;
      [aug[i],aug[p]]=[aug[p],aug[i]];
      for (let r=i+1;r<m;r++){
        const f = aug[r][i]/(aug[i][i]||1e-12);
        for (let c=i;c<=m;c++) aug[r][c]-=f*aug[i][c];
      }
    }
    const a = Array(m).fill(0);
    for (let i=m-1;i>=0;i--){
      let s = aug[i][m];
      for (let c=i+1;c<m;c++) s -= aug[i][c]*a[c];
      a[i] = s/(aug[i][i]||1e-12);
    }
    return a;
  }
  
  /**
   * Clear inventory
   */
  clearInventory(): void {
    this.inventory.clear();
  }
}

/**
 * Test the smile inventory controller
 */
export function testSmileInventory(): void {
  console.log('\n' + '='.repeat(60));
  console.log('SMILE-BASED INVENTORY CONTROLLER TEST');
  console.log('='.repeat(60) + '\n');
  
  const { getDefaultConfig } = require('./config/modelConfig');
  const config = getDefaultConfig('BTC');
  
  const controller = new SmileInventoryController(config);
  
  // Simulate selling 100 lots of 25d put
  console.log('Trade: SELL 100 lots of 25-delta put\n');
  controller.updateInventory(95, -100, 0.5, 'rr25');
  
  // Calculate smile adjustments
  const adjustments = controller.calculateSmileAdjustments();
  
  console.log('Smile adjustments from inventory:');
  console.log(`  ΔL0 (ATM level):     ${(adjustments.deltaL0 * 100).toFixed(3)}% vol`);
  console.log(`  ΔS0 (Skew):          ${(adjustments.deltaS0 * 100).toFixed(3)}% vol/unit`);
  console.log(`  ΔC0 (Curvature):     ${adjustments.deltaC0.toFixed(4)}`);
  console.log(`  ΔS_neg (Left wing):  ${(adjustments.deltaSNeg * 100).toFixed(3)}% vol/unit`);
  console.log(`  ΔS_pos (Right wing): ${(adjustments.deltaSPos * 100).toFixed(3)}% vol/unit\n`);
  
  // Test with base SVI
  const baseMetrics: TraderMetrics = {
    L0: 0.04,
    S0: -0.001,
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
  };
  
  const sviConfig = controller.createSVIConfig();
  const baseCC = SVI.fromMetrics(baseMetrics, sviConfig);
  const adjustedPC = controller.adjustSVIForInventory(baseCC);
  
  // Compare metrics
  const pcMetrics = SVI.toMetrics(adjustedPC);
  
  console.log('Surface comparison:');
  console.log('Parameter | CC      | PC      | Change');
  console.log('-'.repeat(45));
  console.log(`L0        | ${baseMetrics.L0.toFixed(4)} | ${pcMetrics.L0.toFixed(4)} | ${(pcMetrics.L0 - baseMetrics.L0).toFixed(4)}`);
  console.log(`S0        | ${baseMetrics.S0.toFixed(4)} | ${pcMetrics.S0.toFixed(4)} | ${(pcMetrics.S0 - baseMetrics.S0).toFixed(4)}`);
  console.log(`C0        | ${baseMetrics.C0.toFixed(4)} | ${pcMetrics.C0.toFixed(4)} | ${(pcMetrics.C0 - baseMetrics.C0).toFixed(4)}`);
  console.log(`S_neg     | ${baseMetrics.S_neg.toFixed(4)} | ${pcMetrics.S_neg.toFixed(4)} | ${(pcMetrics.S_neg - baseMetrics.S_neg).toFixed(4)}`);
  console.log(`S_pos     | ${baseMetrics.S_pos.toFixed(4)} | ${pcMetrics.S_pos.toFixed(4)} | ${(pcMetrics.S_pos - baseMetrics.S_pos).toFixed(4)}`);
  
  // Show impact on vols
  console.log('\nImpact on implied vols:');
  console.log('Strike | CC Vol  | PC Vol  | Change');
  console.log('-'.repeat(40));
  
  const T = 0.25;
  const spot = 100;
  const strikes = [80, 90, 95, 100, 105, 110, 120];
  
  for (const strike of strikes) {
    const k = Math.log(strike / spot);
    const ccVar = SVI.w(baseCC, k);
    const pcVar = SVI.w(adjustedPC, k);
    const ccVol = Math.sqrt(ccVar / T) * 100;
    const pcVol = Math.sqrt(pcVar / T) * 100;
    const change = pcVol - ccVol;
    
    console.log(
      `${strike.toString().padStart(6)} | ` +
      `${ccVol.toFixed(2).padStart(7)}% | ` +
      `${pcVol.toFixed(2).padStart(7)}% | ` +
      `${change >= 0 ? '+' : ''}${change.toFixed(2).padStart(6)}%`
    );
  }
  
  console.log('\n' + '='.repeat(60));
}

// Run test if this is the main module
if (require.main === module) {
  testSmileInventory();
}