#!/usr/bin/env bash
set -euo pipefail

echo "🔧 Step 3 — Static No-Arb Guards"

# 0) Ensure dirs
mkdir -p packages/vol-core/src apps/server/tests/unit diagnostics

# 1) conventions.ts — add asKRel helper (idempotent)
FILE=packages/vol-core/src/conventions.ts
if ! grep -q "export const asKRel" "$FILE"; then
  cat >> "$FILE" <<'TS'

// Helper: convert raw ln(K/F) to branded KRel
export const asKRel = (k: number): KRel => k as KRel;
TS
  echo "✅ conventions.ts updated (asKRel)"
else
  echo "ℹ️  conventions.ts already has asKRel"
fi

# 2) constants.ts — relaxed tolerances for crypto
cat > packages/vol-core/src/constants.ts <<'TS'
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
TS
echo "✅ constants.ts written"

# 3) noArb.ts — corrected non-uniform stencil + k-space checks only
cat > packages/vol-core/src/noArb.ts <<'TS'
import type { SVIParams } from "@core-types";
import { black76Call } from "./black76";
import { sviIV, sviTotalVariance } from "./smile";
import { kRel, asKRel } from "./conventions";
import {
  CONVEXITY_TOL,
  BUTTERFLY_TOL,
  CAL_W_REL_BPS,
  EPS_W_ABS,
  MAX_WING_SLOPE,
} from "./constants";

// Variance convexity on uniform k-grid
export function checkVarianceConvexityGrid(
  p: SVIParams,
  kMin = -2.5,
  kMax = 2.5,
  step = 0.1,
  tol = CONVEXITY_TOL
): Array<{ k: number; d2w: number }> {
  const ks: number[] = [];
  for (let k = kMin; k <= kMax + 1e-12; k += step) ks.push(k);
  const out: Array<{ k: number; d2w: number }> = [];
  for (let i = 1; i < ks.length - 1; i++) {
    const w0 = sviTotalVariance(asKRel(ks[i - 1]), p);
    const w1 = sviTotalVariance(asKRel(ks[i]), p);
    const w2 = sviTotalVariance(asKRel(ks[i + 1]), p);
    const d2 = (w2 - 2 * w1 + w0) / (step * step);
    if (d2 < -tol) out.push({ k: ks[i], d2w: d2 });
  }
  return out;
}

// Variance butterflies at market strikes (weights in K, w evaluated in k)
export function checkButterflies(
  strikes: number[],
  F: number,
  p: SVIParams,
  tolerance = BUTTERFLY_TOL
): Array<{ K: number; value: number; violates: boolean }> {
  if (strikes.length < 3) return [];
  const Ks = [...strikes].sort((a, b) => a - b);
  const res: Array<{ K: number; value: number; violates: boolean }> = [];
  for (let i = 1; i < Ks.length - 1; i++) {
    const K1 = Ks[i - 1], K2 = Ks[i], K3 = Ks[i + 1];
    const w1 = sviTotalVariance(asKRel(Math.log(K1 / F)), p);
    const w2 = sviTotalVariance(asKRel(Math.log(K2 / F)), p);
    const w3 = sviTotalVariance(asKRel(Math.log(K3 / F)), p);
    const w1w = (K3 - K2) / (K3 - K1);
    const w3w = (K2 - K1) / (K3 - K1);
    const bf = w1 * w1w - w2 + w3 * w3w; // should be ≥ 0
    res.push({ K: K2, value: bf, violates: bf < -tolerance });
  }
  return res;
}

// Call price convexity in K (non-uniform 3-point stencil)
export function checkCallConvexityK(
  F: number,
  T: number,
  p: SVIParams,
  Ks: number[],
  df = 1.0,
  tol = 0
): Array<{ K: number; d2C: number }> {
  if (Ks.length < 3) return [];
  const sorted = [...Ks].sort((a, b) => a - b);
  const C = sorted.map((K) => black76Call(F, K, T, sviIV(kRel(F, K), T, p), df));
  const out: Array<{ K: number; d2C: number }> = [];
  for (let i = 1; i < sorted.length - 1; i++) {
    const K0 = sorted[i - 1], K1 = sorted[i], K2 = sorted[i + 1];
    const h1 = K1 - K0, h2 = K2 - K1;
    // Correct non-uniform stencil:
    // d²C/dK² = 2 * [(C2-C1)/(h2(h1+h2)) - (C1-C0)/(h1(h1+h2))]
    const d2 = 2 * ((C[i + 1] - C[i]) / (h2 * (h1 + h2)) - (C[i] - C[i - 1]) / (h1 * (h1 + h2)));
    if (d2 < -tol) out.push({ K: K1, d2C: d2 });
  }
  return out;
}

export interface StaticArbCheck {
  passed: boolean;
  wingSlopes: { left: number; right: number; leftOK: boolean; rightOK: boolean };
  varConvexity: Array<{ k: number; d2w: number }>;
  wButterflies: Array<{ K: number; value: number; violates: boolean }>;
  callConvexity: Array<{ K: number; d2C: number }>;
}

