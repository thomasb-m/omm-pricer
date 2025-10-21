#!/usr/bin/env bash
set -euo pipefail

echo "🩹 Installing Node 22 type shim..."
npm i -D undici-types

echo "🛠️ Patching tsconfig moduleResolution/types (root + packages)…"
node - <<'NODE'
const fs = require('fs');

function patchTsconfig(file){
  if (!fs.existsSync(file)) return;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.compilerOptions = j.compilerOptions || {};
  // keep your current settings, just add/ensure these:
  j.compilerOptions.moduleResolution = 'nodenext';
  j.compilerOptions.skipLibCheck = true;
  const types = new Set([...(j.compilerOptions.types || []), 'node', 'undici-types']);
  j.compilerOptions.types = Array.from(types);
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  console.log('  • patched', file);
}

[
  'tsconfig.json',
  'packages/pc-fit/tsconfig.json',
  'packages/risk-core/tsconfig.json',
  'packages/vol-core/tsconfig.json'
].forEach(patchTsconfig);
NODE

echo "🧪 Fixing concavity test (was using a convex 'smile')…"
cat > packages/pc-fit/tests/convexity_penalty.test.ts <<'TS'
import { describe, it, expect } from "vitest";
import { Fit } from "../src";

describe("convexity penalty in k-space", () => {
  it("penalizes concavity", () => {
    const k = [-1, 0, 1];
    // concave (frown): center higher than wings -> should be penalized
    const tv = [1, 1.9, 1];
    const { penalty, violations } = Fit.convexityPenaltyK(k, tv, 0);
    expect(violations).toBeGreaterThan(0);
    expect(penalty).toBeGreaterThan(0);
  });
});
TS

echo "✅ Patch complete."
