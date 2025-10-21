#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Node version guard
REQUIRED_NODE_MAJOR=18
CURRENT_NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$CURRENT_NODE_VERSION" ] || [ "$CURRENT_NODE_VERSION" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "❌ Error: Node >= $REQUIRED_NODE_MAJOR required. Current: ${CURRENT_NODE_VERSION:-none}"
  exit 1
fi

echo "🚀 Installing Step 4: Production-Ready PC-Fit Package"
echo "======================================================"

# 1. Merge root package.json (idempotent)
echo "📦 Configuring root workspace..."
node -e '
  const fs = require("fs");
  const path = "package.json";
  const pkg = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  
  // Merge workspaces
  const ws = new Set(pkg.workspaces || []);
  ws.add("packages/*");
  pkg.workspaces = Array.from(ws);
  
  // Merge scripts (only if missing)
  pkg.scripts = pkg.scripts || {};
  pkg.scripts["test:pc"] = pkg.scripts["test:pc"] || "npm run -w packages/pc-fit test";
  pkg.scripts["ci:step4"] = pkg.scripts["ci:step4"] || "npm run -w packages/pc-fit build && npm run -w packages/pc-fit test && npm run ci:step3";
  
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log("✅ Merged workspaces + scripts into root package.json");
'

# 2. Create package structure
echo "📁 Creating package structure..."
mkdir -p packages/pc-fit/src
mkdir -p packages/pc-fit/tests

# 3. Package package.json
cat > packages/pc-fit/package.json << 'EOF'
{
  "name": "@pc-fit/core",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "build": "tsc -b",
    "pretest": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "vitest": "^2.1.8",
    "typescript": "^5.6.0"
  }
}
EOF

# 4. Package tsconfig.json
cat > packages/pc-fit/tsconfig.json << 'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "composite": true,
    "moduleResolution": "bundler",
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*"],
  "exclude": ["tests", "dist"]
}
EOF

# 5. Vitest config
cat > packages/pc-fit/vitest.config.ts << 'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts']
  }
});
EOF

# 6. Source files
cat > packages/pc-fit/src/types.ts << 'EOF'
export interface Leg {
  strike: number;
  marketMid: number;
  weight?: number;
  isCall?: boolean;
  vega?: number;
}

export interface FitOptions {
  minTick: number;
  minTVTicks: number;
  minTVFracOfCC: number;
  applyTickFloorWithinBand?: boolean;
  minTVAbsFloorTicks?: number;
  maxOutlierTrimBps?: number;
  robustLoss?: 'huber' | 'tukey';
  huberC?: number;
  tukeyC?: number;
  enforceCallConvexity?: boolean;
  convexityTol?: number;
  taperBand?: number;
  taperExp?: number;
}

export interface FitInput {
  legs: Leg[];
  forward: number;
  ccTV: number[];
  phi: number[];
  options: FitOptions;
}

export interface FitResult {
  theta: number;
  tvFitted: number[];
  w0: number[];
  wFinal: number[];
  usedMask: boolean[];
  usedCount: number;
  rmseBps: number;
  degenerate: boolean;
  metadata: {
    irlsIters: number;
    thetaShrinkCount: number;
    trimmedCount: number;
    minTVSlack: number;
  };
}
EOF

cat > packages/pc-fit/src/sanitize.ts << 'EOF'
import { Leg } from './types';

export interface SanitizedLegs {
  legs: Leg[];
  k: number[];
  indices: number[];
}

export function logMoneyness(strike: number, forward: number): number {
  return Math.log(strike / forward);
}

export function sanitizeLegs(legs: Leg[], forward: number): SanitizedLegs {
  const withK = legs
    .map((leg, idx) => ({ leg, idx }))
    .filter(({ leg }) =>
      Number.isFinite(leg.strike) &&
      Number.isFinite(leg.marketMid) &&
      leg.strike > 0 &&
      leg.marketMid >= 0
    )
    .map(({ leg, idx }) => ({
      leg,
      k: logMoneyness(leg.strike, forward),
      originalIdx: idx
    }));

  if (withK.length === 0) throw new Error('No valid legs after sanitization');

  withK.sort((a, b) => a.k - b.k);

  const dedup = new Map<number, typeof withK[0]>();
  for (const item of withK) {
    const ex = dedup.get(item.leg.strike);
    if (!ex || (item.leg.weight ?? 1) > (ex.leg.weight ?? 1)) {
      dedup.set(item.leg.strike, item);
    }
  }

  const sorted = Array.from(dedup.values()).sort((a, b) => a.k - b.k);

  return {
    legs: sorted.map(x => x.leg),
    k: sorted.map(x => x.k),
    indices: sorted.map(x => x.originalIdx)
  };
}
EOF

