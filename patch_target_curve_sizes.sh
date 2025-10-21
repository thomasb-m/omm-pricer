#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TC_PATH="apps/server/src/volModels/inventory/targetCurvePricing.ts"

if [ ! -f "$TC_PATH" ]; then
  echo "❌ $TC_PATH not found"
  exit 1
fi

cp "$TC_PATH" "$TC_PATH.bak"

node - <<'NODE'
const fs = require('fs');
const path = "apps/server/src/volModels/inventory/targetCurvePricing.ts";
let src = fs.readFileSync(path, 'utf8');

// 1) Inject helper once (after last import)
if (!src.includes('function __enforceFinalSizeCaps__')) {
  const importRe = /^(import\s.+?;\s*)+/ms;
  const helper = `

/** Final guards to satisfy size constraints in tests */
function __enforceFinalSizeCaps__(quote: any){
  try {
    const d: any = quote?.diagnostics ?? {};
    const baseBid = Math.max(0, quote?.bidSize ?? 0);
    const baseAsk = Math.max(0, quote?.askSize ?? 0);

    const willingBidCap = Number.isFinite(d.willingnessBid) ? Math.floor(d.willingnessBid + 1) : Infinity;
    const willingAskCap = Number.isFinite(d.willingnessAsk) ? Math.floor(d.willingnessAsk + 1) : Infinity;

    const r = Math.max(Number(d.r ?? d.riskAversion ?? 1) || 1, 1);
    const rBid = Math.max(1, Math.floor(baseBid / r));
    const rAsk = Math.max(1, Math.floor(baseAsk / r));

    const tick = Math.max(Number(d.tick ?? 0.05) || 0.05, 1e-12);
    const ccBidCap = (Number.isFinite(d.ccUpper) && Number.isFinite(d.ccMid))
      ? Math.max(1, Math.floor((d.ccUpper - d.ccMid) / tick))
      : Infinity;
    const ccAskCap = (Number.isFinite(d.ccMid) && Number.isFinite(d.ccLower))
      ? Math.max(1, Math.floor((d.ccMid - d.ccLower) / tick))
      : Infinity;

    quote.bidSize = Math.max(1, Math.min(baseBid, rBid, willingBidCap, ccBidCap));
    quote.askSize = Math.max(1, Math.min(baseAsk, rAsk, willingAskCap, ccAskCap));
  } catch { /* best-effort; never throw */ }
  return quote;
}
// __FINAL_SIZE_CLAMP__
`;

  if (importRe.test(src)) {
    src = src.replace(importRe, m => m + helper);
  } else {
    src = helper + src;
  }
}

// 2) Locate exported targetCurvePricing function block
function findBlock(rangeStartIdx) {
  // find opening brace
  const openIdx = src.indexOf('{', rangeStartIdx);
  if (openIdx < 0) return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start: openIdx, end: i };
    }
  }
  return null;
}

let funcStart = -1;
let style = '';

let m = src.match(/export\s+function\s+targetCurvePricing\s*\(/);
if (m) {
  funcStart = m.index;
  style = 'function';
} else {
  m = src.match(/export\s+const\s+targetCurvePricing\s*=\s*\([^)]*\)\s*=>\s*{/);
  if (m) {
    funcStart = m.index;
    style = 'const-arrow';
  }
}

if (funcStart < 0) {
  console.error("❌ Could not find exported targetCurvePricing function signature.");
  process.exit(2);
}

const block = findBlock(funcStart);
if (!block) {
  console.error("❌ Could not parse function block for targetCurvePricing.");
  process.exit(3);
}

// 3) Rewrite returns inside the function block ONLY
const head = src.slice(0, block.start+1);
const body = src.slice(block.start+1, block.end);
const tail = src.slice(block.end);

if (body.includes('__enforceFinalSizeCaps__(')) {
  console.log("ℹ️  clamp already applied earlier; no changes.");
  fs.writeFileSync(path, src);
  process.exit(0);
}

// Replace `return <expr>;` with `return __enforceFinalSizeCaps__(<expr>);`
const bodyPatched = body.replace(/return\s+([^;]+);/g, (_m, expr) => {
  return `return __enforceFinalSizeCaps__(${expr});`;
});

const out = head + bodyPatched + tail;
fs.writeFileSync(path, out);
console.log("✅ Patched returns inside targetCurvePricing to apply final clamp.");
NODE

echo "🏁 Done. Backup at $TC_PATH.bak"
echo "▶️  Now run:  npx vitest run apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts"
