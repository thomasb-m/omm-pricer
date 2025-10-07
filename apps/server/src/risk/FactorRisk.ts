// apps/server/src/risk/FactorRisk.ts
/**
 * Phase 2: Core quadratic risk model
 * 
 * Inputs: g (greeks), I (inventory), Σ (covariance)
 * Outputs: skew, halfSpread, size
 * 
 * Formulas:
 * - Λ = γ(Σ + ε·(trΣ/d)I)
 * - λ = ΛI (inventory price vector)
 * - skew = λ·g
 * - s_model = z√(gᵀΣg)
 * - s_inv = κ·min(1, ||I||_Λ / L)·s_model
 * - q* = clamp((edge - s_buffers)/(gᵀΛg), 0, q_max)
 */

import { d, FactorVector, validateVector } from './factors';
import { num, clamp } from '../utils/numeric';
import {
  matVec,
  dot,
  quadForm,
  normMahalanobis,
  scaleMatrix,
  addRidge,
} from '../utils/linalg';

export type RiskConfig = {
  gamma: number;               // Risk aversion (scales Λ)
  z: number;                   // Model uncertainty spread multiplier
  eta: number;                 // Microstructure noise multiplier
  kappa: number;               // Inventory widening multiplier
  L: number;                   // Inventory limit in Λ-norm
  ridgeEpsilon: number;        // Ridge on Λ (same as Σ typically)
  feeBuffer: number;           // Fee + tick cushion ($ per contract)
  
  // Size parameters
  qMax: number;                // Max size per side
  minEdge: number;             // Min edge before quoting ($ per contract)
};

export type SpreadComponents = {
  fee: number;                 // Fees + tick cushion
  noise: number;               // Microstructure (η·σ_md)
  model: number;               // Model uncertainty (z·√(gᵀΣg))
  inventory: number;           // Inventory widening (κ·...)
  total: number;               // Sum of above
};

export type QuoteParams = {
  theoRaw: number;             // Unadjusted theoretical mid
  theoInv: number;             // Inventory-adjusted mid (theoRaw - skew)
  skew: number;                // λ·g (inventory price)
  spreadComponents: SpreadComponents;
  bid: number;                 // theoInv - s_total
  ask: number;                 // theoInv + s_total
  sizeBid: number;             // Optimal size (bid side)
  sizeAsk: number;             // Optimal size (ask side)
  
  // Diagnostics
  gLambdaG: number;            // gᵀΛg (quadratic penalty)
  inventoryUtilization: number; // ||I||_Λ / L
  factorContributions?: number[]; // (Λg) .* g element-wise
};

export class FactorRisk {
  private config: RiskConfig;
  private Lambda: number[][] | null = null; // Cached Λ = γ(Σ + ridge)
  private lambdaVec: number[] | null = null; // Cached λ = ΛI
  private inventoryNorm: number = 0;         // Cached ||I||_Λ
  
  constructor(config: RiskConfig) {
    this.config = config;
    this.validateConfig();
  }
  
  private validateConfig(): void {
    if (this.config.gamma <= 0) throw new Error('gamma must be positive');
    if (this.config.z < 0) throw new Error('z must be non-negative');
    if (this.config.eta < 0) throw new Error('eta must be non-negative');
    if (this.config.kappa < 0) throw new Error('kappa must be non-negative');
    if (this.config.L <= 0) throw new Error('L must be positive');
    if (this.config.qMax <= 0) throw new Error('qMax must be positive');
  }
  
  /**
   * Update risk state with new Σ and inventory
   * Call this whenever Σ or I changes (typically once per tick)
   */
  updateState(Sigma: number[][], inventory: number[]): void {
    if (Sigma.length !== d || inventory.length !== d) {
      throw new Error(`Dimension mismatch: expected ${d}`);
    }
    
    // Compute Λ = γ(Σ + ε·(trΣ/d)I)
    const SigmaRidged = addRidge(Sigma, this.config.ridgeEpsilon);
    this.Lambda = scaleMatrix(SigmaRidged, this.config.gamma);
    
    // Compute λ = ΛI
    this.lambdaVec = matVec(this.Lambda, inventory);
    
    // Compute ||I||_Λ = √(IᵀΛI)
    this.inventoryNorm = normMahalanobis(inventory, this.Lambda);
  }
  