cat > packages/pc-fit/src/interp.ts << 'EOF'
export function taperAbsK(k: number[], band: number = 0.25, p: number = 1.0): number[] {
  const b = Math.max(band, 1e-12);
  return k.map(ki => {
    const r = Math.abs(ki) / b;
    return Math.max(0, 1 - Math.pow(r, p));
  });
}

export function linearInterp(x: number[], y: number[], xq: number): number {
  if (xq <= x[0]) return y[0];
  if (xq >= x[x.length - 1]) return y[y.length - 1];
  
  for (let i = 0; i < x.length - 1; i++) {
    if (xq >= x[i] && xq <= x[i + 1]) {
      const t = (xq - x[i]) / (x[i + 1] - x[i]);
      return y[i] + t * (y[i + 1] - y[i]);
    }
  }
  return y[y.length - 1];
}
EOF

cat > packages/pc-fit/src/weights.ts << 'EOF'
import { Leg, FitOptions } from './types';

export function baseWeights(
  legs: Leg[],
  phi: number[],
  ccTV: number[],
  options: FitOptions
): number[] {
  const kappa = 2.0;
  const delta = 0.1;

  return legs.map((leg, i) => {
    if (phi[i] <= 0) return 0;

    let scale: number;
    if (leg.vega != null && leg.vega > 0) {
      const vegaScale = kappa * leg.vega * 0.0001;
      const tvScale = delta * 0.0001 * ccTV[i];
      scale = Math.max(vegaScale, tvScale);
    } else {
      scale = Math.max(0.0001 * ccTV[i], 1e-6);
    }

    const w = (leg.weight ?? 1) * phi[i];
    return w / (scale * scale);
  });
}

export function trimByTVBps(
  resid: number[],
  mktTV: number[],
  minTick: number,
  maxBps?: number
): boolean[] {
  if (!maxBps || maxBps <= 0) return resid.map(() => true);
  return resid.map((r, i) => {
    const scale = Math.max(mktTV[i], 5 * minTick);
    const bps = Math.abs(r) / Math.max(scale, 1e-12) * 1e4;
    return bps <= maxBps;
  });
}

export function applyTrimBps(
  resid: number[],
  w0: number[],
  maxBps: number
): boolean[] {
  if (!Number.isFinite(maxBps) || maxBps <= 0) {
    return resid.map(() => true);
  }

  const used = resid.map((r, i) => w0[i] > 0);
  const usedResid = resid.filter((_, i) => used[i]);
  if (usedResid.length === 0) return used;

  const abs = usedResid.map(Math.abs);
  abs.sort((a, b) => a - b);
  const med = abs[Math.floor(abs.length / 2)];
  const mad = abs.map(a => Math.abs(a - med));
  mad.sort((a, b) => a - b);
  const madVal = mad[Math.floor(mad.length / 2)];
  const sigma = 1.4826 * madVal;

  const tol = Math.max(maxBps * 0.0001, 3 * sigma);
  return resid.map((r, i) => used[i] && Math.abs(r) <= tol);
}
EOF

cat > packages/pc-fit/src/robust.ts << 'EOF'
export function huberWeights(resid: number[], w0: number[], c: number = 1.345): number[] {
  const used = resid.map((_, i) => w0[i] > 0);
  const usedResid = resid.filter((_, i) => used[i]);
  if (usedResid.length === 0) return w0.map(() => 0);

  const abs = usedResid.map(Math.abs);
  abs.sort((a, b) => a - b);
  const med = abs[Math.floor(abs.length / 2)];
  const mad = abs.map(a => Math.abs(a - med));
  mad.sort((a, b) => a - b);
  const madVal = mad[Math.floor(mad.length / 2)];
  const sigma = Math.max(1.4826 * madVal, 1e-8);

  return resid.map((r, i) => {
    if (w0[i] <= 0) return 0;
    const z = Math.abs(r) / sigma;
    return z <= c ? 1 : c / z;
  });
}

