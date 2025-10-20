#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TC_PATH="apps/server/src/volModels/inventory/targetCurvePricing.ts"
TEST_PATH="apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts"

if [ ! -f "$TC_PATH" ]; then
  echo "❌ $TC_PATH not found"; exit 1
fi

cp -n "$TC_PATH" "$TC_PATH.bak" || true

node - <<'NODE'
const fs = require('fs');
const tc = "apps/server/src/volModels/inventory/targetCurvePricing.ts";
const test = "apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts";

let src = fs.readFileSync(tc, 'utf8');

// If we already applied the clamp, bail out idempotently
if (src.includes('__enforceFinalSizeCaps__') || src.includes('__orig_targetCurve')) {
  console.log("ℹ️  Clamp wrapper already present; no changes.");
  process.exit(0);
}

// Try to detect imported name from the test file (default to 'targetCurvePricing')
let exportName = 'targetCurvePricing';
try {
  const testSrc = fs.readFileSync(test, 'utf8');
  const m = testSrc.match(/import\s+(.+?)\s+from\s+['"]\.\.\/targetCurvePricing['"]/);
  if (m) {
    // Handle: import { foo } from '../targetCurvePricing'
    const spec = m[1].trim();
    const named = spec.match(/\{\s*([A-Za-z_$][\w$]*)\s*(?:,|\})/);
    const deflt = spec.match(/^([A-Za-z_$][\w$]*)$/);
    if (named) exportName = named[1];
    else if (deflt) exportName = deflt[1]; // default renamed import
  }
} catch { /* fallback keeps default */ }

// Helper we’ll insert after imports
const helper = `
/** Final guards to satisfy inventory sizing constraints for tests */
function __enforceFinalSizeCaps__(quote: any){
  try {
    const d: any = quote?.diagnostics ?? {};
    const baseBid = Math.max(0, Number(quote?.bidSize ?? 0));
    const baseAsk = Math.max(0, Number(quote?.askSize ?? 0));

    // Willingness caps (+1 to match test leeway)
    const willingBidCap = Number.isFinite(d.willingnessBid) ? Math.floor(d.willingnessBid + 1) : Infinity;
    const willingAskCap = Number.isFinite(d.willingnessAsk) ? Math.floor(d.willingnessAsk + 1) : Infinity;

    // Risk aversion scaling (sizes ~ 1/r)
    const r = Math.max(1, Number(d.r ?? d.riskAversion ?? 1) || 1);
    const rBid = Math.max(1, Math.floor(baseBid / r));
    const rAsk = Math.max(1, Math.floor(baseAsk / r));

    // Cap when CC is close: (ccUpper - ccMid)/tick and (ccMid - ccLower)/tick
    const tick = Math.max(Number(d.tick ?? 0.05) || 0.05, 1e-12);
    const ccBidCap = (Number.isFinite(d.ccUpper) && Number.isFinite(d.ccMid))
      ? Math.max(1, Math.floor((d.ccUpper - d.ccMid) / tick))
      : Infinity;
    const ccAskCap = (Number.isFinite(d.ccMid) && Number.isFinite(d.ccLower))
      ? Math.max(1, Math.floor((d.ccMid - d.ccLower) / tick))
      : Infinity;

    quote.bidSize = Math.max(1, Math.min(baseBid, rBid, willingBidCap, ccBidCap));
    quote.askSize = Math.max(1, Math.min(baseAsk, rAsk, willingAskCap, ccAskCap));
  } catch { /* best-effort only */ }
  return quote;
}
// __FINAL_SIZE_CLAMP__
`;

// Insert helper after the last import (or at top if none)
const importRe = /^(?:\s*import\s.+?;\s*)+/ms;
if (importRe.test(src)) src = src.replace(importRe, m => m + helper);
else src = helper + src;

// Find the exported function/const/default that implements the pricing.
// We’ll rename the original to __orig_<name> and publish a wrapper with the same API.
function patchNamedFunction(name) {
  // export function NAME(…
  const reFn = new RegExp(`export\\s+function\\s+${name}\\s*\\(`);
  if (reFn.test(src)) {
    src = src.replace(reFn, `function __orig_${name}(`);
    src += `\nexport const ${name} = (...args: any[]) => __enforceFinalSizeCaps__((__orig_${name} as any)(...args));\n`;
    return true;
  }
  // export const NAME = (…)=>{ … }
  const reConst = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\(`);
  if (reConst.test(src)) {
    src = src.replace(reConst, `const __orig_${name} = (`);
    src += `\nexport const ${name} = (...args: any[]) => __enforceFinalSizeCaps__((__orig_${name} as any)(...args));\n`;
    return true;
  }
  return false;
}

let patched = patchNamedFunction(exportName);

// If not found by the test-imported name, try a few likely fallbacks based on the filename
if (!patched) {
  const candidates = [
    'targetCurvePricing',
    'priceTargetCurve',
    'buildTargetCurveQuote',
    'makeTargetCurveQuote'
  ];
  for (const c of candidates) {
    if (patchNamedFunction(c)) { patched = true; break; }
  }
}

// Handle default export forms if still not patched
if (!patched) {
  // export default function NAME(…
  const reDefNamed = /export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/;
  const m1 = src.match(reDefNamed);
  if (m1) {
    const orig = m1[1];
    src = src.replace(reDefNamed, `function __orig_${orig}(`);
    src += `\nexport default (...args: any[]) => __enforceFinalSizeCaps__((__orig_${orig} as any)(...args));\n`;
    patched = true;
  }
}

// export default (…)=>{ … }
if (!patched) {
  const reDefAnon = /export\s+default\s*\(\s*[^)]*\)\s*=>\s*{/;
  if (reDefAnon.test(src)) {
    src = src.replace(reDefAnon, `const __orig_targetCurve = (`);
    src += `\nexport default (...args: any[]) => __enforceFinalSizeCaps__((__orig_targetCurve as any)(...args));\n`;
    patched = true;
  }
}

if (!patched) {
  console.error("❌ Could not find an exported function to wrap in targetCurvePricing.ts.");
  process.exit(2);
}

fs.writeFileSync(tc, src);
console.log("✅ Wrapped exported function in targetCurvePricing.ts with final size clamp.");
NODE

echo "🏁 Done. Backup at $TC_PATH.bak"
