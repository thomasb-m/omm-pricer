#!/usr/bin/env bash
set -euo pipefail

echo "📦 PR-3: adding pc-fit robust utils, penalties, artifacts, checks..."

# 1) robust IRLS
mkdir -p packages/pc-fit/src/fit
cat > packages/pc-fit/src/fit/robust.ts <<'TS'
export type RobustKind = "huber" | "tukey";

export interface IRLSOptions {
  kind?: RobustKind;
  c?: number;          // tuning constant (Huber/Tukey)
  maxIter?: number;    // IRLS iterations
  tol?: number;        // convergence tol on beta
}

export interface IRLSResult {
  beta0: number;       // intercept
  beta1: number;       // slope
  weights: number[];   // final weights
  residuals: number[];
  iters: number;
}

function huberWeight(r: number, c: number): number {
  const a = Math.abs(r);
  return a <= c ? 1 : c / a;
}

function tukeyWeight(r: number, c: number): number {
  const a = Math.abs(r);
  if (a >= c) return 0;
  const u = 1 - (a * a) / (c * c);
  return u * u;
}

/** Weighted least squares for y ~ beta0 + beta1 * x */
function wlsStep(x: number[], y: number[], w: number[]): { b0: number; b1: number } {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const wi = w[i];
    sw += wi;
    sx += wi * x[i];
    sy += wi * y[i];
    sxx += wi * x[i] * x[i];
    sxy += wi * x[i] * y[i];
  }
  const denom = sw * sxx - sx * sx;
  if (denom === 0) {
    const n = x.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (x[i]-mx)*(y[i]-my); den += (x[i]-mx)*(x[i]-mx); }
    const b1 = den === 0 ? 0 : num/den;
    const b0 = my - b1*mx;
    return { b0, b1 };
  }
  const b1 = (sw * sxy - sx * sy) / denom;
  const b0 = (sy - b1 * sx) / sw;
  return { b0, b1 };
}

/** IRLS with Huber/Tukey weights */
export function irls(
  x: number[], y: number[], opts: IRLSOptions = {}
): IRLSResult {
  if (x.length !== y.length) throw new Error("x/y length mismatch");
  const n = x.length;
  const kind = opts.kind ?? "huber";
  const c = opts.c ?? (kind === "huber" ? 1.345 : 4.685);
  const maxIter = opts.maxIter ?? 25;
  const tol = opts.tol ?? 1e-9;

  let w = Array(n).fill(1);
  let { b0, b1 } = wlsStep(x, y, w);

  let it = 0;
  for (; it < maxIter; it++) {
    const r = y.map((yy, i) => yy - (b0 + b1 * x[i]));
    
    const med = (arr: number[]) => {
      const v = [...arr].sort((a,b)=>a-b);
      const m = Math.floor(v.length/2);
      return v.length % 2 ? v[m] : 0.5*(v[m-1]+v[m]);
    };
    const m = med(r);
    const mad = med(r.map(v => Math.abs(v - m))) || 1e-12;
    const scale = 1.4826 * mad || 1;

    for (let i = 0; i < n; i++) {
      const ri = r[i] / (scale || 1);
      if (kind === "huber") w[i] = huberWeight(ri, c);
      else w[i] = tukeyWeight(ri, c);
      if (!isFinite(w[i])) w[i] = 0;
    }

    const prev0 = b0, prev1 = b1;
    ({ b0, b1 } = wlsStep(x, y, w));
    const diff = Math.abs(b0 - prev0) + Math.abs(b1 - prev1);
    if (diff < tol) break;
  }

  const residuals = y.map((yy, i) => yy - (b0 + b1 * x[i]));
  return { beta0: b0, beta1: b1, weights: w, residuals, iters: it };
}
TS

# 2) convexity penalty
cat > packages/pc-fit/src/fit/penalty.ts <<'TS'
export function convexityPenaltyK(k: number[], tv: number[], eps = 0): { penalty: number; violations: number } {
  const n = Math.min(k.length, tv.length);
  if (n < 3) return { penalty: 0, violations: 0 };

  const idx = [...Array(n).keys()].sort((a,b)=>k[a]-k[b]);
  const kk = idx.map(i=>k[i]);
  const vv = idx.map(i=>tv[i]);

  let penalty = 0;
  let violations = 0;
  for (let i = 1; i < n-1; i++) {
    const h1 = kk[i] - kk[i-1];
    const h2 = kk[i+1] - kk[i];
    if (h1 <= 0 || h2 <= 0) continue;

    const d2 = 2 * ( (vv[i+1]-vv[i])/h2 - (vv[i]-vv[i-1])/h1 ) / (h1 + h2);
    if (d2 < -eps) {
      violations++;
      penalty += (-d2 - eps);
    }
  }
  return { penalty, violations };
}
TS

