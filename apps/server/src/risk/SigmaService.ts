// apps/server/src/risk/SigmaService.ts
/**
 * Phase 2: Covariance matrix estimation via EWMA on factor shocks
 * 
 * Maintains rolling Σ = Cov(Δf) where Δf = f_t - f_{t-h}
 * Adds ridge regularization and PD enforcement
 */

import { FACTORS, d, FACTOR_LABELS, FactorMatrix, validateMatrix } from './factors';
import { num } from '../utils/numeric';
import {
  outerProduct,
  addMatrix,
  scaleMatrix,
  addRidge,
  trace,
  conditionNumber,
  isPDHeuristic,
} from '../utils/linalg';

export type SigmaConfig = {
  horizonMs: number;           // Time window for Δf (e.g. 1000ms)
  alpha: number;               // EWMA decay: Σ ← α·ΔfΔfᵀ + (1-α)·Σ
  ridgeEpsilon: number;        // Ridge: ε·(tr(Σ)/d)·I
  minSamples: number;          // Min samples before Σ is "ready"
  
  // Multi-horizon blending (optional, Phase 2 Week 2)
  blendHorizons?: {
    horizonMs: number;
    weight: number;
  }[];
};

export type SigmaStats = {
  sampleCount: number;
  traceValue: number;
  conditionNumber: number;
  isPD: boolean;
  minDiagonal: number;
  maxDiagonal: number;
  lastUpdateMs: number;
};

export class SigmaService {
  private config: SigmaConfig;
  private Sigma: number[][];           // Current covariance matrix
  private lastFactorVector: number[] | null = null;
  private lastUpdateTime: number = 0;
  private sampleCount: number = 0;
  
  // Multi-horizon state (if enabled)
  private horizonStates: Map<number, {
    Sigma: number[][];
    lastVector: number[] | null;
    lastUpdate: number;
    samples: number;
  }> = new Map();
  
  constructor(config: SigmaConfig) {
    this.config = config;
    
    // Initialize Σ to small diagonal (prior)
    this.Sigma = this.initializePrior();
    
    // Initialize multi-horizon if configured
    if (config.blendHorizons) {
      for (const h of config.blendHorizons) {
        this.horizonStates.set(h.horizonMs, {
          Sigma: this.initializePrior(),
          lastVector: null,
          lastUpdate: 0,
          samples: 0,
        });
      }
    }
    
    this.validateConfig();
  }
  
  private validateConfig(): void {
    if (this.config.horizonMs <= 0) {
      throw new Error('horizonMs must be positive');
    }
    if (this.config.alpha <= 0 || this.config.alpha >= 1) {
      throw new Error('alpha must be in (0, 1)');
    }
    if (this.config.ridgeEpsilon < 0) {
      throw new Error('ridgeEpsilon must be non-negative');
    }
    
    if (this.config.blendHorizons) {
      const totalWeight = this.config.blendHorizons.reduce((s, h) => s + h.weight, 0);
      if (Math.abs(totalWeight - 1.0) > 1e-6) {
        throw new Error(`blendHorizons weights must sum to 1.0, got ${totalWeight}`);
      }
    }
  }
  
  private initializePrior(): number[][] {
    // Start with small diagonal prior (uncorrelated factors)
    const prior: number[][] = [];
    for (let i = 0; i < d; i++) {
      const row: number[] = new Array(d).fill(0);
      row[i] = 1e-4; // Small variance prior
      prior.push(row);
    }
    return prior;
  }
  
  /**
   * Update Σ with new factor vector
   * Call this every time you recompute portfolio factors (e.g. every tick)
   */
  update(factorVector: number[], timestampMs: number): void {
    if (factorVector.length !== d) {
      throw new Error(`Factor vector dimension mismatch: expected ${d}, got ${factorVector.length}`);
    }
    
    // Primary horizon update
    this.updateHorizon(
      factorVector,
      timestampMs,
      this.config.horizonMs,
      this.config.alpha
    );
    
    // Multi-horizon updates
    if (this.config.blendHorizons) {
      for (const h of this.config.blendHorizons) {
        const state = this.horizonStates.get(h.horizonMs)!;
        if (timestampMs - state.lastUpdate >= h.horizonMs) {
          this.updateSingleHorizon(
            state,
            factorVector,
            timestampMs,
            h.horizonMs,
            this.config.alpha
          );
        }
      }
      
      // Blend horizons into primary Σ
      this.blendHorizons();
    }
  }
  
