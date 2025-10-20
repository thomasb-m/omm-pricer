// Tolerance constants - centralized to avoid drift

export const EPS_TV = 1e-12;           // Minimum total variance
export const EPS_T = 1e-12;            // Minimum year fraction
export const EPS_W_ABS = 1e-8;         // Absolute tolerance for w
export const EPS_CONVEXITY = 1e-6;     // Convexity violation threshold

// IV tolerance (vol-bp)
export const IV_TOL_MIN_BPS = 0.5;     // Minimum tolerance
export const IV_TOL_MAX_BPS = 5.0;     // Maximum tolerance (capped)
export const IV_TOL_PCT = 0.02;        // 2% adaptive component

// W tolerance (bp)
export const W_TOL_REL_BPS = 5.0;      // 0.5 bp = 5 in 1e4 units

// Lee bounds
export const MAX_WING_SLOPE = 2.0;
