// apps/server/src/volModels/sviMapping.ts
// Centralized, canonical mapping between SVI params and Trader metrics.
// This is the ONLY place where the identities are defined.

// Types you already have somewhere; keep or adjust imports as needed
export type SVIParams = {
    a: number;
    b: number;
    rho: number;   // in (-1, 1)
    sigma: number; // > 0
    m: number;     // smile center (we keep 0 here for trader metrics)
  };
  
  export type TraderMetrics = {
    L0: number;    // level  ≈ a + bσ
    S0: number;    // ATM skew = bρ      (derived)
    C0: number;    // curvature ≈ b/σ
    S_neg: number; // left wing slope  = b(1-ρ)
    S_pos: number; // right wing slope = b(1+ρ)
  };
  
  export type Config = {
    rhoMax?: number;   // default 0.999
    c0Min?: number;    // default 1e-8
    bMin?: number;     // default 1e-8
    sigmaMin?: number; // default 1e-8
  };
  
  // ---- Canonical identities ----
  // S_pos = b(1+ρ), S_neg = b(1-ρ)
  // b    = (S_pos + S_neg)/2
  // ρ    = (S_pos - S_neg)/(S_pos + S_neg)
  // S0   = bρ
  // C0  ≈ b/σ
  // L0   = a + bσ
  
  export function toMetrics(cc: SVIParams): TraderMetrics {
    const { a, b, rho, sigma } = cc;
    const S_pos = b * (1 + rho);
    const S_neg = b * (1 - rho);
    const L0 = a + b * sigma;
    const C0 = b / sigma;
    const S0 = b * rho;
    return { L0, S0, C0, S_neg, S_pos };
  }
  
  export function fromMetrics(m: TraderMetrics, cfg: Config, opt?: { preserveBumps?: boolean }): SVIParams {
    const eps = 1e-12;
    const rhoMax = cfg.rhoMax ?? 0.999;
    const c0Min  = cfg.c0Min  ?? 1e-8;
    const bMin   = cfg.bMin   ?? 1e-8;
    const sigmaMin = cfg.sigmaMin ?? 1e-8;
  
    const Sp = m.S_pos;
    const Sn = m.S_neg;
    const Ssum = Sp + Sn;
  
    // Correct identities
    let b_raw = 0.5 * Ssum;
    // b must be positive for canonical SVI
    let b = Math.max(Math.abs(b_raw), bMin);
  
    // rho via (diff/sum); optionally blend with S0/b when wings are nearly symmetric
    let rho_raw = (Sp - Sn) / Math.max(Math.abs(Ssum), eps);
  
    if (opt?.preserveBumps) {
      // blend rho toward S0/b only when symmetry makes (diff/sum) unstable
      if (Math.abs(Ssum) < 1e-6) {
        const rho_from_S0 = m.S0 / Math.max(b, bMin);
        rho_raw = 0.75 * rho_raw + 0.25 * rho_from_S0;
      }
    }
  
    const rho = Math.max(-rhoMax, Math.min(rhoMax, rho_raw));
  
    // C0 ≈ b/σ → σ ≈ b/C0
    const sigma_raw = b / Math.max(m.C0, c0Min);
    const sigma = Math.max(sigma_raw, sigmaMin);
  
    // L0 = a + bσ → a = L0 - bσ
    const a = m.L0 - b * sigma;
  
    return { a, b, rho, sigma, m: 0 };
  }
  
  // Backwards-compatible export if other files expect SVI.toMetrics/fromMetrics
  export const SVI = { toMetrics, fromMetrics };
  