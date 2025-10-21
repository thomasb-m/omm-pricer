export const EPS_TV = 1e-12;
export const EPS_T  = 1e-12;
export const EPS_W_ABS = 1e-10;

// NO-ARB tolerances (crypto-friendly; tighten later if desired)
export const CONVEXITY_TOL = 3e-6;
export const BUTTERFLY_TOL = 1e-8;
export const CAL_W_REL_BPS = 2.0;

// IV tolerance (vol-bp) used elsewhere
export const IV_TOL_MIN_BPS = 0.5;
export const IV_TOL_MAX_BPS = 5.0;
export const IV_TOL_PCT     = 0.02;

// W tolerance (bp)
export const W_TOL_REL_BPS = 5.0;

// Lee bound on wing slopes
export const MAX_WING_SLOPE = 2.0;
export const EPS_CONVEXITY = CONVEXITY_TOL; // back-compat alias for smile.ts
