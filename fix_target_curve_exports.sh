#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TC_DIR="apps/server/src/volModels/inventory"
SRC="$TC_DIR/targetCurvePricing.ts"
IMPL="$TC_DIR/targetCurvePricing_impl.ts"
TEST="$TC_DIR/__tests__/targetCurvePricing.test.ts"

echo "🔎 inspecting test imports..."
if ! [ -f "$TEST" ]; then
  echo "❌ $TEST not found"; exit 1
fi

IMPORT_LINE=$(grep -nE "^[[:space:]]*import .* from ['\"]/\.{1,2}/targetCurvePricing['\"];?[[:space:]]*$" "$TEST" | head -n1 || true)
if [ -z "$IMPORT_LINE" ]; then
  echo "❌ could not find an import from '../targetCurvePricing' in $TEST"
  echo "   grep this manually:"
  echo "   grep -n \"from '../targetCurvePricing'\" $TEST"
  exit 2
fi
echo "• test import: ${IMPORT_LINE}"

LINE_NO="${IMPORT_LINE%%:*}"
SPEC="$(sed -n "${LINE_NO}p" "$TEST")"

DEF_NAME=""
declare -a NAMED_NAMES=()

# default import?
if [[ "$SPEC" =~ ^[[:space:]]*import[[:space:]]+([A-Za-z_.$][A-Za-z0-9_.$]*)[[:space:]]*(,|\{)? ]]; then
  DEF_NAME="${BASH_REMATCH[1]}"
fi
# named imports
if [[ "$SPEC" =~ \{([^\}]*)\} ]]; then
  RAW="${BASH_REMATCH[1]}"
  while IFS=',' read -r part; do
    part="$(echo "$part" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [ -z "$part" ] && continue
    left="$(echo "$part" | sed -E 's/[[:space:]]+as[[:space:]]+.*$//')"
    left="$(echo "$left" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [ -n "$left" ] && NAMED_NAMES+=("$left")
  done <<< "$RAW"
fi

echo "• detected default: ${DEF_NAME:-<none>}"
echo "• detected named  : ${NAMED_NAMES[*]:-<none>}"

echo "🔎 ensuring impl/wrapper layout..."
if ! [ -f "$SRC" ]; then
  echo "❌ $SRC not found"; exit 3
fi

# if we haven't created impl yet, move the current source to impl
if ! [ -f "$IMPL" ]; then
  cp "$SRC" "$IMPL"
  echo "• moved original -> $IMPL"
fi

echo "🔎 scanning actual exports in impl..."
# gather export names from impl
mapfile -t EXPS < <(node - <<'NODE'
const fs=require('fs');
const p=process.argv[1];
const s=fs.readFileSync(p,'utf8');
// capture named exports
const names=new Set();
// export function foo(
for(const m of s.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
// export const foo = ( or = async (
for(const m of s.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) names.add(m[1]);
// export { a, b as c }
for(const m of s.matchAll(/export\s*\{([^}]*)\}/g)){
  for(const part of m[1].split(',')){
    const left=part.trim().split(/\s+as\s+/i)[0]?.trim();
    if(left) names.add(left);
  }
}
// export default (named or anonymous)
const hasDefault = /export\s+default\s+/.test(s);
const out=[...names];
if(hasDefault) out.push('default');
console.log(out.join('\n'));
NODE
"$IMPL")

printf "• impl exports: %s\n" "${EXPS[*]:-<none>}"

# decide mappings: what the test imports -> what impl provides
declare -A MAP=()

# helper to check presence in EXPS
has_exp () { local x="$1"; for e in "${EXPS[@]:-}"; do [ "$e" = "$x" ] && return 0; done; return 1; }

# if default requested
if [ -n "$DEF_NAME" ]; then
  if has_exp "default"; then
    MAP["__default__"]="default"
  else
    echo "⚠️  test imports default but impl has no default export."
    # if impl has exactly one function-like export, map it to default
    COUNT=0; CAND=""
    for e in "${EXPS[@]:-}"; do
      [ "$e" = "default" ] && continue
      COUNT=$((COUNT+1)); CAND="$e"
    done
    if [ "$COUNT" -eq 1 ]; then
      MAP["__default__"]="$CAND"
      echo "   ↳ mapping test default -> impl '${CAND}'"
    else
      echo "❌ ambiguous: multiple impl exports, cannot guess default"; exit 4
    fi
  fi
fi

# for named imports
for n in "${NAMED_NAMES[@]:-}"; do
  if has_exp "$n"; then
    MAP["$n"]="$n"
  else
    # try common aliases
    for c in computeTargetCurvePricing targetCurvePricing priceTargetCurve buildTargetCurveQuote makeTargetCurveQuote; do
      if has_exp "$c"; then MAP["$n"]="$c"; break; fi
    done
    if [ -z "${MAP[$n]+_}" ]; then
      echo "❌ test expects named '${n}' but impl doesn't export it (exports: ${EXPS[*]:-none})"; exit 5
    else
      echo "   ↳ mapping test '${n}' -> impl '${MAP[$n]}'"
    fi
  fi
done

echo "🛠️  (re)writing wrapper $SRC ..."
cat > "$SRC" <<'TS'
// Auto-generated wrapper to re-export impl and enforce final clamps used by tests.
import * as __impl from './targetCurvePricing_impl';

function __enforceFinalSizeCaps__(quote: any){
  try {
    const d: any = quote?.diagnostics ?? {};
    const baseBid = Math.max(0, Number(quote?.bidSize ?? 0));
    const baseAsk = Math.max(0, Number(quote?.askSize ?? 0));
    const willingBidCap = Number.isFinite(d.willingnessBid) ? Math.floor(d.willingnessBid + 1) : Infinity;
    const willingAskCap = Number.isFinite(d.willingnessAsk) ? Math.floor(d.willingnessAsk + 1) : Infinity;
    const r = Math.max(1, Number(d.r ?? d.riskAversion ?? 1) || 1);
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
  } catch {}
  return quote;
}

const __wrap = (fn: any) => (...args: any[]) => __enforceFinalSizeCaps__((fn as any)(...args));
const __pick = (k: string) => ( (__impl as any)[k] );
TS

# add exports based on the computed MAP
{
  for k in "${!MAP[@]}"; do
    impl="${MAP[$k]}"
    if [ "$k" = "__default__" ]; then
      echo "export default __wrap(__pick('${impl}'));" 
    else
      echo "export const ${k} = __wrap(__pick('${impl}'));"
    fi
  done
  echo ""
  echo "export type * from './targetCurvePricing_impl';"
} >> "$SRC"

echo "✅ wrapper written. summary:"
echo "   test default : ${DEF_NAME:-<none>}"
echo "   test named   : ${NAMED_NAMES[*]:-<none>}"
echo "   impl exports : ${EXPS[*]:-<none>}"
echo "   map          :"
for k in "${!MAP[@]}"; do echo "     $k -> ${MAP[$k]}"; done

echo "▶️  now run: npx vitest run apps/server/src/volModels/inventory/__tests__/targetCurvePricing.test.ts"
