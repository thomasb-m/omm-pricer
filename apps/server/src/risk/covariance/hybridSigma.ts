// apps/server/src/risk/covariance/hybridSigma.ts
/**
 * Hybrid Covariance Estimator
 * 
 * Blends:
 * 1. SVI parameter priors (projected into price-space factors)
 * 2. Learned covariance from market (EWMA + Ledoit-Wolf)
 * 
 * α adaptive per-expiry based on sample count and fit quality
 */

import { SigmaService } from '../SigmaService';

export interface HybridSigmaConfig {
  // Per-expiry state
  expiryMs: number;
  
  // SVI parameter priors (your CC structure)
  sviPriors: {
    L0: number;    // Variance level volatility
    S0: number;    // Skew volatility
    C0: number;    // Curvature volatility
    Sneg: number;  // Left wing volatility
    Spos: number;  // Right wing volatility
    F: number;     // Forward volatility
  };
  
  // Blend parameters
  alphaStart: number;   // Initial trust in prior (default 0.9)
  alphaFloor: number;   // Minimum alpha (default 0.2)
  decayRate: number;    // Samples to half-life (default 500)
}

export interface ProjectionResult {
  H: number[][];           // Projector matrix
  Sigma_prior: number[][]; // Projected SVI covariance
  alpha: number;           // Current blend weight
}

export class HybridSigmaEstimator {
  private alphas = new Map<number, number>();          // Expiry → alpha
  private sampleCounts = new Map<number, number>();    // Expiry → N_effective
  private lastRMSE = new Map<number, number>();        // Expiry → fit quality
  private projectors = new Map<number, number[][]>();  // Expiry → H matrix
  
  constructor(
    private sigmaService: SigmaService,
    private configs: Map<number, HybridSigmaConfig>
  ) {
    // Initialize alphas
    for (const [expiry, config] of configs) {
      this.alphas.set(expiry, config.alphaStart);
      this.sampleCounts.set(expiry, 0);
    }
  }
  
  /**
   * Get blended covariance for an expiry
   */
  getSigma(
    expiryMs: number,
    G: number[][],      // Price-space factor greeks [m × 6]
    J_psi: number[][],  // SVI parameter greeks [m × 5 or 6]
    W: number[]         // Weights [m]
  ): number[][] {
    const config = this.configs.get(expiryMs);
    if (!config) {
      console.warn(`[HybridSigma] No config for expiry ${expiryMs}, using learned only`);
      return this.sigmaService.getSigmaRaw();
    }
    
    // Compute or retrieve projector
    let H = this.projectors.get(expiryMs);
    if (!H || this.shouldRecomputeProjector(expiryMs)) {
      H = this.computeProjector(G, J_psi, W);
      this.projectors.set(expiryMs, H);
    }
    
    // Project SVI covariance
    const Sigma_svi = this.buildSVICovariance(config.sviPriors);
    const Sigma_prior = this.projectCovariance(H, Sigma_svi);
    
    // Get learned covariance
    const Sigma_learned = this.sigmaService.getSigmaRaw();
    
    // Blend
    const alpha = this.alphas.get(expiryMs) || config.alphaStart;
    const Sigma_blended = this.blend(Sigma_prior, Sigma_learned, alpha);
    
    // Ensure PD via Ledoit-Wolf
    return this.enforcePD(Sigma_blended);
  }
  
  /**
   * Update after a fit
   */
  updateAfterFit(expiryMs: number, rmse: number, numSamples: number) {
    const config = this.configs.get(expiryMs);
    if (!config) return;
    
    // Increment effective samples
    const currentCount = this.sampleCounts.get(expiryMs) || 0;
    this.sampleCounts.set(expiryMs, currentCount + 1);
    
    // Store RMSE
    this.lastRMSE.set(expiryMs, rmse);
    
    // Update alpha (adaptive decay)
    const N = currentCount + 1;
    const baseAlpha = config.alphaFloor + 
      (config.alphaStart - config.alphaFloor) * Math.exp(-N / config.decayRate);
    
    // Boost alpha if fit is poor (need more structure)
    const rmseThreshold = 0.001;  // 10 bps
    const qualityBoost = rmse > rmseThreshold ? 0.2 : 0.0;
    
    const newAlpha = Math.min(0.95, baseAlpha + qualityBoost);
    this.alphas.set(expiryMs, newAlpha);
    
    console.log(`[HybridSigma] Updated expiry ${expiryMs}:`, {
      N,
      rmse: rmse.toFixed(6),
      alpha: newAlpha.toFixed(3)
    });
  }
  
