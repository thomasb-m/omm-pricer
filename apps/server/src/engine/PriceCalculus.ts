// server/src/engine/PriceCalculus.ts
//
// Unifying calculus for PC mid and widths: pcMid = ccMid + dot(lambda, g)
// width = w0 + alpha * |dot(lambda, g)| (+ optional inventory pressure)
// Produces bid/ask; logs useful diagnostics.

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  FactorIndex,
  Theta,
  PriceFn,
  finiteDiffGreeks,
  dot,
} from "../risk/FactorSpace";

export type Instrument = {
  symbol: string;
  strike: number;
  expiryMs: number;
  optionType: "C" | "P";
};

type RiskConfig = {
  lambda: Partial<Record<keyof typeof FactorIndex | string, number>> | number[];
  widths: { w0: number; alpha: number; beta?: number };
};

type SymbolRiskConfig = Record<string, RiskConfig>;

function loadRiskConfig(): SymbolRiskConfig {
  const p = path.resolve(process.cwd(), "src/config/risk.factors.yaml");
  if (!fs.existsSync(p)) {
    // default fallback config (BTC only)
    return {
      BTC: {
        lambda: [0.5, 0.2, 0.1, 0.15, 0.1, 0.3],
        widths: { w0: 2.0, alpha: 1.0, beta: 0.0 },
      },
    };
  }
  const doc = yaml.load(fs.readFileSync(p, "utf8")) as any;
  return doc as SymbolRiskConfig;
}

const RISK = loadRiskConfig();

function symbolLambda(symbol: string): number[] {
  const s = RISK[symbol];
  if (!s) return [0.5, 0.2, 0.1, 0.15, 0.1, 0.3];
  if (Array.isArray(s.lambda)) return s.lambda as number[];
  // allow object mapping, e.g. { L0: 0.5, S0: 0.2, ... }
  const m = s.lambda as Record<string, number>;
  const arr = new Array(6).fill(0);
  arr[FactorIndex.L0] = m.L0 ?? m["0"] ?? 0.5;
  arr[FactorIndex.S0] = m.S0 ?? m["1"] ?? 0.2;
  arr[FactorIndex.C0] = m.C0 ?? m["2"] ?? 0.1;
  arr[FactorIndex.Sneg] = m.Sneg ?? m["3"] ?? 0.15;
  arr[FactorIndex.Spos] = m.Spos ?? m["4"] ?? 0.1;
  arr[FactorIndex.F] = m.F ?? m["5"] ?? 0.3;
  return arr;
}

function symbolWidths(symbol: string) {
  const s = RISK[symbol];
  return s?.widths ?? { w0: 2.0, alpha: 1.0, beta: 0.0 };
}

export type PcQuote = {
  ccMid: number;
  pcMid: number;
  width: number;
  bid: number;
  ask: number;
  g: number[];
  dotLambdaG: number;
};

export type PricingDeps<I> = {
  // Return the *core* mid (CC) at current thetaCC for instrument
  ccMid: (inst: I) => number;
  // Price with arbitrary theta (for finite diffs). You adapt this to your model.
  priceWithTheta: PriceFn<I>;
  // Current θ for CC: [L0,S0,C0,Sneg,Spos,F]
  thetaCC: () => Theta;
  // Optional: return a scalar inventory pressure in [0, +∞) to widen spreads
  inventoryPenalty?: () => number; // start with () => 0
};

/**
 * Main entry: given an instrument and the deps (adapters to your CC model),
 * compute pcMid, width, bid, ask, and diagnostics.
 */
export function computePcQuote<I extends Instrument>(
  inst: I,
  deps: PricingDeps<I>
): PcQuote {
  const lambda = symbolLambda(inst.symbol);
  const widths = symbolWidths(inst.symbol);

  const theta = deps.thetaCC();
  const ccMid = deps.ccMid(inst);

  // factor greeks via finite-diff around CC theta
  const g = finiteDiffGreeks(deps.priceWithTheta, theta, inst);
  const lg = dot(lambda, g);

  // pricing curve mid
  const pcMid = ccMid + lg;

  // width = base + priced risk + optional inventory penalty
  const invPen = Math.max(0, deps.inventoryPenalty?.() ?? 0);
  const width = Math.max(0, widths.w0 + widths.alpha * Math.abs(lg) + invPen);

  const bid = Math.max(0, pcMid - width);
  const ask = pcMid + width;

  return {
    ccMid,
    pcMid,
    width,
    bid,
    ask,
    g,
    dotLambdaG: lg,
  };
}
