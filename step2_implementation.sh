#!/usr/bin/env bash
# ============================================================================
# STEP 2 SURGICAL FIXES - Terminal Implementation Guide
# Execute these commands in order. Each section keeps the build green.
# ============================================================================

set -e  # Exit on error

echo "🔧 Starting Step 2 surgical fixes implementation..."
echo ""

# ============================================================================
# STEP 1: Rename TV → W (Total Variance)
# ============================================================================

echo "📝 STEP 1: Rename marketTV → marketW"
echo "----------------------------------------"

# 1a. Update Python aggregator
cat > vol-core-validation/aggregate_results_to_ts.py << 'EOF'
#!/usr/bin/env python3
import json, glob, os, math
from pathlib import Path

OUT_DIR = Path('vol-core-validation/output')
OUT_DIR.mkdir(parents=True, exist_ok=True)

def load_one(path):
    with open(path, 'r') as f:
        d = json.load(f)
    
    forward = d.get('forward') or d.get('F') or d.get('forward_price')
    T = d.get('T') or d.get('time') or d.get('tau')
    strikes = d.get('strikes') or d.get('K') or d.get('ks') or []
    svi = d.get('svi_params') or d.get('svi') or {}
    ivs = d.get('ivs') or d.get('marketIV') or d.get('implied_vols')
    
    # RENAMED: tvs → ws (total variance)
    ws = d.get('tvs') or d.get('marketTV') or d.get('marketW') or None
    df = d.get('df') or d.get('discount_factor') or 1.0
    
    if not (forward and T and strikes and svi and ivs):
        raise ValueError(f"Missing required keys in {path}")
    
    if ws is None:
        # Derive w from IVs: w = (iv^2)*T
        ws = [(max(1e-12, float(iv))**2) * float(T) for iv in ivs]
    
    svi_mapped = {
        'a': float(svi['a']),
        'b': float(svi['b']),
        'rho': float(svi['rho']),
        'm': float(svi['m']),
        'sigma': float(svi['sigma'])
    }
    
    return {
        'forward': float(forward),
        'T': float(T),
        'strikes': [float(k) for k in strikes],
        'marketIV': [float(x) for x in ivs],
        'marketW': [float(x) for x in ws],  # RENAMED
        'svi': svi_mapped,
        'df': float(df)
    }

def main():
    files = glob.glob(str(OUT_DIR / "*_result.json"))
    if not files:
        print("WARN: No *_result.json files found under vol-core-validation/output/")
    fixtures = []
    for p in files:
        try:
            fixtures.append(load_one(p))
        except Exception as e:
            print(f"SKIP {p}: {e}")
    out = { 'fixtures': fixtures }
    OUT = OUT_DIR / "cc_fixtures.json"
    OUT.write_text(json.dumps(out, indent=2))
    print(f"✅ TS fixture exported: {OUT} ({len(fixtures)} entries)")

if __name__ == '__main__':
    main()
EOF

echo "✅ Python aggregator updated"

# 1b. Update cc_glob_loader.ts
cat > packages/vol-validation/src/cc_glob_loader.ts << 'EOF'
import fs from "fs";
import path from "path";
import { z } from "zod";
import crypto from "crypto";

const SVIParamsSchema = z.object({
  a: z.number(),
  b: z.number(),
  rho: z.number(),
  m: z.number(),
  sigma: z.number(),
});

const AggregatedFixtureSchema = z.object({
  forward: z.number().positive(),
  T: z.number().positive(),
  strikes: z.array(z.number().positive()).min(1),
  marketIV: z.array(z.number()).optional(),
  marketW: z.array(z.number()).optional(), // RENAMED from marketTV
  df: z.number().positive().optional(),
  svi: SVIParamsSchema,
  metadata: z.record(z.any()).optional(),
  multiplier: z.number().positive().optional(),
  fixtureId: z.string().optional(),
});

const AggregatedFileSchema = z.object({
  fixtures: z.array(AggregatedFixtureSchema),
  hash: z.string().optional(),
});

export interface AggregatedFixture {
  forward: number;
  T: number;
  strikes: number[];
  marketIV?: number[];
  marketW?: number[]; // RENAMED
  df?: number;
  svi: { a: number; b: number; rho: number; m: number; sigma: number };
  metadata?: any;
  multiplier?: number;
  fixtureId?: string;
}

export interface AggregatedFile {
  fixtures: AggregatedFixture[];
  hash?: string;
}

