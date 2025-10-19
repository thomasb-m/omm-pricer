/**
 * Core domain types shared across pricing, calibration and risk.
 */

export type DayCount = 'ACT_365' | 'ACT_365_25' | 'BUS_252';

export interface InstrumentMeta {
  symbol: string;              // e.g. "BTC-20251025-100000-C"
  asset: string;               // e.g. "BTC"
  multiplier: number;          // contract multiplier
  tickSize: number;
  lotSize: number;
  currency: string;            // PnL currency (e.g. "USD")
  isCall: boolean;
  strike: number;
  expirySec: number;           // unix seconds
}

export interface Quote {
  forward: number;      // forward price (pricing should happen on forward)
  rate?: number;        // optional risk-free rate (if you need discounting elsewhere)
  bid?: number;
  ask?: number;
  mid?: number;
  last?: number;
  timestampSec: number; // unix seconds
  instrument: InstrumentMeta;
}

export interface SVIParams {
  // Raw SVI: w(k) = a + b*( rho*(k-m) + sqrt( (k-m)^2 + sigma^2 ) )
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

export interface SmilePoint {
  k: number;         // log-moneyness = ln(K/F)
  iv: number;        // implied vol (annualized)
  T: number;         // time to expiry (years)
}

export interface PriceBreakdown {
  intrinsic: number;
  tv: number;       // time value (extrinsic)
  price: number;    // intrinsic + tv
}

export interface FeaturesConfig {
  enablePricing: boolean;
  enableFitter: boolean;
  enableShadow: boolean;
  usePythonGoldens?: boolean;
}

export interface PrimitivesConfig {
  daycount: DayCount;
  secondsPerYear: number;
  epsilonT: number;
}

export interface GuardsConfig {
  enforceStaticNoArb: boolean;
  maxWingSlope: number;
  minTotalVariance: number;
}

export interface TermConfig {
  method: 'monotone_convex_tv';
  shortDatedBlend?: {
    enabled: boolean;
    T_blend: number;
  };
}

export interface RiskLambdaConfig {
  learningRate: number;
  capAbs: number;
  targetVolBps: number;
  floorBps: number;
}

export interface RiskCovConfig {
  sources: Array<'factor_returns'|'pnl_innovations'>;
  alpha_structural: number;
  alpha_pc: number;
  shrinkage: 'ledoit_wolf';
  robust?: {
    huberDeltaBps: number;
    hampel: { k: number; t0: number; t1: number };
  };
  regime?: {
    decayOnShock: boolean;
    maxEigenRatio: number;
  };
}

export interface RiskConfig {
  covariance: RiskCovConfig;
  lambda: RiskLambdaConfig;
}

export interface AppConfig {
  features: FeaturesConfig;
  primitives: PrimitivesConfig;
  guards: GuardsConfig;
  term: TermConfig;
  risk: RiskConfig;
}