export function tukeyWeights(resid: number[], w0: number[], c: number = 4.685): number[] {
  const used = resid.map((_, i) => w0[i] > 0);
  const usedResid = resid.filter((_, i) => used[i]);
  if (usedResid.length === 0) return w0.map(() => 0);

  const abs = usedResid.map(Math.abs);
  abs.sort((a, b) => a - b);
  const med = abs[Math.floor(abs.length / 2)];
  const mad = abs.map(a => Math.abs(a - med));
  mad.sort((a, b) => a - b);
  const madVal = mad[Math.floor(mad.length / 2)];
  const sigma = Math.max(1.4826 * madVal, 1e-8);

  return resid.map((r, i) => {
    if (w0[i] <= 0) return 0;
    const z = Math.abs(r) / sigma;
    if (z >= c) return 0;
    const u = 1 - (z / c) ** 2;
    return u * u;
  });
}
EOF

cat > packages/pc-fit/src/guards.ts << 'EOF'
type Block = { start: number; end: number; sum: number; width: number };

export function convexRepair(strikes: number[], tv: number[], lower: number[]): number[] {
  const n = tv.length;
  const x = tv.map((v, i) => Math.max(v, lower[i]));
  
  const widths = Array.from({ length: n - 1 }, (_, i) => 
    Math.max(1e-12, strikes[i + 1] - strikes[i])
  );
  
  const slopes = widths.map((h, i) => (x[i + 1] - x[i]) / h);

  const blocks: Block[] = [];
  for (let i = 0; i < slopes.length; i++) {
    blocks.push({ 
      start: i, 
      end: i + 1, 
      sum: slopes[i] * widths[i], 
      width: widths[i] 
    });
    
    while (blocks.length >= 2) {
      const a = blocks[blocks.length - 2];
      const b = blocks[blocks.length - 1];
      if (a.sum / a.width <= b.sum / b.width) break;
      
      blocks.splice(blocks.length - 2, 2, {
        start: a.start,
        end: b.end,
        sum: a.sum + b.sum,
        width: a.width + b.width
      });
    }
  }

  const sMon = new Array(slopes.length);
  for (const bl of blocks) {
    const avg = bl.sum / bl.width;
    for (let i = bl.start; i < bl.end; i++) {
      sMon[i] = avg;
    }
  }

  const out = new Array(n);
  out[0] = x[0];
  for (let i = 0; i < sMon.length; i++) {
    out[i + 1] = out[i] + sMon[i] * widths[i];
  }

  for (let i = 0; i < n; i++) {
    out[i] = Math.max(out[i], lower[i]);
  }

  return out;
}

export function projectThetaByCallConvexity(
  theta: number,
  strikes: number[],
  forward: number,
  ccTV: number[],
  taper: number[],
  tol: number = 1e-6
): { theta: number; shrinkCount: number } {
  let shrinkCount = 0;
  let th = theta;

  for (let iter = 0; iter < 10; iter++) {
    const tv = ccTV.map((cc, i) => cc + th * taper[i]);
    const callMid = tv.map((t, i) => {
      const intrinsic = Math.max(0, 1 - strikes[i] / Math.max(forward, 1e-12));
      return intrinsic + t;
    });

    let maxViol = 0;
    for (let i = 1; i < strikes.length - 1; i++) {
      const K0 = strikes[i - 1], K1 = strikes[i], K2 = strikes[i + 1];
      const C0 = callMid[i - 1], C1 = callMid[i], C2 = callMid[i + 1];
      const dK1 = K1 - K0, dK2 = K2 - K1;
      const dC1 = (C1 - C0) / dK1, dC2 = (C2 - C1) / dK2;
      const d2C = (dC2 - dC1) / ((dK1 + dK2) / 2);
      maxViol = Math.max(maxViol, -d2C);
    }

    if (maxViol <= tol) break;
    th *= 0.8;
    shrinkCount++;
  }

  return { theta: th, shrinkCount };
}
EOF

cat > packages/pc-fit/src/convex_tv_fit.ts << 'EOF'
import { FitInput, FitResult, FitOptions } from './types';
import { sanitizeLegs } from './sanitize';
import { taperAbsK } from './interp';
import { baseWeights, trimByTVBps } from './weights';
import { huberWeights, tukeyWeights } from './robust';
import { convexRepair, projectThetaByCallConvexity } from './guards';