  /**
   * Compute least-squares projector H = (G'WG)⁻¹ G'W J_psi
   */
  private computeProjector(
    G: number[][],
    J_psi: number[][],
    W: number[]
  ): number[][] {
    const m = G.length;
    const n_theta = G[0].length;      // 6 (price-space factors)
    const n_psi = J_psi[0].length;    // 5-6 (SVI params)
    
    // Compute G'W
    const GTW: number[][] = Array.from({length: n_theta}, () => Array(m).fill(0));
    for (let j = 0; j < n_theta; j++) {
      for (let i = 0; i < m; i++) {
        GTW[j][i] = G[i][j] * W[i];
      }
    }
    
    // Compute G'WG
    const GTWG: number[][] = Array.from({length: n_theta}, () => Array(n_theta).fill(0));
    for (let i = 0; i < n_theta; i++) {
      for (let j = 0; j < n_theta; j++) {
        for (let k = 0; k < m; k++) {
          GTWG[i][j] += GTW[i][k] * G[k][j];
        }
      }
    }
    
    // Add ridge for stability
    const ridge = 1e-8;
    for (let i = 0; i < n_theta; i++) {
      GTWG[i][i] += ridge;
    }
    
    // Invert (G'WG) via Cholesky
    const inv_GTWG = this.choleskyInvert(GTWG);
    
    // Compute G'W J_psi
    const GTW_Jpsi: number[][] = Array.from({length: n_theta}, () => Array(n_psi).fill(0));
    for (let i = 0; i < n_theta; i++) {
      for (let j = 0; j < n_psi; j++) {
        for (let k = 0; k < m; k++) {
          GTW_Jpsi[i][j] += GTW[i][k] * J_psi[k][j];
        }
      }
    }
    
    // H = (G'WG)⁻¹ G'W J_psi
    const H: number[][] = Array.from({length: n_theta}, () => Array(n_psi).fill(0));
    for (let i = 0; i < n_theta; i++) {
      for (let j = 0; j < n_psi; j++) {
        for (let k = 0; k < n_theta; k++) {
          H[i][j] += inv_GTWG[i][k] * GTW_Jpsi[k][j];
        }
      }
    }
    
    return H;
  }
  
  /**
   * Project SVI covariance: Σ_prior = H Σ_svi H'
   */
  private projectCovariance(H: number[][], Sigma_svi: number[][]): number[][] {
    const n_theta = H.length;
    const n_psi = H[0].length;
    
    // H Σ_svi
    const H_Sigma: number[][] = Array.from({length: n_theta}, () => Array(n_psi).fill(0));
    for (let i = 0; i < n_theta; i++) {
      for (let j = 0; j < n_psi; j++) {
        for (let k = 0; k < n_psi; k++) {
          H_Sigma[i][j] += H[i][k] * Sigma_svi[k][j];
        }
      }
    }
    
    // (H Σ_svi) H'
    const Sigma_prior: number[][] = Array.from({length: n_theta}, () => Array(n_theta).fill(0));
    for (let i = 0; i < n_theta; i++) {
      for (let j = 0; j < n_theta; j++) {
        for (let k = 0; k < n_psi; k++) {
          Sigma_prior[i][j] += H_Sigma[i][k] * H[j][k];
        }
      }
    }
    
    return Sigma_prior;
  }
  
  /**
   * Build SVI parameter covariance from priors
   */
  private buildSVICovariance(priors: HybridSigmaConfig['sviPriors']): number[][] {
    // Diagonal for now (can add correlations later)
    const params = [priors.L0, priors.S0, priors.C0, priors.Sneg, priors.Spos, priors.F];
    const n = params.length;
    
    const Sigma: number[][] = Array.from({length: n}, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      Sigma[i][i] = params[i] ** 2;
    }
    
    return Sigma;
  }
  
  /**
   * Blend: Σ = α·Σ_prior + (1-α)·Σ_learned
   */
  private blend(
    Sigma_prior: number[][],
    Sigma_learned: number[][],
    alpha: number
  ): number[][] {
    const n = Sigma_prior.length;
    const Sigma: number[][] = Array.from({length: n}, () => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        Sigma[i][j] = alpha * Sigma_prior[i][j] + (1 - alpha) * Sigma_learned[i][j];
      }
    }
    
    return Sigma;
  }
  
  /**
   * Ensure positive definite via diagonal floor
   */
  private enforcePD(Sigma: number[][]): number[][] {
    const n = Sigma.length;
    const floor = 1e-8;
    
    for (let i = 0; i < n; i++) {
      if (Sigma[i][i] < floor) {
        Sigma[i][i] = floor;
      }
    }
    
    return Sigma;
  }
  
  /**
   * Simple Cholesky inversion
   */
  private choleskyInvert(A: number[][]): number[][] {
    // Placeholder - use proper linear algebra library in production
    const n = A.length;
    const inv: number[][] = Array.from({length: n}, () => Array(n).fill(0));
    
    // Identity as fallback
    for (let i = 0; i < n; i++) {
      inv[i][i] = 1.0 / Math.max(A[i][i], 1e-12);
    }
    
    return inv;
  }
  
  private shouldRecomputeProjector(expiryMs: number): boolean {
    // Recompute if sample count is low or periodically
    const N = this.sampleCounts.get(expiryMs) || 0;
    return N < 10 || N % 100 === 0;
  }
}