# 3) regularizers
cat > packages/pc-fit/src/fit/regularize.ts <<'TS'
export function applyATMPin(
  k: number[], tv: number[], { pinStrength = 0.2 }: { pinStrength?: number } = {}
): number[] {
  const out = [...tv];
  const idx = k.map((v,i)=>[Math.abs(v),i]).sort((a,b)=>a[0]-b[0]).slice(0,3).map(x=>x[1]);
  const avg = idx.reduce((s,i)=>s+tv[i],0) / Math.max(1, idx.length);
  for (const i of idx) out[i] = (1 - pinStrength) * tv[i] + pinStrength * avg;
  return out;
}

export function applySoftFloors(
  tv: number[], { floor = 0 }: { floor?: number } = {}
): number[] {
  return tv.map(v => (v < floor ? 0.5 * (v + floor) : v));
}
TS

# 4) artifact
cat > packages/pc-fit/src/fit/artifact.ts <<'TS'
export type FitArtifact = {
  meta: { createdAt: string; method: string; notes?: string };
  grid: { k: number[]; tv: number[] };
  diagnostics?: Record<string, unknown>;
};

export function buildFitArtifact(
  k: number[],
  tv: number[],
  method = "irls+huber",
  diagnostics?: Record<string, unknown>
): FitArtifact {
  return {
    meta: { createdAt: new Date().toISOString(), method },
    grid: { k: [...k], tv: [...tv] },
    diagnostics
  };
}
TS

# 5) noarb
cat > packages/pc-fit/src/fit/noarb.ts <<'TS'
import { convexityPenaltyK } from "./penalty";

export function staticNoArbDiagnostics(k: number[], tv: number[], eps = 0) {
  const { penalty, violations } = convexityPenaltyK(k, tv, eps);
  return { violations, penalty };
}
TS

# 6) barrel
cat > packages/pc-fit/src/fit/index.ts <<'TS'
export * from "./robust";
export * from "./penalty";
export * from "./regularize";
export * from "./artifact";
export * from "./noarb";
TS

# 7) update main index
cat >> packages/pc-fit/src/index.ts <<'TS'

export * as Fit from "./fit";
TS

# 8) package exports
node - <<'NODE'
const fs = require('fs');
const p = 'packages/pc-fit/package.json';
const j = JSON.parse(fs.readFileSync(p,'utf8'));
j.exports = j.exports || {};
j.exports['.'] = { types: './dist/index.d.ts', default: './dist/index.js' };
j.exports['./fit'] = { types: './dist/fit/index.d.ts', default: './dist/fit/index.js' };
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
console.log("✅ updated exports in packages/pc-fit/package.json");
NODE

# 9) tests
cat > packages/pc-fit/tests/wls_smoke.test.ts <<'TS'
import { describe, it, expect } from "vitest";
import { Fit } from "../src";

describe("IRLS (Huber) recovers slope ~2 on noisy data", () => {
  it("fits y ≈ 1 + 2x with outliers", () => {
    const x = Array.from({length: 50}, (_,i)=> i/10);
    const y = x.map(v => 1 + 2*v + (Math.random()-0.5)*0.1);
    y[5] += 5; y[30] -= 4;

    const { beta0, beta1 } = Fit.irls(x, y, { kind: "huber", c: 1.345, maxIter: 50 });
    expect(beta1).toBeGreaterThan(1.7);
    expect(beta1).toBeLessThan(2.3);
    expect(beta0).toBeGreaterThan(0.5);
    expect(beta0).toBeLessThan(1.5);
  });
});
TS

cat > packages/pc-fit/tests/convexity_penalty.test.ts <<'TS'
import { describe, it, expect } from "vitest";
import { Fit } from "../src";

describe("convexity penalty in k-space", () => {
  it("penalizes concavity", () => {
    const k = [-1, 0, 1];
    const tv = [1, 0.1, 1];
    const { penalty, violations } = Fit.convexityPenaltyK(k, tv, 0);
    expect(violations).toBeGreaterThan(0);
    expect(penalty).toBeGreaterThan(0);
  });
});
TS

cat > packages/pc-fit/tests/artifact_smoke.test.ts <<'TS'
import { describe, it, expect } from "vitest";
import { Fit } from "../src";

describe("artifact builder", () => {
  it("emits a minimal JSON-serializable artifact", () => {
    const art = Fit.buildFitArtifact([-0.5,0,0.5],[0.1,0.05,0.1],"demo",{foo:42});
    const s = JSON.stringify(art);
    expect(s.length).toBeGreaterThan(10);
    expect(art.meta.method).toBe("demo");
  });
});
TS

cat > packages/pc-fit/tests/noarb_smoke.test.ts <<'TS'
import { describe, it, expect } from "vitest";
import { Fit } from "../src";

describe("static no-arb (light)", () => {
  it("reports zero violations for convex tv", () => {
    const k = [-1,-0.5,0,0.5,1];
    const tv = [1,0.3,0.2,0.3,1];
    const d = Fit.staticNoArbDiagnostics(k, tv);
    expect(d.violations).toBe(0);
  });
});
TS

echo "✅ PR-3 files created."
