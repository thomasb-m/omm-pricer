#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------
# context.sh — Generate a nicely annotated context pack for ChatGPT
# Usage:
#   scripts/context.sh                -> context-pack.txt
#   scripts/context.sh OUT MODE       -> OUT={context-pack.txt|context-pack-lite.txt}, MODE={default|lite|split}
# --------------------------------------------

OUT="${1:-context-pack.txt}"
MODE="${2:-default}"

mkdir -p scripts

_header () {
  local title="$1"
  echo "----- FILE: $title -----"
  echo
}

append_file () {
  local f="$1"
  if [[ -f "$f" ]]; then
    if [[ "$MODE" == "split" ]]; then
      local outdir="context"
      mkdir -p "$outdir"
      local of="$outdir/$(echo "$f" | sed 's|/|-|g')"
      {
        _header "$f"
        cat "$f"
        echo
      } > "$of"
    else
      echo >> "$OUT"
      _header "$f" >> "$OUT"
      cat "$f" >> "$OUT"
      echo >> "$OUT"
    fi
  else
    >&2 echo "⚠️  WARNING: $f not found"
  fi
}

append_inline () {
  # append an inline "virtual" file with content we provide here
  local virtual_name="$1"
  shift
  if [[ "$MODE" == "split" ]]; then
    local outdir="context"
    mkdir -p "$outdir"
    local of="$outdir/$(echo "$virtual_name" | sed 's|/|-|g')"
    _header "$virtual_name" > "$of"
    cat >> "$of"
    echo >> "$of"
  else
    echo >> "$OUT"
    _header "$virtual_name" >> "$OUT"
    cat >> "$OUT"
    echo >> "$OUT"
  fi
}

git_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
git_commit="$(git log -1 --pretty=format:'%h %s' 2>/dev/null || echo "unknown")"

# reset OUT unless split mode
if [[ "$MODE" != "split" ]]; then
  : > "$OUT"
fi

# -----------------------------
# Top summary + roadmap + calculus plan
# -----------------------------
append_inline "SUMMARY.md" <<EOF
### OMM Pricer Context Pack
Generated on: $(date)
Git: branch=${git_branch}, commit=${git_commit}

---

## 🔹 Context Summary

We are building the **OMM pricer backend** in TypeScript/Node with a single “calculus” that ties together:
- **Core curve (CC)** — fair value surface (SVI-based).
- **Pricing curve (PC)** — CC plus inventory/trader adjustments.
- **Widths (bid/ask)** — function of factor exposure and inventory pressure.
- **Propagation** — change one thing (fills, nudges, F, time) → consistent shifts across the book.