export function fitConvexTV(input: FitInput): FitResult {
  const { legs, forward, ccTV, phi, options } = input;

  const san = sanitizeLegs(legs, forward);
  const n = san.legs.length;

  const ccTVVec = san.indices.map(i => ccTV[i]);
  const phiVec  = san.indices.map(i => phi[i]);
  const mktTV   = san.legs.map(l => Math.max(l.marketMid, 0));

  const target = ccTVVec.map((cc, i) => mktTV[i] - cc);

  const taper = taperAbsK(san.k, options.taperBand ?? 0.25, options.taperExp ?? 1.0);

  const w0        = baseWeights(san.legs, phiVec, ccTVVec, options);
  const usedInit  = w0.map(w => w > 0);
  const usedCount = usedInit.filter(Boolean).length;

  if (usedCount < 5) {
    return {
      theta: 0,
      tvFitted: ccTVVec.slice(),
      w0,
      wFinal: w0.slice(),
      usedMask: usedInit,
      usedCount,
      rmseBps: 0,
      degenerate: true,
      metadata: { irlsIters: 0, thetaShrinkCount: 0, trimmedCount: 0, minTVSlack: 0 }
    };
  }

  if (phiVec.every(p => p === 0)) {
    const floorVec = buildFloors(san.legs, ccTVVec, taper, options);
    const tvFitted = convexRepair(san.legs.map(l => l.strike), ccTVVec, floorVec);
    return {
      theta: 0,
      tvFitted,
      w0,
      wFinal: w0.slice(),
      usedMask: usedInit,
      usedCount,
      rmseBps: 0,
      degenerate: false,
      metadata: { irlsIters: 0, thetaShrinkCount: 0, trimmedCount: 0, minTVSlack: 0 }
    };
  }

  let theta = solveWLS(target, taper, w0);
  let resid = target.map((t, i) => t - theta * taper[i]);

  const prelim = trimByTVBps(resid, mktTV, options.minTick, options.maxOutlierTrimBps);

  let wr = w0.map(() => 1);
  let irlsIters = 0;
  const maxIters = 5;

  for (let iter = 0; iter < maxIters; iter++) {
    irlsIters++;
    const wEff = w0.map((w, i) => w * wr[i] * (prelim[i] ? 1 : 0));

    theta = solveWLS(target, taper, wEff);
    resid = target.map((t, i) => t - theta * taper[i]);

    const wrNew = options.robustLoss === 'tukey'
      ? tukeyWeights(resid, wEff, options.tukeyC ?? 4.685)
      : huberWeights(resid, wEff, options.huberC ?? 1.345);

    const maxDiff = wr.reduce((acc, w, i) => Math.max(acc, Math.abs(w - wrNew[i])), 0);
    wr = wrNew;
    if (maxDiff < 1e-4) break;
  }

  const secondTrim = trimByTVBps(resid, mktTV, options.minTick, options.maxOutlierTrimBps);

  const wFinal = w0.map((w, i) => w * wr[i] * (prelim[i] ? 1 : 0) * (secondTrim[i] ? 1 : 0));

  theta = solveWLS(target, taper, wFinal);

  let shrinkCount = 0;
  if (options.enforceCallConvexity) {
    const proj = projectThetaByCallConvexity(
      theta,
      san.legs.map(l => l.strike),
      forward,
      ccTVVec,
      taper,
      options.convexityTol ?? 1e-6
    );
    theta = proj.theta;
    shrinkCount = proj.shrinkCount;
  }

  const tvRaw    = ccTVVec.map((cc, i) => cc + theta * taper[i]);
  const floorVec = buildFloors(san.legs, ccTVVec, taper, options);
  const tvFitted = convexRepair(san.legs.map(l => l.strike), tvRaw, floorVec);

  const used = wFinal.map(w => w > 0);
  let bpsSumSq = 0, bpsN = 0;
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const err   = tvFitted[i] - mktTV[i];
    const scale = Math.max(mktTV[i], 5 * options.minTick);
    const bps   = (err / Math.max(scale, 1e-12)) * 1e4;
    bpsSumSq += bps * bps;
    bpsN++;
  }
  const rmseBps   = bpsN > 0 ? Math.sqrt(bpsSumSq / bpsN) : 0;
  const minTVSlack = Math.min(...tvFitted.map((tv, i) => tv - floorVec[i]));
  const trimmedCount = usedInit.filter(Boolean).length - used.filter(Boolean).length;

  return {
    theta,
    tvFitted,
    w0,
    wFinal,
    usedMask: used,
    usedCount: used.filter(Boolean).length,
    rmseBps,
    degenerate: false,
    metadata: { irlsIters, thetaShrinkCount: shrinkCount, trimmedCount, minTVSlack }
  };
}

