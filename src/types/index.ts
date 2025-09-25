// TypeScript interfaces for Deribit BTC Options Pricer

// ===================== Core Data Types =====================

export interface SviParams {
  a: number;      // Level parameter
  b: number;      // Volatility of volatility
  rho: number;     // Correlation parameter (-1 to 1)
  m: number;      // Mean reversion level
  s: number;      // Volatility of log-moneyness
}

export interface VolNudges {
  parallelBps: number;        // Parallel vol shift in bps
  skewBps: number;            // Skew adjustment in bps
  curvatureBps: number;       // Curvature adjustment in bps
}

export interface QuoteParams {
  baseBps: number;           // Base spread in vol bps
  wDelta: number;             // Risk weight for delta
  wGamma: number;             // Risk weight for gamma
  wVega: number;              // Risk weight for vega
  maxDSigmaBps: number;       // Cap on vol add
  minWidthBtc: number;        // Min width in BTC
  maxWidthBtc: number;         // Max width in BTC
}

// ===================== Position & Trade Data =====================

export interface Position {
  instrument: string;         // e.g., "BTC-3OCT25-110000-C"
  side: "LONG" | "SHORT";
  qty: number;                // contracts
  avg_price_btc: number;      // BTC/contract
  trade_ids: number[];        // Associated trade IDs
}

export interface Trade {
  trade_id: number;
  ts: string;                 // ISO timestamp
  instrument: string;
  side: "BUY" | "SELL";
  qty: number;                // contracts
  price_btc: number;          // BTC/contract
  fee_btc: number;
}

export interface Mark {
  instrument: string;
  mark_iv: number;           // Implied volatility
  F: number;                 // Futures price (USD)
  index_usd: number;         // BTC index price (USD)
  T_years: number;           // Time to expiry
}

// ===================== Risk & P&L =====================

export interface Greeks {
  delta: number;             // BTC per BTC
  gamma: number;             // per $1 move
  vega: number;              // BTC per vol-pt
  theta: number;             // BTC per day
}

export interface RiskMetrics {
  totalDelta: number;
  totalGamma: number;
  totalVega: number;
  totalTheta: number;
  totalPv: number;
}

export interface PnLBreakdown {
  realizedBtc: number;
  unrealizedBtc: number;
  feesBtc: number;
  realizedUsd: number;
  unrealizedUsd: number;
  totalBtc: number;
  totalUsd: number;
}

export interface PnLAttribution {
  priceMoveBtc: number;      // P&L from F moves
  volMoveBtc: number;         // P&L from vol moves
  timeDecayBtc: number;      // P&L from theta
  carryFeesBtc: number;      // P&L from carry/fees
}

// ===================== Simulation =====================

export interface SimPosition {
  scenario_id: string;
  instrument: string;
  side: "LONG" | "SHORT";
  qty: number;
}

export interface Scenario {
  scenario_id: string;
  dF_usd: number;            // F move in USD
  dSigma_bps: number;        // Vol shift in bps
  skew_bps_per_k: number;    // Skew adjustment
  dt_days: number;           // Time roll in days
}

export interface ScenarioResults {
  deltaPnL: number;
  gammaPnL: number;
  vegaPnL: number;
  thetaPnL: number;
  totalPnLBtc: number;
  totalPnLUsd: number;
}

// ===================== Quote Model =====================

export interface QuoteData {
  modelVol: number;          // SVI model volatility
  midBtc: number;            // Mid price in BTC
  bidBtc: number;            // Bid price in BTC
  askBtc: number;            // Ask price in BTC
  midUsd: number;            // Mid price in USD
  bidUsd: number;            // Bid price in USD
  askUsd: number;            // Ask price in USD
  greeks: Greeks;
  dSigmaTot: number;         // Total vol add in bps
  widthBtc: number;          // Quote width in BTC
  appliedCaps: {
    dSigmaCapped: boolean;
    widthCapped: boolean;
  };
}

// ===================== Vol Model =====================

export interface VolModelData {
  sviParams: SviParams;
  volNudges: VolNudges;
  atmStrike: number;
  autoRestrike: boolean;
  diagnostics: {
    minIV: number;
    maxIV: number;
    atmIV: number;
    slope: number;
  };
}

// ===================== Database Schema =====================

export interface DatabaseSchema {
  Positions: Position[];
  Trades: Trade[];
  Marks: Mark[];
  PnLParams: {
    mark_source: "MODEL" | "MID" | "LAST";
    index_usd: number;
    F: number;
  };
  SimPositions: SimPosition[];
  Scenarios: Scenario[];
}

// ===================== API Responses =====================

export interface RiskResponse {
  portfolioTotals: RiskMetrics;
  byExpiry: Record<string, RiskMetrics>;
  byStrike: Array<{
    instrument: string;
    side: string;
    qty: number;
    greeks: Greeks;
    pv: number;
    mark_iv: number;
  }>;
  hedgeSuggestions: {
    futuresHedge: number;
    vegaExposure: number;
  };
}

export interface PnLResponse {
  summary: PnLBreakdown;
  attribution: PnLAttribution;
  byInstrument: Record<string, {
    realizedBtc: number;
    unrealizedBtc: number;
    feesBtc: number;
    currentPosition: number;
    avgCost: number;
  }>;
  parameters: {
    mark_source: "MODEL" | "MID" | "LAST";
    index_usd: number;
    F: number;
    last_updated: string;
  };
}

// ===================== Utility Types =====================

export type InstrumentType = "BTC-3OCT25-110000-C" | "BTC-3OCT25-111000-C" | "BTC-3OCT25-112000-C" | 
                           "BTC-3OCT25-110000-P" | "BTC-3OCT25-111000-P" | "BTC-3OCT25-112000-P";

export type ExpiryType = "3OCT25" | "31OCT25" | "28NOV25";

export type SideType = "LONG" | "SHORT" | "BUY" | "SELL";

export type MarkSourceType = "MODEL" | "MID" | "LAST";

// ===================== Constants =====================

export const DERIBIT_CONVENTIONS = {
  SETTLEMENT_CURRENCY: "BTC",
  EXPIRY_TIME: "08:00 UTC",
  CONTRACT_SIZE: 1, // BTC per contract
  DISCOUNT_FACTOR: 1.0, // DF≈1 for futures options
} as const;

export const DEFAULT_SVI_PARAMS: SviParams = {
  a: 0.08,
  b: 0.45,
  rho: -0.25,
  m: 0.00,
  s: 0.15
};

export const DEFAULT_QUOTE_PARAMS: QuoteParams = {
  baseBps: 8,
  wDelta: 0.02,
  wGamma: 1000,
  wVega: 0.05,
  maxDSigmaBps: 300,
  minWidthBtc: 0.0001,
  maxWidthBtc: 0.01
};
