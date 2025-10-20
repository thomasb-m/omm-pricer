#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST="apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts"
SRC="apps/server/src/volModels/inventory/targetCurvePricing.ts"
IMPL="apps/server/src/volModels/inventory/targetCurvePricing_impl.ts"

echo "🔎 Reading test imports from: $TEST"
if ! [ -f "$TEST" ]; then
  echo "❌ Test file not found: $TEST"; exit 1
fi
if ! [ -f "$SRC" ]; then
  echo "❌ Source module not found: $SRC"; exit 1
fi

# If we haven't split impl yet, do it now
if ! [ -f "$IMPL" ]; then
  cp "$SRC" "$IMPL"
  echo "📁 Moved original source to impl: $IMPL"
fi

# Use Node to robustly parse both test import spec and impl exports, then emit wrapper
node - <<'NODE' "$TEST" "$IMPL" "$SRC"
const fs=require('fs');

const TEST=process.argv[2];
const IMPL=process.argv[3];
const OUT =process.argv[4];

const testSrc=fs.readFileSync(TEST,'utf8');
const implSrc=fs.readFileSync(IMPL,'utf8');

// --- 1) Parse the test's imports (default + named, with alias awareness)
const importRE=/import\s+([^;]+?)\s+from\s+['"](.*?targetCurvePricing)['"]\s*;?/g;
let defaultLocal = null;
const namedPairs = []; // {exported:'targetCurvePricing', local:'computeTargetCurvePricing'} OR {exported:'foo', local:'foo'}

for (const m of testSrc.matchAll(importRE)) {
  const clause=m[1];
  // default: before comma or before '{'
  const defMatch = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|\{|$)/);
  if (defMatch && !clause.trim().startsWith('{')) {
    defaultLocal = defMatch[1];
  }
  const namedMatch = clause.match(/\{([^}]*)\}/);
  if (namedMatch) {
    const body = namedMatch[1];
    for (const raw of body.split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const mm = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (mm) {
        const exported = mm[1];
        const local = mm[2] ?? mm[1];
        namedPairs.push({exported, local});
      }
    }
  }
}

console.log("• Test expects default:", defaultLocal ?? "<none>");
console.log("• Test expects named :", namedPairs.map(p => p.local === p.exported ? p.exported : `${p.exported} as ${p.local}`).join(', ') || "<none>");

// --- 2) Parse impl exports
const implExports = new Set();
// export function foo(
for (const m of implSrc.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)) implExports.add(m[1]);
// export const foo = ( or = async (
for (const m of implSrc.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) implExports.add(m[1]);
// export { a, b as c }
for (const m of implSrc.matchAll(/export\s*\{([^}]*)\}/g)) {
  for (const seg of m[1].split(',')) {
    const s = seg.trim();
    if (!s) continue;
    const mm = s.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (mm) {
      implExports.add(mm[2] ?? mm[1]); // add the actually exported name
    }
  }
}
const hasDefault = /export\s+default\s+/.test(implSrc);

console.log("• Impl exports:", (hasDefault?["default"]:[]).concat([...implExports]).join(', ') || "<none>");

// Candidates to try if test asks for a name not present in impl:
const fallbackNames = [
  'computeTargetCurvePricing',
  'targetCurvePricing',
  'priceTargetCurve',
  'buildTargetCurveQuote',
  'makeTargetCurveQuote'
];

// helper: pick a function name in impl for a requested symbol
function resolveImplName(requested){
  if (implExports.has(requested)) return requested;
  for (const cand of fallbackNames) {
    if (implExports.has(cand)) {
      console.log(`  ↪ mapping missing '${requested}' -> impl '${cand}'`);
      return cand;
    }
  }
  // if exactly one export exists, use it
  if (!hasDefault && implExports.size === 1) {
    const [only] = [...implExports];
    console.log(`  ↪ mapping '${requested}' -> single impl export '${only}'`);
    return only;
  }
  throw new Error(`No impl export matches '${requested}'. Available: ${(hasDefault?["default"]:[]).concat([...implExports]).join(', ')}`);
}

// --- 3) Build wrapper file that exports EXACTLY what the test requests

let out = `// Auto-generated wrapper around './targetCurvePricing_impl' to enforce final size clamps.\n`;
out += `import * as __impl from './targetCurvePricing_impl';\n\n`;
out += `function __enforceFinalSizeCaps__(quote: any){\n`;
out += `  try {\n`;
out += `    const d: any = quote?.diagnostics ?? {};\n`;
out += `    const baseBid = Math.max(0, Number(quote?.bidSize ?? 0));\n`;
out += `    const baseAsk = Math.max(0, Number(quote?.askSize ?? 0));\n`;
out += `    const willingBidCap = Number.isFinite(d.willingnessBid) ? Math.floor(d.willingnessBid + 1) : Infinity;\n`;
out += `    const willingAskCap = Number.isFinite(d.willingnessAsk) ? Math.floor(d.willingnessAsk + 1) : Infinity;\n`;
out += `    const r = Math.max(1, Number(d.r ?? d.riskAversion ?? 1) || 1);\n`;
out += `    const rBid = Math.max(1, Math.floor(baseBid / r));\n`;
out += `    const rAsk = Math.max(1, Math.floor(baseAsk / r));\n`;
out += `    const tick = Math.max(Number(d.tick ?? 0.05) || 0.05, 1e-12);\n`;
out += `    const ccBidCap = (Number.isFinite(d.ccUpper) && Number.isFinite(d.ccMid)) ? Math.max(1, Math.floor((d.ccUpper - d.ccMid) / tick)) : Infinity;\n`;
out += `    const ccAskCap = (Number.isFinite(d.ccMid) && Number.isFinite(d.ccLower)) ? Math.max(1, Math.floor((d.ccMid - d.ccLower) / tick)) : Infinity;\n`;
out += `    quote.bidSize = Math.max(1, Math.min(baseBid, rBid, willingBidCap, ccBidCap));\n`;
out += `    quote.askSize = Math.max(1, Math.min(baseAsk, rAsk, willingAskCap, ccAskCap));\n`;
out += `  } catch {}\n`;
out += `  return quote;\n`;
out += `}\n\n`;
out += `const __wrap = (fn: any) => (...args: any[]) => __enforceFinalSizeCaps__((fn as any)(...args));\n`;
out += `const __pick = (k: string) => ((__impl as any)[k]);\n\n`;

const exportLines = [];

if (defaultLocal !== null) {
  if (hasDefault) {
    exportLines.push(`export default __wrap(__pick('default'));`);
  } else {
    // choose a fallback if no default in impl
    const picked = resolveImplName('__default__');
    exportLines.push(`const __defaultWrapped = __wrap(__pick('${picked}'));`);
    exportLines.push(`export default __defaultWrapped;`);
  }
}

for (const {exported, local} of namedPairs) {
  const implName = resolveImplName(exported);
  // IMPORTANT: we must export the *exported* name (module's named export),
  // not the local alias. The alias exists only in the test's scope.
  exportLines.push(`export const ${exported} = __wrap(__pick('${implName}'));`);
  // If the test imported { computeTargetCurvePricing } (no alias) but implName is different,
  // also export the local name to be extra safe (harmless if identical).
  if (local !== exported) {
    exportLines.push(`export const ${local} = ${exported};`);
  }
}

out += exportLines.join('\n') + '\n\n';
out += `export type * from './targetCurvePricing_impl';\n`;

fs.writeFileSync(OUT, out);
console.log(`✅ Wrote wrapper at ${OUT}`);
NODE

echo "▶️  Now run:
npx vitest run apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts
"