function solveWLS(target: number[], X: number[], w: number[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < target.length; i++) {
    if (w[i] > 0) {
      num += w[i] * X[i] * target[i];
      den += w[i] * X[i] * X[i];
    }
  }
  return den > 1e-12 ? num / den : 0;
}

function buildFloors(
  legs: { strike: number; marketMid: number; weight?: number }[],
  ccTV: number[],
  taper: number[],
  options: FitOptions
): number[] {
  const {
    minTick,
    minTVTicks,
    minTVFracOfCC,
    applyTickFloorWithinBand = true,
    minTVAbsFloorTicks = 1
  } = options;

  const absFloor = minTVAbsFloorTicks * minTick;

  return legs.map((_, i) => {
    const inBand    = (taper[i] > 0) || !applyTickFloorWithinBand;
    const tickFloor = inBand ? minTVTicks * minTick : 0;
    const fracFloor = minTVFracOfCC * ccTV[i];
    return Math.max(absFloor, tickFloor, fracFloor);
  });
}
EOF

cat > packages/pc-fit/src/index.ts << 'EOF'
export * from './types';
export * from './sanitize';
export * from './interp';
export * from './weights';
export * from './robust';
export * from './guards';
export * from './convex_tv_fit';
EOF

# 7. Test files
cat > packages/pc-fit/tests/convex_tv_fit.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { fitConvexTV } from '../src/convex_tv_fit';
import type { FitInput } from '../src/types';

describe('fitConvexTV', () => {
  const options = {
    minTick: 0.0001,
    minTVTicks: 5,
    minTVFracOfCC: 0.05,
    maxOutlierTrimBps: 100,
    robustLoss: 'huber' as const,
    enforceCallConvexity: true,
    convexityTol: 1e-6,
    taperExp: 1.5
  };

  it('should handle graceful degradation (< 5 quotes)', () => {
    const input: FitInput = {
      legs: [
        { strike: 95, marketMid: 0.05, weight: 1 },
        { strike: 100, marketMid: 0.03, weight: 1 }
      ],
      forward: 100,
      ccTV: [0.048, 0.028],
      phi: [1, 1],
      options
    };

    const result = fitConvexTV(input);
    expect(result.degenerate).toBe(true);
    expect(result.theta).toBe(0);
    expect(result.usedCount).toBe(2);
  });

  it('should preserve convexity after floor application', () => {
    const strikes = [90, 95, 100, 105, 110];
    const input: FitInput = {
      legs: strikes.map(K => ({ strike: K, marketMid: 0.05, weight: 1 })),
      forward: 100,
      ccTV: [0.048, 0.042, 0.038, 0.042, 0.048],
      phi: [1, 1, 1, 1, 1],
      options
    };

    const result = fitConvexTV(input);
    
    const F = input.forward;
    for (let i = 1; i < strikes.length - 1; i++) {
      const K0 = strikes[i - 1], K1 = strikes[i], K2 = strikes[i + 1];
      const C0 = Math.max(0, F - K0) + result.tvFitted[i - 1];
      const C1 = Math.max(0, F - K1) + result.tvFitted[i];
      const C2 = Math.max(0, F - K2) + result.tvFitted[i + 1];
      
      const dK1 = K1 - K0, dK2 = K2 - K1;
      const dC1 = (C1 - C0) / dK1, dC2 = (C2 - C1) / dK2;
      const d2C = (dC2 - dC1) / ((dK1 + dK2) / 2);
      
      expect(d2C).toBeGreaterThanOrEqual(-options.convexityTol);
    }
  });

  it('should trim outliers correctly', () => {
    const strikes = [90, 95, 100, 105, 110];
    const input: FitInput = {
      legs: strikes.map((K, i) => ({ 
        strike: K, 
        marketMid: i === 2 ? 0.20 : 0.05,
        weight: 1 
      })),
      forward: 100,
      ccTV: [0.048, 0.042, 0.038, 0.042, 0.048],
      phi: [1, 1, 1, 1, 1],
      options
    };

    const result = fitConvexTV(input);
    expect(result.metadata.trimmedCount).toBeGreaterThan(0);
    expect(result.usedMask[2]).toBe(false);
  });

  it('should apply absolute floor in deep wings', () => {
    const strikes = [50, 75, 100, 125, 150];
    const input: FitInput = {
      legs: strikes.map(K => ({ strike: K, marketMid: 0.001, weight: 1 })),
      forward: 100,
      ccTV: [0.0001, 0.0005, 0.002, 0.0005, 0.0001],
      phi: [0, 0.5, 1, 0.5, 0],
      options: { ...options, minTVAbsFloorTicks: 1 }
    };

    const result = fitConvexTV(input);
    
    expect(result.tvFitted[0]).toBeGreaterThanOrEqual(options.minTick);
    expect(result.tvFitted[4]).toBeGreaterThanOrEqual(options.minTick);
  });

  it('should skip IRLS when all phi=0', () => {
    const strikes = [90, 95, 100, 105, 110];
    const input: FitInput = {
      legs: strikes.map(K => ({ strike: K, marketMid: 0.05, weight: 1 })),
      forward: 100,
      ccTV: [0.048, 0.042, 0.038, 0.042, 0.048],
      phi: [0, 0, 0, 0, 0],
      options
    };

    const result = fitConvexTV(input);
    expect(result.metadata.irlsIters).toBe(0);
    expect(result.theta).toBe(0);
  });

  it('should combine trim masks correctly', () => {
    const strikes = [90, 92, 95, 100, 105, 108, 110];
    const input: FitInput = {
      legs: strikes.map((K, i) => ({ 
        strike: K, 
        marketMid: i === 1 ? 0.15 : (i === 5 ? 0.18 : 0.05),
        weight: 1 
      })),
      forward: 100,
      ccTV: [0.048, 0.045, 0.042, 0.038, 0.042, 0.045, 0.048],
      phi: [1, 1, 1, 1, 1, 1, 1],
      options
    };

    const result = fitConvexTV(input);
    
    expect(result.usedMask[1]).toBe(false);
    expect(result.usedMask[5]).toBe(false);
    expect(result.metadata.trimmedCount).toBe(2);
  });
});
EOF