**Key types**
- Factors (θ): \`[L0, S0, C0, S_neg, S_pos, F]\`
- Factor greeks gᵢ(strike, T, F) = ∂Price/∂θᵢ
- Costs λᵢ (ticks per unit factor exposure)
- Inventory Iᵢ (aggregate exposure along each factor)

**Core identities**
- \`PC_mid = CC_mid + dot(λ, g)\`
- \`width = w0 + α·|dot(λ, g)| + β·invPressure(I)\`
- Trade update: \`I ← I + q · g\` (q>0 long)
- Propagation (nudge): \`ΔP ≈ G · Δθ\`, where \`G\` is Jacobian over grid

---

## 🗺️ Minimal Roadmap (weeks)

**W1**: factor greeks (finite diff), λ/I wiring, PC/width from λ·g, logging, limits skeleton  
**W2**: close-form SVI partials, smoothing λ, latency trims  
**W3**: backtest 7–30D, fit λ via ridge to realized slippage, fee model, guards  
**W4**: surface visualizer, param sweeps, runbook

---

## ✅ Immediate Tasks (implemented/ready to scaffold)
1) Add factor calculus scaffolding (`FactorSpace.ts`, `factorGreeks.ts`) with finite-difference gᵢ.
2) Store λ and I per symbol in volModelService. Update I on trade. Expose via `/risk/factors`.
3) Compute PC mid, width via λ·g (keep sanity clamps).
4) Observability: log {F,K,T, ccMid, pcMid, λ·g, width, I, bucket}.
5) Limits: soft/hard on Iᵢ → widen/stop/emit-hedge-signal.

EOF

# -----------------------------
# Existing core server files
# -----------------------------
for f in \
  apps/server/src/index.ts \
  apps/server/src/ingest.ts \
  apps/server/src/quoteEngine.ts \
  apps/server/src/risk.ts \
  apps/server/src/utils/time.ts \
  apps/server/src/volModels/integratedSmileModel.ts \
  apps/server/src/volModels/integration/volModelService.ts \
  apps/server/src/volModels/smileInventoryController.ts \
  apps/server/src/volModels/pricing/blackScholes.ts \
  apps/server/src/volModels/tests/bs.test.ts \
  apps/server/src/volModels/tests/integratedSmileModel.test.ts \
  apps/server/src/volModels/tests/volModelService.test.ts \
  apps/server/package.json \
  apps/server/tsconfig.json \
  package.json \
; do
  append_file "$f"
done

# -----------------------------
# Proposed NEW files (inline stubs so you can share the idea immediately)
# Create them in repo later to make them “real” files.
# -----------------------------

append_inline "apps/server/src/volModels/factors/FactorSpace.ts (PROPOSED)" <<'EOF'
/**
 * FactorSpace — types + helpers for factor calculus
 * Factors: [L0, S0, C0, S_neg, S_pos, F]
 */
export type FactorVec = [number, number, number, number, number, number];
export const ZeroFactors: FactorVec = [0,0,0,0,0,0];

export function dot(a: FactorVec, b: FactorVec): number {
  let s = 0;
  for (let i=0;i<6;i++) s += a[i]*b[i];
  return s;
}
export function axpy(y: FactorVec, a: number, x: FactorVec): FactorVec {
  return [
    y[0] + a*x[0],
    y[1] + a*x[1],
    y[2] + a*x[2],
    y[3] + a*x[3],
    y[4] + a*x[4],
    y[5] + a*x[5],
  ];
}
export function norm1(a: FactorVec): number {
  return Math.abs(a[0])+Math.abs(a[1])+Math.abs(a[2])+Math.abs(a[3])+Math.abs(a[4])+Math.abs(a[5]);
}
EOF

append_inline "apps/server/src/volModels/factors/factorGreeks.ts (PROPOSED)" <<'EOF'
/**
 * Finite-difference factor greeks g_i = ∂P/∂θ_i
 * Safe, slow prototype; replace with closed-form SVI partials later.
 */
import { FactorVec } from "./FactorSpace";
import { SVI, SVIParams } from "../dualSurfaceModel";
import { black76Greeks } from "../../risk";

type PriceFn = (params: {cc: SVIParams; strike:number; T:number; F:number; isCall:boolean}) => number;

const EPS: FactorVec = [1e-4, 1e-4, 1e-3, 1e-4, 1e-4, 1e-6];

export function factorGreeksFiniteDiff(
  cc: SVIParams,
  strike: number,
  T: number,
  F: number,
  isCall: boolean,
  priceFromSVI: PriceFn
): FactorVec {
  // Base price from CC
  const base = priceFromSVI({ cc, strike, T, F, isCall });

  // Map factor → small transform in metric space
  const m0 = SVI.toMetrics(cc);

  function bump(i: number): number {
    const m = { ...m0 };
    switch (i) {
      case 0: m.L0   += EPS[0]; break;
      case 1: m.S0   += EPS[1]; break;
      case 2: m.C0   += EPS[2]; break;
      case 3: m.S_neg+= EPS[3]; break;
      case 4: m.S_pos+= EPS[4]; break;
      case 5: /*F*/   return priceFromSVI({ cc, strike, T, F: F+EPS[5], isCall }) - base;
    }
    const bumped = SVI.fromMetrics(m, {
      bMin: 0, sigmaMin: 1e-6, rhoMax: 0.999, sMax: 5, c0Min: 0.01,
      buckets: [], edgeParams: new Map(), rbfWidth: 0, ridgeLambda: 0, maxL0Move: 0, maxS0Move: 0, maxC0Move: 0
    });
    return priceFromSVI({ cc: bumped, strike, T, F, isCall }) - base;
  }

  const g0 = bump(0)/EPS[0];
  const g1 = bump(1)/EPS[1];
  const g2 = bump(2)/EPS[2];
  const g3 = bump(3)/EPS[3];
  const g4 = bump(4)/EPS[4];
  const g5 = bump(5)/EPS[5];

  return [g0,g1,g2,g3,g4,g5];
}
EOF

append_inline "apps/server/config/risk.factors.yaml (PROPOSED)" <<'EOF'
BTC:
  lambda:        # ticks (or price units) per unit factor exposure
    L0:   0.50
    S0:   0.20
    C0:   0.10
    Sneg: 0.15
    Spos: 0.10
    F:    0.30
  widths:
    w0:    2.0
    alpha: 1.0
    beta:  0.0
  limits:
    soft:
      L0:   5000
      S0:   3000
      C0:   2000
      Sneg: 3000
      Spos: 3000
      F:    10000
    hard:
      L0:   10000
      S0:   6000
      C0:   4000
      Sneg: 6000
      Spos: 6000
      F:    20000
EOF

append_inline "apps/server/src/volModels/factors/README.md (PROPOSED)" <<'EOF'
# Factor calculus quick notes

- Factors θ = [L0, S0, C0, S_neg, S_pos, F]
- g_i(K,T,F) = ∂P/∂θ_i via finite-diff (for now)
- PC mid = CC mid + λ·g
- width  = w0 + α·|λ·g| + β·invPressure(I)
- On trade of size q (customer sign):
  - inventory I ← I + q * g
  - PC moves instantly by λ·(Δg) if F/T move; otherwise same timestamp: g unchanged, mid unchanged (only inventory and λ·g matter for next quotes)

Swap the finite-diff with closed forms when ready (less noise, faster).
EOF

# -----------------------------
# Minimal API sketch (inline)
# -----------------------------
append_inline "API-SKETCH.md (PROPOSED)" <<'EOF'
# Minimal API sketch

GET  /risk/factors
  -> { symbol, lambda, inventory, lambdaDotInventory, limits }

POST /surface/nudge
  { symbol, dTheta: { L0?:number, S0?:number, C0?:number, Sneg?:number, Spos?:number, F?:number } }
  -> applies Δθ_trader with smoothness penalty, returns new snapshot ({pc-cc} across grid)

POST /forward/update
  { symbol, forward }  -> already exists, ensure it triggers PC recompute

POST /trade/execute
  -> unchanged; path updates inventory I using factor greeks
EOF

# -----------------------------
# Footer / where to find files
# -----------------------------
if [[ "$MODE" != "split" ]]; then
  echo "✅ Context pack written to $OUT"
else
  echo "✅ Split context written under ./context/"
fi
