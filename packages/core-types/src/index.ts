export type DayCount = 'ACT_365' | 'ACT_365_25' | 'BUS_252';

export interface InstrumentMeta {
  symbol: string;
  asset: string;
  multiplier: number;
  tickSize: number;
  lotSize: number;
  currency: string;
  isCall: boolean;
  strike: number;
  expirySec: number;
}

export interface Quote {
  forward: number;
  rate?: number;
  bid?: number;
  ask?: number;
  mid?: number;
  last?: number;
  timestampSec: number;
  instrument: InstrumentMeta;
}

export interface SVIParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

export interface SmilePoint {
  k: number;
  iv: number;
  T: number;
}

export interface PriceBreakdown {
  intrinsic: number;
  tv: number; // time value
  price: number;
  iv?: number;  // optional
  vega?: number;
  delta?: number;
  gamma?: number;
  df?: number;  // ADDED
  T?: number;   // ADDED
}

// Config types
export interface FeaturesConfig {
  enablePricing: boolean;
  enableFitter: boolean;
  enableShadow: boolean;
  usePythonGoldens?: boolean;
}

export interface PrimitivesConfig {
  daycount: DayCount;
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
