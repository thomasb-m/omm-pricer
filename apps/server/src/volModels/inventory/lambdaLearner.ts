/**
 * Online ridge regression for learning per-factor lambda (λ)
 * 
 * Model: (fill - ccMid) ≈ Σ_i λ_i × (I_i × g_i)
 * 
 * Features:
 * - Diagonal-only (per-factor learning, no cross-terms)
 * - EWMA variance normalization for stability
 * - Bounded updates (caps on λ to prevent explosion)
 * - Weighted by trade size (optional)
 */

export interface LambdaLearnerConfig {
    numFactors: number;      // Dimension of factor space
    alpha: number;           // Learning rate (0-1, default: 0.02)
    cap: number;            // Max absolute value for λ (default: 1.0)
    ewmaDecay: number;      // EWMA decay for variance (default: 0.99)
    minVariance: number;    // Floor for variance (default: 1e-9)
    initial?: number[];     // Initial λ values (default: zeros)
  }
  
  export interface FillObservation {
    fillPrice: number;       // Actual fill price
    ccMid: number;          // CC mid at time of quote
    gPrice: number[];       // Factor greeks ∂P/∂factor
    inventory: number[];    // Factor inventory at time of quote
    size: number;           // Trade size (for weighting)
    timestamp: number;      // When fill occurred
  }
  
  export interface LambdaStats {
    lambda: number[];           // Current λ values
    variance: number[];         // EWMA variance per feature
    numUpdates: number;         // Total updates performed
    recentError: number;        // Recent prediction error (EWMA)
    recentR2: number;          // Explained variance (rough estimate)
  }
  
  export class LambdaLearner {
    private lambda: number[];
    private vEWMA: number[];        // EWMA variance per feature
    private errorEWMA: number;      // EWMA of squared errors
    private varExplainedEWMA: number; // EWMA of explained variance
    private numUpdates: number;
    
    private config: Required<LambdaLearnerConfig>;
  
    constructor(config: LambdaLearnerConfig) {
      this.config = {
        numFactors: config.numFactors,
        alpha: config.alpha ?? 0.02,
        cap: config.cap ?? 1.0,
        ewmaDecay: config.ewmaDecay ?? 0.99,
        minVariance: config.minVariance ?? 1e-9,
        initial: config.initial ?? Array(config.numFactors).fill(0)
      };
  
      // Initialize
      this.lambda = [...this.config.initial];
      this.vEWMA = Array(config.numFactors).fill(1e-6);
      this.errorEWMA = 0;
      this.varExplainedEWMA = 0;
      this.numUpdates = 0;
    }
  
    /**
     * Get current lambda values
     */
    getLambda(): number[] {
      return [...this.lambda];
    }
  
    /**
     * Get statistics on learning performance
     */
    getStats(): LambdaStats {
      return {
        lambda: this.getLambda(),
        variance: [...this.vEWMA],
        numUpdates: this.numUpdates,
        recentError: Math.sqrt(this.errorEWMA),
        recentR2: this.varExplainedEWMA
      };
    }
  
    /**
     * Update lambda from a fill observation
     * 
     * @param obs - Fill observation with realized price and context
     * @param weighted - If true, weight update by trade size
     */
    update(obs: FillObservation, weighted: boolean = false): void {
      const { fillPrice, ccMid, gPrice, inventory, size } = obs;
      const d = this.config.numFactors;
  
      // Target: (fill - ccMid) = realized edge
      const y = fillPrice - ccMid;
  
      // Features: z_i = I_i × g_i (inventory × greek for each factor)
      const z = new Array(d);
      for (let i = 0; i < d; i++) {
        z[i] = (inventory[i] ?? 0) * (gPrice[i] ?? 0);
      }
  
      // Update EWMA variance for each feature
      for (let i = 0; i < d; i++) {
        this.vEWMA[i] = this.config.ewmaDecay * this.vEWMA[i] + 
                        (1 - this.config.ewmaDecay) * (z[i] * z[i] + this.config.minVariance);
      }
  
      // Current prediction: ŷ = λ · z
      const yPred = this.dot(this.lambda, z);
      const error = y - yPred;
  
      // Update error EWMA (for monitoring)
      this.errorEWMA = this.config.ewmaDecay * this.errorEWMA + 
                       (1 - this.config.ewmaDecay) * (error * error);
  
      // Update explained variance estimate
      const varExplained = yPred * yPred / Math.max(y * y, 1e-12);
      this.varExplainedEWMA = this.config.ewmaDecay * this.varExplainedEWMA +
                              (1 - this.config.ewmaDecay) * varExplained;
  
      // Weight by size if requested
      const weight = weighted ? Math.sqrt(Math.abs(size)) : 1.0;
  
      // Gradient descent update (per-factor, diagonal approximation)
      // ∂L/∂λ_i = -error × z_i
      for (let i = 0; i < d; i++) {
        // Normalized gradient (ridge regression with EWMA variance)
        const grad = (error * z[i] * weight) / Math.max(this.vEWMA[i], this.config.minVariance);
        
        // Update with learning rate
        this.lambda[i] += this.config.alpha * grad;
        
        // Clip to bounds
        this.lambda[i] = this.clamp(this.lambda[i], -this.config.cap, this.config.cap);
      }
  
      this.numUpdates++;
    }
  
    /**
     * Batch update from multiple observations
     */
    updateBatch(observations: FillObservation[], weighted: boolean = false): void {
      for (const obs of observations) {
        this.update(obs, weighted);
      }
    }
  
    /**
     * Reset learning state (keep config)
     */
    reset(newLambda?: number[]): void {
      if (newLambda) {
        if (newLambda.length !== this.config.numFactors) {
          throw new Error(`Lambda dimension mismatch: got ${newLambda.length}, expected ${this.config.numFactors}`);
        }
        this.lambda = [...newLambda];
      } else {
        this.lambda = [...this.config.initial];
      }
      
      this.vEWMA = Array(this.config.numFactors).fill(1e-6);
      this.errorEWMA = 0;
      this.varExplainedEWMA = 0;
      this.numUpdates = 0;
    }
  
    /**
     * Predict edge for given inventory and greeks (without updating)
     */
    predict(gPrice: number[], inventory: number[]): number {
      const z = new Array(this.config.numFactors);
      for (let i = 0; i < this.config.numFactors; i++) {
        z[i] = (inventory[i] ?? 0) * (gPrice[i] ?? 0);
      }
      return this.dot(this.lambda, z);
    }
  
    /**
     * Export current state for persistence
     */
    export(): {
      lambda: number[];
      vEWMA: number[];
      errorEWMA: number;
      numUpdates: number;
      config: Required<LambdaLearnerConfig>;
    } {
      return {
        lambda: [...this.lambda],
        vEWMA: [...this.vEWMA],
        errorEWMA: this.errorEWMA,
        numUpdates: this.numUpdates,
        config: { ...this.config }
      };
    }
  
    /**
     * Import state from persistence
     */
    import(state: ReturnType<typeof this.export>): void {
      this.lambda = [...state.lambda];
      this.vEWMA = [...state.vEWMA];
      this.errorEWMA = state.errorEWMA;
      this.numUpdates = state.numUpdates;
      // Note: config is not updated on import (set at construction)
    }
  
    // ============================================================
    // Private helpers
    // ============================================================
  
    private dot(a: number[], b: number[]): number {
      let sum = 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        sum += (a[i] ?? 0) * (b[i] ?? 0);
      }
      return sum;
    }
  
    private clamp(x: number, min: number, max: number): number {
      return Math.max(min, Math.min(x, max));
    }
  }
  
  /**
   * Factory for creating learners with common configs
   */
  export class LambdaLearnerFactory {
    static createDefault(numFactors: number): LambdaLearner {
      return new LambdaLearner({
        numFactors,
        alpha: 0.02,
        cap: 1.0,
        ewmaDecay: 0.99,
        minVariance: 1e-9
      });
    }
  
    static createAggressive(numFactors: number): LambdaLearner {
      return new LambdaLearner({
        numFactors,
        alpha: 0.05,       // Faster learning
        cap: 2.0,          // Wider bounds
        ewmaDecay: 0.95,   // Less smoothing
        minVariance: 1e-9
      });
    }
  
    static createConservative(numFactors: number): LambdaLearner {
      return new LambdaLearner({
        numFactors,
        alpha: 0.01,       // Slower learning
        cap: 0.5,          // Tighter bounds
        ewmaDecay: 0.99,   // More smoothing
        minVariance: 1e-9
      });
    }
  }