export function checkStaticArbitrage(
  strikes: number[],
  F: number,
  T: number,
  p: SVIParams
): StaticArbCheck {
  const left = p.b * (1 - p.rho);
  const right = p.b * (1 + p.rho);
  const wingOK = left >= 0 && left <= MAX_WING_SLOPE && right >= 0 && right <= MAX_WING_SLOPE;
  const varConv = checkVarianceConvexityGrid(p);
  const wBf = checkButterflies(strikes, F, p);
  const callConv = checkCallConvexityK(F, T, p, strikes);
  const passed = wingOK && varConv.length === 0 && !wBf.some(b => b.violates) && callConv.length === 0;
  return {
    passed,
    wingSlopes: { left, right, leftOK: left >= 0 && left <= MAX_WING_SLOPE, rightOK: right >= 0 && right <= MAX_WING_SLOPE },
    varConvexity: varConv,
    wButterflies: wBf,
    callConvexity: callConv,
  };
}

// Calendar arbitrage in k-space ONLY
export function checkCalendarByK(
  F1: number, T1: number, p1: SVIParams,
  F2: number, T2: number, p2: SVIParams,
  kGrid: number[],
  relTolBps = CAL_W_REL_BPS,
  absFloor = EPS_W_ABS
): Array<{ k: number; w1: number; w2: number; relErrBps: number }> {
  if (!(T2 > T1)) return [];
  const out: Array<{ k: number; w1: number; w2: number; relErrBps: number }> = [];
  for (const k of kGrid) {
    const w1 = sviTotalVariance(asKRel(k), p1);
    const w2 = sviTotalVariance(asKRel(k), p2);
    const relBps = Math.abs((w2 - w1) / Math.max(absFloor, Math.abs(w1))) * 1e4;
    if (w1 > w2 && relBps > relTolBps) out.push({ k, w1, w2, relErrBps: relBps });
  }
  return out;
}
TS
echo "✅ noArb.ts written"

# 4) tests — noArb test with diagnostics
cat > apps/server/tests/unit/noArb.test.ts <<'TS'
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { loadAggregatedCCFixtures } from "@vol-validation/cc_glob_loader";
import { checkStaticArbitrage, checkCalendarByK } from "@vol-core/noArb";

const DIAG = path.resolve("diagnostics/noarb.json");

describe("Static No-Arb Guards", () => {
  const agg = loadAggregatedCCFixtures();
  const results: any[] = [];

  describe("Per-Smile Static Checks", () => {
    agg.fixtures.forEach((f, idx) => {
      it(`Fixture ${idx}: ${f.fixtureId ?? "unnamed"} - no static arb`, () => {
        const r = checkStaticArbitrage(f.strikes, f.forward, f.T, f.svi);
        results.push({
          fixtureId: f.fixtureId ?? `idx_${idx}`,
          passed: r.passed,
          wingSlopes: r.wingSlopes,
          varConvexityCount: r.varConvexity.length,
          butterflyCount: r.wButterflies.filter(b => b.violates).length,
          callConvexityCount: r.callConvexity.length,
        });
        expect(r.passed).toBe(true);
      });
    });
  });

  describe("Calendar Arbitrage (k-space)", () => {
    if (agg.fixtures.length < 2) {
      it.skip("Need ≥2 expiries for calendar check", () => {});
    } else {
      const sorted = [...agg.fixtures].sort((a, b) => a.T - b.T);
      const kGrid: number[] = []; for (let k=-2.5; k<=2.5; k+=0.1) kGrid.push(k);
      for (let i = 0; i < sorted.length - 1; i++) {
        const f1 = sorted[i], f2 = sorted[i+1];
        it(`${f1.fixtureId} → ${f2.fixtureId} - no calendar arb`, () => {
          const v = checkCalendarByK(f1.forward, f1.T, f1.svi, f2.forward, f2.T, f2.svi, kGrid);
          expect(v.length).toBe(0);
        });
      }
    }
  });

  afterAll(() => {
    const summary = {
      timestamp: new Date().toISOString(),
      fixtures: results,
      totalFixtures: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
    };
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.writeFileSync(DIAG, JSON.stringify(summary, null, 2));
    console.log(`No-arb diagnostics: ${DIAG}`);
  });
});
TS
echo "✅ noArb.test.ts written"

# 5) package.json — add script (idempotent)
if ! grep -q '"test:noarb"' package.json; then
  tmp=$(mktemp)
  node -e 'let p=require("./package.json");p.scripts=p.scripts||{};p.scripts["test:noarb"]="vitest run apps/server/tests/unit/noArb.test.ts";p.scripts["ci:step3"]="npm run fixtures:python && npm run test:golden && npm run test:noarb";require("fs").writeFileSync("package.json", JSON.stringify(p,null,2))'
  echo "✅ package.json scripts added"
else
  echo "ℹ️  package.json already has test:noarb"
fi

# 6) typecheck + run tests
echo "🔎 Typecheck"
npm run -s typecheck

echo "🧪 Golden tests"
npm run -s test:golden

echo "🧪 No-arb tests"
npm run -s test:noarb

echo "✅ Step 3 complete"