export function loadAggregatedCCFixtures(
  file = "vol-core-validation/output/cc_fixtures.json"
): AggregatedFile {
  const fullPath = path.resolve(file);

  try {
    const raw = fs.readFileSync(fullPath, "utf-8");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const data = JSON.parse(raw);
    const validated = AggregatedFileSchema.parse(data);
    return { ...validated, hash };
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error(`❌ Aggregated fixture schema invalid: ${file}`);
      console.error(err.errors);
      throw new Error(`Invalid aggregated fixture: ${err.message}`);
    }
    throw err;
  }
}
EOF

echo "✅ cc_glob_loader.ts updated"
echo ""

# ============================================================================
# STEP 2: Config + Units (Remove secondsPerYear)
# ============================================================================

echo "📝 STEP 2: Clean up config (remove secondsPerYear)"
echo "----------------------------------------------------"

# 2a. Update config schema
cat > apps/server/src/config/schema.ts << 'EOF'
import { z } from "zod";

export const FeaturesSchema = z.object({
  enablePricing: z.boolean(),
  enableFitter: z.boolean(),
  enableShadow: z.boolean(),
  usePythonGoldens: z.boolean().optional(),
});

export const PrimitivesSchema = z.object({
  daycount: z.enum(["ACT_365","ACT_365_25","BUS_252"]),
  // secondsPerYear removed - derive from daycount
  epsilonT: z.number().positive(),
});

export const GuardsSchema = z.object({
  enforceStaticNoArb: z.boolean(),
  maxWingSlope: z.number().positive(),
  minTotalVariance: z.number().nonnegative(),
});

export const TermSchema = z.object({
  method: z.literal("monotone_convex_tv"),
  shortDatedBlend: z.object({
    enabled: z.boolean(),
    T_blend: z.number().nonnegative(),
  }).optional()
});

export const RiskSchema = z.object({
  covariance: z.object({
    sources: z.array(z.enum(["factor_returns","pnl_innovations"])),
    alpha_structural: z.number().min(0).max(1),
    alpha_pc: z.number().min(0).max(1),
    shrinkage: z.literal("ledoit_wolf"),
    robust: z.object({
      huberDeltaBps: z.number().positive(),
      hampel: z.object({ k: z.number(), t0: z.number(), t1: z.number() })
    }).optional(),
    regime: z.object({
      decayOnShock: z.boolean(),
      maxEigenRatio: z.number().positive()
    }).optional()
  }),
  lambda: z.object({
    learningRate: z.number().positive(),
    capAbs: z.number().positive(),
    targetVolBps: z.number().nonnegative(),
    floorBps: z.number().nonnegative()
  })
});

