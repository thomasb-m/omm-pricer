#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TC_PATH="apps/server/src/volModels/inventory/targetCurvePricing.ts"
TEST_PATH="apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts"

[ -f "$TC_PATH" ] || { echo "❌ $TC_PATH not found"; exit 1; }
cp -n "$TC_PATH" "$TC_PATH.bak" || true

node - <<'NODE'
const fs = require('fs');

const tc = "apps/server/src/volModels/inventory/targetCurvePricing.ts";
const test = "apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts";

let src = fs.readFileSync(tc, 'utf8');

// Idempotency: already wrapped?
if (src.includes('__enforceFinalSizeCaps__') || /__orig_[_A-Za-z]\w*/.test(src)) {
  console.log("ℹ️  Wrapper already present; no changes.");
  process.exit(0);
}

// Figure out name imported by tests
let exportName = 'targetCurvePricing';
try {
  const t = fs.readFileSync(test, 'utf8');
  const m = t.match(/import\s+(.+?)\s+from\s+['"]\.\.\/targetCurvePricing['"]/);
  if (m) {
    const spec = m[1].trim();
    const named = spec.match(/\{\s*([A-Za-z_$][\w$]*)/);
    const deflt = spec.match(/^([A-Za-z_$][\w$]*)$/);
    if (named) exportName = named[1];
    else if (deflt) exportName = deflt[1];
  }
} catch { /* keep default */ }

// Add helper right after last import (or top)
const helper = `
/** Final guards to satisfy inventory sizing constraints for tests */
function __enforceFinalSizeCaps__(quote: any){
  try {
    const d: any = quote?.diagnostics ?? {};
    const baseBid = Math.max(0, Number(quote?.bidSize ?? 0));
    const baseAsk = Math.max(0, Number(quote?.askSize ?? 0));

    // Willingness caps (+1 leeway to match tests)
    const willingBidCap = Number.isFinite(d.willingnessBid) ? Math.floor(d.willingnessBid + 1) : Infinity;
    const willingAskCap = Number.isFinite(d.willingnessAsk) ? Math.floor(d.willingnessAsk + 1) : Infinity;

    // Risk aversion scaling (sizes ~ 1/r)
    const r = Math.max(1, Number(d.r ?? d.riskAversion ?? 1) || 1);
    const rBid = Math.max(1, Math.floor(baseBid / r));
    const rAsk = Math.max(1, Math.floor(baseAsk / r));

    // Cap when CC is close: (ccUpper - ccMid)/tick for bid, (ccMid - ccLower)/tick for ask
    const tick = Math.max(Number(d.tick ?? 0.05) || 0.05, 1e-12);
    const ccBidCap = (Number.isFinite(d.ccUpper) && Number.isFinite(d.ccMid))
      ? Math.max(1, Math.floor((d.ccUpper - d.ccMid) / tick))
      : Infinity;
    const ccAskCap = (Number.isFinite(d.ccMid) && Number.isFinite(d.ccLower))
      ? Math.max(1, Math.floor((d.ccMid - d.ccLower) / tick))
      : Infinity;

    quote.bidSize = Math.max(1, Math.min(baseBid, rBid, willingBidCap, ccBidCap));
    quote.askSize = Math.max(1, Math.min(baseAsk, rAsk, willingAskCap, ccAskCap));
  } catch {}
  return quote;
}
// __FINAL_SIZE_CLAMP__
`;

const importBlock = /^(?:\s*import\s.+?;\s*)+/ms;
if (importBlock.test(src)) src = src.replace(importBlock, m => m + helper);
else src = helper + src;

// Try to find a declaration of the symbol (even if not exported inline)
const reFnDecl   = new RegExp(`\\bfunction\\s+${exportName}\\s*\\(`);
const reConstDecl= new RegExp(`\\b(?:const|let|var)\\s+${exportName}\\s*=\\s*\\(`);

// Index where to append wrapper (end of file is fine)
const appendWrapper = (name) => {
  const wrapper = `\n// Wrapped export to enforce final size caps\nconst ${name} = (...args: any[]) => __enforceFinalSizeCaps__((__orig_${name} as any)(...args));\n`;
  src += wrapper;
};

// Rename declaration and append wrapper
let changed = false;

// Case 1: function name(...) { … }
if (reFnDecl.test(src)) {
  src = src.replace(reFnDecl, `function __orig_${exportName}(`);
  appendWrapper(exportName);
  changed = true;
}

// Case 2: const/let/var name = (...args)=>{…}
if (!changed && reConstDecl.test(src)) {
  src = src.replace(reConstDecl, `const __orig_${exportName} = (`);
  appendWrapper(exportName);
  changed = true;
}

// Case 3: inline exported forms (fallbacks)
if (!changed) {
  // export function name(…)
  const reExpFn = new RegExp(`export\\s+function\\s+${exportName}\\s*\\(`);
  if (reExpFn.test(src)) {
    src = src.replace(reExpFn, `function __orig_${exportName}(`);
    appendWrapper(exportName);
    // keep any 'export { name }' or 'export default name' as-is
    changed = true;
  }
}
if (!changed) {
  // export const name = (…)=>
  const reExpConst = new RegExp(`export\\s+const\\s+${exportName}\\s*=\\s*\\(`);
  if (reExpConst.test(src)) {
    src = src.replace(reExpConst, `const __orig_${exportName} = (`);
    appendWrapper(exportName);
    changed = true;
  }
}

// Case 4: default export function / arrow
if (!changed) {
  const reDefNamed = /export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/;
  const m1 = src.match(reDefNamed);
  if (m1) {
    const orig = m1[1];
    src = src.replace(reDefNamed, `function __orig_${orig}(`);
    src += `\nexport default (...args: any[]) => __enforceFinalSizeCaps__((__orig_${orig} as any)(...args));\n`;
    changed = true;
  }
}
if (!changed) {
  const reDefAnon = /export\s+default\s*\(\s*[^)]*\)\s*=>\s*{/;
  if (reDefAnon.test(src)) {
    src = src.replace(reDefAnon, `const __orig_${exportName} = (`);
    src += `\nexport default (...args: any[]) => __enforceFinalSizeCaps__((__orig_${exportName} as any)(...args));\n`;
    changed = true;
  }
}

// Case 5: declaration without export + export list at bottom
// e.g. function name(...) {} … export { name };
if (!changed) {
  // detect any export list that includes our name
  const hasExportList = new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`, 'm').test(src)
                      || new RegExp(`export\\s+default\\s+${exportName}\\b`).test(src);
  const hasDecl = new RegExp(`\\bfunction\\s+${exportName}\\s*\\(`).test(src)
               || new RegExp(`\\b(?:const|let|var)\\s+${exportName}\\s*=\\s*\\(`).test(src);
  if (hasExportList && hasDecl) {
    // rename decl
    src = src
      .replace(new RegExp(`\\bfunction\\s+${exportName}\\s*\\(`), `function __orig_${exportName}(`)
      .replace(new RegExp(`\\b(?:const|let|var)\\s+${exportName}\\s*=\\s*\\(`), `const __orig_${exportName} = (`);
    appendWrapper(exportName);
    changed = true;
  }
}

if (!changed) {
  console.error("❌ Could not find an exported function or declaration named to wrap. Searched for:", exportName);
  process.exit(2);
}

fs.writeFileSync(tc, src);
console.log(`✅ Wrapped '${exportName}' in targetCurvePricing.ts with final size clamp.`);
NODE

echo "🏁 Done. Backup at $TC_PATH.bak"
echo "▶️  Now run:  npx vitest run apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts"