  /**
   * Compute quote parameters for a given instrument
   * 
   * @param g - Factor greeks of instrument
   * @param theoRaw - Unadjusted theoretical mid
   * @param sigmaMD - Microstructure volatility (mid returns @ 100-300ms)
   * @param mid - Current market mid (for edge calculation)
   * @returns Complete quote parameters
   */
  computeQuote(
    g: number[],
    theoRaw: number,
    sigmaMD: number,
    mid: number
  ): QuoteParams {
    if (!this.Lambda || !this.lambdaVec) {
      throw new Error('Must call updateState() before computeQuote()');
    }
    
    if (g.length !== d) {
      throw new Error(`Greeks dimension mismatch: expected ${d}, got ${g.length}`);
    }
    
    // A) Skew (inventory price): λ·g
    const skew = num(dot(this.lambdaVec, g), 'skew');
    
    // B) Inventory-adjusted theo
    const theoInv = num(theoRaw - skew, 'theoInv');
    
    // C) Spread components
    const s_fee = this.config.feeBuffer;
    const s_noise = num(this.config.eta * sigmaMD, 's_noise');
    const s_model = num(
      this.config.z * Math.sqrt(Math.max(0, quadForm(this.Lambda, g) / this.config.gamma)),
      's_model'
    );
    
    // Inventory widening: κ·min(1, ||I||_Λ / L)·s_model
    const utilization = this.inventoryNorm / this.config.L;
    const s_inv = num(
      this.config.kappa * Math.min(1, utilization) * s_model,
      's_inv'
    );
    
    const s_total = s_fee + s_noise + s_model + s_inv;
    
    const spreadComponents: SpreadComponents = {
      fee: s_fee,
      noise: s_noise,
      model: s_model,
      inventory: s_inv,
      total: s_total,
    };
    
    // D) Firm quotes
    const bid = theoInv - s_total;
    const ask = theoInv + s_total;
    
    // E) Optimal size: q* = (edge - s_buffers) / (gᵀΛg)
    const gLambdaG = num(quadForm(this.Lambda, g), 'gLambdaG');
    const denom = Math.max(gLambdaG, 1e-12); // Floor to avoid division by zero
    
    const edgeBid = Math.abs(theoInv - Math.max(bid, mid));
    const edgeAsk = Math.abs(theoInv - Math.min(ask, mid));
    
    const s_buffers = s_fee + s_noise;
    
    const sizeBid = clamp(
      (edgeBid - s_buffers) / denom,
      0,
      this.config.qMax
    );
    
    const sizeAsk = clamp(
      (edgeAsk - s_buffers) / denom,
      0,
      this.config.qMax
    );
    
    // F) Diagnostics: factor contributions (Λg) .* g
    const Lambdag = matVec(this.Lambda, g);
    const factorContributions = g.map((gi, i) => 
      num(gi, 'g') * num(Lambdag[i], 'Lambdag')
    );
    
    return {
      theoRaw,
      theoInv,
      skew,
      spreadComponents,
      bid,
      ask,
      sizeBid,
      sizeAsk,
      gLambdaG,
      inventoryUtilization: utilization,
      factorContributions,
    };
  }
  
  /**
   * Get current inventory utilization (for monitoring)
   */
  getInventoryUtilization(): number {
    return this.inventoryNorm / this.config.L;
  }
  
  /**
   * Get current Lambda matrix (for diagnostics)
   */
  getLambda(): number[][] | null {
    return this.Lambda ? this.Lambda.map(row => [...row]) : null;
  }
  
  /**
   * Get current lambda vector (for diagnostics)
   */
  getLambdaVec(): number[] | null {
    return this.lambdaVec ? [...this.lambdaVec] : null;
  }
  
  /**
   * Update config (e.g. for online tuning)
   */
  updateConfig(partial: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...partial };
    this.validateConfig();
  }
}