  private updateHorizon(
    factorVector: number[],
    timestampMs: number,
    horizonMs: number,
    alpha: number
  ): void {
    // Check if enough time has passed
    if (this.lastUpdateTime > 0 && timestampMs - this.lastUpdateTime < horizonMs) {
      // Update last vector but don't compute Δf yet
      this.lastFactorVector = factorVector;
      return;
    }
    
    // Compute Δf if we have a previous vector
    if (this.lastFactorVector !== null) {
      const deltaF: number[] = [];
      for (let i = 0; i < d; i++) {
        const df = num(factorVector[i], `f[${i}]`) - num(this.lastFactorVector[i], `f_prev[${i}]`);
        deltaF.push(df);
      }
      
      // EWMA update: Σ ← α·ΔfΔfᵀ + (1-α)·Σ
      const deltaFOuter = outerProduct(deltaF, deltaF);
      const scaledOuter = scaleMatrix(deltaFOuter, alpha);
      const scaledSigma = scaleMatrix(this.Sigma, 1 - alpha);
      this.Sigma = addMatrix(scaledOuter, scaledSigma);
      
      // Add ridge: Σ ← Σ + ε·(tr(Σ)/d)·I
      this.Sigma = addRidge(this.Sigma, this.config.ridgeEpsilon);
      
      // Enforce PD (clip negative diagonal if needed)
      this.enforcePD();
      
      this.sampleCount++;
    }
    
    this.lastFactorVector = factorVector;
    this.lastUpdateTime = timestampMs;
  }
  
  private updateSingleHorizon(
    state: { Sigma: number[][], lastVector: number[] | null, lastUpdate: number, samples: number },
    factorVector: number[],
    timestampMs: number,
    horizonMs: number,
    alpha: number
  ): void {
    if (state.lastVector !== null) {
      const deltaF: number[] = [];
      for (let i = 0; i < d; i++) {
        const df = num(factorVector[i], `f[${i}]`) - num(state.lastVector[i], `f_prev[${i}]`);
        deltaF.push(df);
      }
      
      const deltaFOuter = outerProduct(deltaF, deltaF);
      const scaledOuter = scaleMatrix(deltaFOuter, alpha);
      const scaledSigma = scaleMatrix(state.Sigma, 1 - alpha);
      state.Sigma = addMatrix(scaledOuter, scaledSigma);
      state.Sigma = addRidge(state.Sigma, this.config.ridgeEpsilon);
      
      state.samples++;
    }
    
    state.lastVector = factorVector;
    state.lastUpdate = timestampMs;
  }
  
  private blendHorizons(): void {
    if (!this.config.blendHorizons) return;
    
    // Weighted average: Σ = Σ w_i Σ_i
    const blended: number[][] = [];
    for (let i = 0; i < d; i++) {
      blended.push(new Array(d).fill(0));
    }
    
    for (const h of this.config.blendHorizons) {
      const state = this.horizonStates.get(h.horizonMs);
      if (!state || state.samples < this.config.minSamples) continue;
      
      const weighted = scaleMatrix(state.Sigma, h.weight);
      for (let i = 0; i < d; i++) {
        for (let j = 0; j < d; j++) {
          blended[i][j] += weighted[i][j];
        }
      }
    }
    
    this.Sigma = blended;
  }
  
  private enforcePD(): void {
    // Simple approach: ensure all diagonal elements are positive
    // Clip to small positive value if negative
    for (let i = 0; i < d; i++) {
      if (this.Sigma[i][i] < 1e-8) {
        this.Sigma[i][i] = 1e-8;
      }
    }
  }
  
  /**
   * Get current covariance matrix (with metadata)
   */
  getSigma(): FactorMatrix {
    return {
      version: FACTORS.version,
      labels: [...FACTOR_LABELS],
      matrix: this.Sigma.map(row => [...row]), // deep copy
    };
  }
  
  /**
   * Get raw matrix (for fast math)
   */
  getSigmaRaw(): number[][] {
    return this.Sigma;
  }
  
  /**
   * Check if Σ is ready (enough samples)
   */
  isReady(): boolean {
    return this.sampleCount >= this.config.minSamples;
  }
  
  /**
   * Get diagnostics
   */
  getStats(): SigmaStats {
    const tr = trace(this.Sigma);
    const kappa = conditionNumber(this.Sigma);
    const pd = isPDHeuristic(this.Sigma);
    
    let minDiag = Infinity;
    let maxDiag = -Infinity;
    for (let i = 0; i < d; i++) {
      minDiag = Math.min(minDiag, this.Sigma[i][i]);
      maxDiag = Math.max(maxDiag, this.Sigma[i][i]);
    }
    
    return {
      sampleCount: this.sampleCount,
      traceValue: tr,
      conditionNumber: kappa,
      isPD: pd,
      minDiagonal: minDiag,
      maxDiagonal: maxDiag,
      lastUpdateMs: this.lastUpdateTime,
    };
  }
  
  /**
   * Reset state (e.g. for new trading session)
   */
  reset(): void {
    this.Sigma = this.initializePrior();
    this.lastFactorVector = null;
    this.lastUpdateTime = 0;
    this.sampleCount = 0;
    
    if (this.config.blendHorizons) {
      for (const [horizonMs, state] of this.horizonStates) {
        state.Sigma = this.initializePrior();
        state.lastVector = null;
        state.lastUpdate = 0;
        state.samples = 0;
      }
    }
  }
}