cat > packages/pc-fit/tests/taper_shape.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { taperAbsK } from '../src/interp';

describe('taperAbsK', () => {
  it('is 1 at ATM and decreases toward wings', () => {
    const k = [-0.3,-0.15,0,0.15,0.3];
    const phi = taperAbsK(k, 0.25, 1.0);
    expect(phi[2]).toBeGreaterThan(phi[1]);
    expect(phi[2]).toBeGreaterThan(phi[3]);
    expect(phi[0]).toBe(0);
    expect(phi[4]).toBe(0);
  });
});
EOF

cat > packages/pc-fit/tests/convexity_units.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { projectThetaByCallConvexity } from '../src/guards';

describe('projectThetaByCallConvexity units', () => {
  it('uses normalized intrinsic + TV', () => {
    const F = 100, strikes = [90,95,100,105,110];
    const cc = [0.04,0.038,0.037,0.038,0.04];
    const taper = [0.2,0.6,1,0.6,0.2];
    const { theta } = projectThetaByCallConvexity(0.01, strikes, F, cc, taper, 1e-6);
    expect(Number.isFinite(theta)).toBe(true);
  });
});
EOF

cat > packages/pc-fit/tests/trim_bps.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { trimByTVBps } from '../src/weights';

describe('trimByTVBps', () => {
  it('trims by bps of market TV', () => {
    const resid = [0, 0.001, 0.01];
    const mktTV = [0.01, 0.01, 0.01];
    const used = trimByTVBps(resid, mktTV, 1e-6, 50);
    expect(used[0]).toBe(true);
    expect(used[1]).toBe(false);
    expect(used[2]).toBe(false);
  });
});
EOF

# 8. Merge root tsconfig.json path alias (idempotent)
echo "🔧 Merging path alias into root tsconfig.json..."
node -e '
  const fs = require("fs");
  const path = "tsconfig.json";
  const cfg = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  
  cfg.compilerOptions = cfg.compilerOptions || {};
  cfg.compilerOptions.paths = cfg.compilerOptions.paths || {};
  cfg.compilerOptions.paths["@pc-fit/*"] = ["packages/pc-fit/src/*"];
  
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  console.log("✅ Merged @pc-fit/* path alias into root tsconfig.json");
'

# 9. Install dependencies
echo "📦 Installing dependencies..."
npm install

# 10. Build & test
echo "🔨 Building & testing package..."
npm run -w packages/pc-fit build
npm run -w packages/pc-fit test

echo ""
echo "✅ Step 4: Production-Ready PC-Fit Package installed successfully!"
echo ""
echo "📋 Verification:"
echo "   • Run: npm run test:pc"
echo "   • Run: npm run ci:step4"
echo "   • Check: packages/pc-fit/dist/ contains compiled outputs"
echo ""
echo "Ready to integrate into server! 🚀"