export const AppConfigSchema = z.object({
  features: FeaturesSchema,
  primitives: PrimitivesSchema,
  guards: GuardsSchema,
  term: TermSchema,
  risk: RiskSchema
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
EOF

echo "✅ schema.ts updated"

# 2b. Update config.default.yaml
cat > config.default.yaml << 'EOF'
features:
  usePythonGoldens: true
  enablePricing: true
  enableFitter: false
  enableShadow: false

primitives:
  daycount: ACT_365
  # secondsPerYear removed - derive from daycount
  epsilonT: 1e-6

guards:
  enforceStaticNoArb: true
  maxWingSlope: 2.0
  minTotalVariance: 1.0e-6

term:
  method: monotone_convex_tv
  shortDatedBlend:
    enabled: true
    T_blend: 0.0055

risk:
  covariance:
    sources: [factor_returns, pnl_innovations]
    alpha_structural: 0.01
    alpha_pc: 0.10
    shrinkage: ledoit_wolf
    robust:
      huberDeltaBps: 10
      hampel: { k: 3, t0: 3, t1: 8 }
    regime:
      decayOnShock: true
      maxEigenRatio: 25
  lambda:
    learningRate: 0.05
    capAbs: 3.0
    targetVolBps: 5
    floorBps: 1
EOF

echo "✅ config.default.yaml updated"
echo ""

# ============================================================================
# STEP 3: Core Types (Optional df, T, iv)
# ============================================================================

echo "📝 STEP 3: Update PriceBreakdown interface"
echo "--------------------------------------------"

# Update index.ts (append to existing or create new)
cat > packages/core-types/src/index.ts << 'EOF'
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
EOF

echo "✅ Core types updated"
echo ""

# ============================================================================
# STEP 4: Add utils.ts
# ============================================================================

echo "📝 STEP 4: Create utils.ts"
echo "----------------------------"

cat > packages/vol-core/src/utils.ts << 'EOF'
export function assertFinite(x: number, tag: string): void {
  if (!Number.isFinite(x)) {
    throw new Error(`Non-finite value at ${tag}: ${x}`);
  }
}

export function assertPositive(x: number, tag: string): void {
  assertFinite(x, tag);
  if (x <= 0) {
    throw new Error(`Non-positive value at ${tag}: ${x}`);
  }
}
EOF

echo "✅ utils.ts created"
echo ""

# ============================================================================
# STEP 5: Add constants.ts
# ============================================================================

echo "📝 STEP 5: Create constants.ts"
echo "--------------------------------"

cat > packages/vol-core/src/constants.ts << 'EOF'
// Tolerance constants - centralized to avoid drift

export const EPS_TV = 1e-12;           // Minimum total variance
export const EPS_T = 1e-10;            // T*vol threshold for short-circuit
export const EPS_W_ABS = 1e-8;         // Absolute tolerance for w (total variance)
export const EPS_CONVEXITY = 1e-6;     // Convexity violation threshold

// IV tolerance (vol-bp)
export const IV_TOL_MIN_BPS = 0.5;     // Minimum tolerance
export const IV_TOL_MAX_BPS = 5.0;     // Maximum tolerance (capped)
export const IV_TOL_PCT = 0.02;        // 2% adaptive component

// W tolerance (bp)
export const W_TOL_REL_BPS = 5.0;      // 0.5 bp = 5 in 1e4 units

// Lee bounds
export const MAX_WING_SLOPE = 2.0;
EOF

echo "✅ constants.ts created"
echo ""

# ============================================================================
# STEP 6: Update smile.ts (SVI validation + convexity)
# ============================================================================

echo "📝 STEP 6: Update smile.ts"
echo "----------------------------"

cat > packages/vol-core/src/smile.ts << 'EOF'
import { SVIParams } from "@core-types";
import { EPS_TV, EPS_CONVEXITY, MAX_WING_SLOPE } from "./constants";

export interface SVIValidation {
  valid: boolean;
  errors: string[];
}

function sviTotalVarianceRaw(k: number, p: SVIParams): number {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.sqrt(x * x + p.sigma * p.sigma));
}

export function validateSVIParams(p: SVIParams): SVIValidation {
  const errors: string[] = [];

  // Basic bounds
  if (p.b < 0) errors.push(`b must be ≥ 0, got ${p.b}`);
  if (Math.abs(p.rho) >= 1) errors.push(`|ρ| must be < 1, got ${p.rho}`);
  if (p.sigma <= 0) errors.push(`σ must be > 0, got ${p.sigma}`);

  // Lee bounds on wing slopes
  const leftSlope = p.b * (1 - p.rho);
  const rightSlope = p.b * (1 + p.rho);

  if (leftSlope < 0) errors.push(`Left wing slope ${leftSlope.toFixed(4)} < 0`);
  if (rightSlope < 0) errors.push(`Right wing slope ${rightSlope.toFixed(4)} < 0`);
  if (leftSlope > MAX_WING_SLOPE) errors.push(`Left wing slope ${leftSlope.toFixed(4)} > ${MAX_WING_SLOPE}`);
  if (rightSlope > MAX_WING_SLOPE) errors.push(`Right wing slope ${rightSlope.toFixed(4)} > ${MAX_WING_SLOPE}`);

  // Local convexity check on a grid
  const kGrid = [];
  for (let k = -2; k <= 2; k += 0.1) {
    kGrid.push(k);
  }

  for (let i = 1; i < kGrid.length - 1; i++) {
    const k0 = kGrid[i - 1];
    const k1 = kGrid[i];
    const k2 = kGrid[i + 1];

    const w0 = sviTotalVarianceRaw(k0, p);
    const w1 = sviTotalVarianceRaw(k1, p);
    const w2 = sviTotalVarianceRaw(k2, p);

    // Second derivative (finite difference)
    const d2w = (w2 - 2 * w1 + w0) / Math.pow(k1 - k0, 2);

    if (d2w < -EPS_CONVEXITY) {
      errors.push(
        `Convexity violation at k=${k1.toFixed(2)}: d²w/dk²=${d2w.toFixed(6)}`
      );
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export function sviTotalVariance(k: number, p: SVIParams): number {
  const w = sviTotalVarianceRaw(k, p);

  if (w < -1e-10) {
    console.warn(
      `Negative total variance w=${w.toFixed(6)} at k=${k.toFixed(4)}, params: ${JSON.stringify(p)}`
    );
  }

  return Math.max(EPS_TV, w);
}

export function sviIV(k: number, T: number, p: SVIParams): number {
  const w = sviTotalVariance(k, p);
  return Math.sqrt(w / Math.max(EPS_TV, T));
}
EOF

echo "✅ smile.ts updated"
echo ""

# ============================================================================
# STEP 7: Update priceCC.ts
# ============================================================================

echo "📝 STEP 7: Update priceCC.ts"
echo "------------------------------"

cat > apps/server/src/pricing/priceCC.ts << 'EOF'
import { Quote, PriceBreakdown, SVIParams } from "@core-types";
import { timeToExpiryYears } from "@vol-core/units";
import { sviIV } from "@vol-core/smile";
import { black76Call, black76Put } from "@vol-core/black76";
import { assertFinite } from "@vol-core/utils";
import { EPS_T } from "@vol-core/constants";
import { loadConfig } from "../config/configManager";

export interface PriceCCOptions {
  nowSec?: number;
  df?: number;
  returnPV?: boolean; // default true
}

export function priceCC(
  quote: Quote,
  svi: SVIParams,
  options: PriceCCOptions = {}
): PriceBreakdown {
  const cfg = loadConfig();
  const now = options.nowSec ?? quote.timestampSec;
  const T = timeToExpiryYears(
    now,
    quote.instrument.expirySec,
    cfg.primitives.daycount,
    cfg.primitives.epsilonT
  );

  // Guard: invalid inputs
  if (quote.forward <= 0 || quote.instrument.strike <= 0) {
    throw new Error(
      `Invalid inputs: F=${quote.forward}, K=${quote.instrument.strike}`
    );
  }

  // FIXED: correct precedence for df calculation
  const df =
    options.df ??
    (quote.rate != null ? Math.exp(-(quote.rate as number) * T) : 1.0);

  const k = Math.log(quote.instrument.strike / quote.forward);
  const iv = sviIV(k, T, svi);

  // Short-circuit for tiny T*vol
  if (T * iv < EPS_T) {
    const intrinsic = Math.max(
      quote.instrument.isCall
        ? quote.forward - quote.instrument.strike
        : quote.instrument.strike - quote.forward,
      0
    );
    return {
      intrinsic: intrinsic * df,
      tv: 0,
      price: intrinsic * df,
      iv: 0,
      df,
      T,
    };
  }

  // Compute forward-space price
  const pricer = quote.instrument.isCall ? black76Call : black76Put;
  const forwardPrice = pricer(
    quote.forward,
    quote.instrument.strike,
    T,
    iv,
    1.0
  );

  const intrinsic = Math.max(
    quote.instrument.isCall
      ? quote.forward - quote.instrument.strike
      : quote.instrument.strike - quote.forward,
    0
  );

  // Invariant check for calls
  if (quote.instrument.isCall) {
    if (
      forwardPrice < intrinsic - 1e-10 ||
      forwardPrice > quote.forward + 1e-10
    ) {
      console.warn("Invariant breach in forward price", {
        F: quote.forward,
        K: quote.instrument.strike,
        T,
        iv,
        forwardPrice,
        intrinsic,
      });
    }
  }

  // Return PV if requested (default true)
  const returnPV = options.returnPV ?? true;
  const finalPrice = returnPV ? forwardPrice * df : forwardPrice;
  const finalIntrinsic = returnPV ? intrinsic * df : intrinsic;
  const tv = finalPrice - finalIntrinsic;

  // Assert finite before returning
  assertFinite(finalPrice, `priceCC: finalPrice at K=${quote.instrument.strike}`);
  assertFinite(tv, `priceCC: tv at K=${quote.instrument.strike}`);

  return {
    intrinsic: finalIntrinsic,
    tv,
    price: finalPrice,
    iv,
    df,
    T,
  };
}
EOF

echo "✅ priceCC.ts updated"
echo ""

# ============================================================================
# STEP 8: Update golden test (cc_parity_glob.test.ts)
# ============================================================================

echo "📝 STEP 8: Update golden test"
echo "-------------------------------"

# Note: This creates the file from scratch - adjust path if needed
mkdir -p apps/server/tests/unit

cat > apps/server/tests/unit/cc_parity_glob.test.ts << 'EOF'
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { loadAggregatedCCFixtures } from "@vol-validation/cc_glob_loader";
import { sviIV, sviTotalVariance, validateSVIParams } from "@vol-core/smile";
import { IV_TOL_MIN_BPS, IV_TOL_MAX_BPS, IV_TOL_PCT, W_TOL_REL_BPS, EPS_W_ABS } from "@vol-core/constants";

const DIAG_PATH = path.resolve("diagnostics/cc_parity.json");

describe("CC Parity — Python Goldens (Final)", () => {
  const agg = loadAggregatedCCFixtures();

  const diagnostics = {
    timestamp: new Date().toISOString(),
    fixtureHash: agg.hash,
    totalFixtures: agg.fixtures.length,
    totalPoints: 0,
    ivChecks: 0,
    wChecks: 0,
    passed: 0,
    failed: 0,
    worstIV: {
      errorBps: 0,
      fixture: -1,
      strike: 0,
      expected: 0,
      got: 0,
      F: 0,
      K: 0,
      T: 0,
    },
    worstW: {
      errorBps: 0,
      fixture: -1,
      strike: 0,
      expected: 0,
      got: 0,
      F: 0,
      K: 0,
      T: 0,
    },
    failures: [] as any[],
    sviValidations: [] as any[],
  };

  // Validate all SVI params upfront
  agg.fixtures.forEach((f, idx) => {
    const validation = validateSVIParams(f.svi);
    diagnostics.sviValidations.push({
      fixture: idx,
      fixtureId: f.fixtureId ?? `idx_${idx}`,
      valid: validation.valid,
      errors: validation.errors,
    });
    if (!validation.valid) {
      console.warn(
        `⚠️  Fixture ${idx}: Invalid SVI params:\n${validation.errors.join("\n")}`
      );
    }
  });

  agg.fixtures.forEach((f, idx) => {
    const fixtureId = f.fixtureId ?? `F${f.forward.toFixed(0)}_T${f.T.toFixed(4)}`;

    describe(`Fixture ${idx}: ${fixtureId}`, () => {
      f.strikes.forEach((K, j) => {
        it(`Strike ${K.toFixed(0)}`, () => {
          diagnostics.totalPoints++;

          const k = Math.log(K / f.forward);
          const iv = sviIV(k, f.T, f.svi);
          const w = sviTotalVariance(k, f.svi);

          // IV check with capped adaptive tolerance
          if (f.marketIV && Number.isFinite(f.marketIV[j])) {
            diagnostics.ivChecks++;
            const expIV = f.marketIV[j];
            const absErrBps = Math.abs(iv - expIV) * 1e4;
            
            // Capped adaptive tolerance: 0.5 to 5 vol-bp
            const tolBps = Math.max(IV_TOL_MIN_BPS, Math.min(IV_TOL_MAX_BPS, IV_TOL_PCT * expIV * 1e4));

            if (absErrBps > diagnostics.worstIV.errorBps) {
              diagnostics.worstIV = {
                errorBps: absErrBps,
                fixture: idx,
                strike: K,
                expected: expIV,
                got: iv,
                F: f.forward,
                K,
                T: f.T,
              };
            }

            if (absErrBps > tolBps) {
              diagnostics.failed++;
              diagnostics.failures.push({
                fixtureId,
                fixture: idx,
                strike: K,
                type: "IV",
                expected: expIV,
                got: iv,
                errorBps: absErrBps,
                threshold: tolBps,
              });
            } else {
              diagnostics.passed++;
            }
            
            expect(absErrBps).toBeLessThanOrEqual(tolBps);
          }

          // W check with dual tolerance
          if (f.marketW && Number.isFinite(f.marketW[j])) {
            diagnostics.wChecks++;
            const expW = f.marketW[j];
            const absErr = Math.abs(w - expW);
            const relErr = absErr / Math.max(1e-10, Math.abs(expW));
            const relErrBps = relErr * 1e4;

            // Dual tolerance: W_TOL_REL_BPS bp relative OR EPS_W_ABS absolute
            const pass = relErrBps <= W_TOL_REL_BPS || absErr <= EPS_W_ABS;

            if (relErrBps > diagnostics.worstW.errorBps) {
              diagnostics.worstW = {
                errorBps: relErrBps,
                fixture: idx,
                strike: K,
                expected: expW,
                got: w,
                F: f.forward,
                K,
                T: f.T,
              };
            }

            if (!pass) {
              diagnostics.failed++;
              diagnostics.failures.push({
                fixtureId,
                fixture: idx,
                strike: K,
                type: "W",
                expected: expW,
                got: w,
                errorBps: relErrBps,
                threshold: `${W_TOL_REL_BPS}bp rel or ${EPS_W_ABS} abs`,
              });
            } else {
              diagnostics.passed++;
            }

            expect(pass).toBe(true);
          }
        });
      });
    });
  });

  // ALWAYS write diagnostics
  afterAll(() => {
    fs.mkdirSync(path.dirname(DIAG_PATH), { recursive: true });
    fs.writeFileSync(DIAG_PATH, JSON.stringify(diagnostics, null, 2));

    const passRate = diagnostics.passed / Math.max(1, diagnostics.totalPoints);

    console.log("\n" + "=".repeat(70));
    console.log("CC PARITY DIAGNOSTICS (FINAL)");
    console.log("=".repeat(70));
    console.log(`Fixture hash: ${diagnostics.fixtureHash?.slice(0, 16)}...`);
    console.log(`Total fixtures: ${diagnostics.totalFixtures}`);
    console.log(`Total points: ${diagnostics.totalPoints}`);
    console.log(`IV checks: ${diagnostics.ivChecks}`);
    console.log(`W checks: ${diagnostics.wChecks}`);
    console.log(`Passed: ${diagnostics.passed}`);
    console.log(`Failed: ${diagnostics.failed}`);
    console.log(`Pass rate: ${(passRate * 100).toFixed(2)}%`);
    console.log("\nWorst offenders:");
    console.log(
      `  IV: ${diagnostics.worstIV.errorBps.toFixed(2)} vol-bp at ` +
        `F=${diagnostics.worstIV.F.toFixed(0)}, K=${diagnostics.worstIV.K.toFixed(0)}, 
T=${diagnostics.worstIV.T.toFixed(4)}`
    );
    console.log(
      `  W:  ${diagnostics.worstW.errorBps.toFixed(2)} bp at ` +
        `F=${diagnostics.worstW.F.toFixed(0)}, K=${diagnostics.worstW.K.toFixed(0)}, 
T=${diagnostics.worstW.T.toFixed(4)}`
    );
    console.log("\nInvalid SVI params:");
    const invalidSVI = diagnostics.sviValidations.filter((v) => !v.valid);
    if (invalidSVI.length === 0) {
      console.log("  None ✓");
    } else {
      invalidSVI.forEach((v) => {
        console.log(`  Fixture ${v.fixtureId}:`);
        v.errors.forEach((e: string) => console.log(`    - ${e}`));
      });
    }
    console.log("=".repeat(70));
    console.log(`Diagnostics: ${DIAG_PATH}`);
    console.log("=".repeat(70));
  });

  it("Overall pass rate should be ≥99%", () => {
    const passRate = diagnostics.passed / Math.max(1, diagnostics.totalPoints);
    expect(passRate).toBeGreaterThanOrEqual(0.99);
  });

  it("Worst IV error should be ≤5 vol-bp", () => {
    expect(diagnostics.worstIV.errorBps).toBeLessThanOrEqual(IV_TOL_MAX_BPS);
  });

  it("No invalid SVI params", () => {
    const invalidCount = diagnostics.sviValidations.filter((v) => !v.valid).length;
    expect(invalidCount).toBe(0);
  });
});
EOF

echo "✅ Golden test updated"
echo ""

# ============================================================================
# STEP 9: Verify and Test
# ============================================================================

echo "📝 STEP 9: Verify and test"
echo "----------------------------"

# Run typecheck
echo "Running typecheck..."
npm run typecheck

echo ""
echo "✅ All files updated successfully!"
echo ""
echo "🧪 Next steps:"
echo "1. Run: npm test"
echo "2. Generate Python fixtures: npm run fixtures:python"
echo "3. Run golden tests: npm run test:golden"
echo "4. Check diagnostics: cat diagnostics/cc_parity.json | jq"
echo ""
echo "Expected gates:"
echo "  ✓ Pass rate ≥ 99%"
echo "  ✓ Worst IV error ≤ 5 vol-bp"
echo "  ✓ Worst W error ≤ 5 bp (or ≤ 1e-8 abs)"
echo "  ✓ Zero invalid SVI params"
echo "  ✓ Fixture hash present"
echo ""
EOF

chmod +x step2_implementation.sh

echo "✅ Implementation script created!"
echo ""
echo "📋 To execute all fixes, run:"
echo "   bash step2_implementation.sh"
echo ""
echo "Or execute each section manually following the script."
