#!/bin/bash
# Backtest Testing Script (portable macOS zsh + Linux bash)
# Usage:
#   ./run-backtest.sh [strategy] [symbol] [minutes]
# Examples:
#   ./run-backtest.sh
#   ./run-backtest.sh inventory BTC 10

set -euo pipefail

# -------- Config / Args --------
SERVER_URL="${SERVER_URL:-http://localhost:3001}"
STRATEGY="${1:-passive}"          # passive | inventory
SYMBOL="${2:-BTC}"
MINUTES="${3:-10}"                # window if we have to fall back

# -------- Helpers --------
need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ Missing dependency: $1"; exit 1; }; }
ms_now() { echo $(( $(date +%s) * 1000 )); }  # portable ms epoch (mac & linux)

say() { echo -e "$*"; }
hr() { printf '%*s\n' "$(tput cols 2>/dev/null || echo 80)" '' | tr ' ' '-'; }

# -------- Checks --------
need curl
need jq
need bc

say "=== Options Market Maker Backtest ==="
say ""
say "Server: $SERVER_URL"
say "Symbol: $SYMBOL"
say "Strategy: $STRATEGY"
say ""

# 1) Health
say "1) Checking server health…"
HEALTH="$(curl -s "${SERVER_URL}/health" || true)"
if [ -z "$HEALTH" ] || [ "$(echo "$HEALTH" | jq -r '.ok // empty')" != "true" ]; then
  echo "❌ Server is not running or not responding at ${SERVER_URL}/health"
  exit 1
fi
say "✓ Server healthy"
say ""

# 2) Snapshots list
say "2) Checking available snapshots…"
SNAPSHOTS="$(curl -s "${SERVER_URL}/snapshots/list?symbol=${SYMBOL}&limit=200" || true)"
COUNT="$(echo "$SNAPSHOTS" | jq 'length' 2>/dev/null || echo 0)"
say "Found ${COUNT} snapshots"

USE_SNAPSHOT_RANGE=1
if [ "$COUNT" -lt 2 ]; then
  say "⚠️  Not enough snapshots. Will fall back to last ${MINUTES} minutes."
  USE_SNAPSHOT_RANGE=0
fi

# 3) Determine time range
if [ "$USE_SNAPSHOT_RANGE" -eq 1 ]; then
  FIRST_TS="$(echo "$SNAPSHOTS" | jq -r '.[-1].timestamp')"
  LAST_TS="$(echo "$SNAPSHOTS" | jq -r '.[0].timestamp')"
else
  LAST_TS="$(ms_now)"
  FIRST_TS="$(( LAST_TS - MINUTES*60*1000 ))"
fi

# Pretty print times (macOS-compatible)
fmt_ts() { date -r "$(( $1 / 1000 ))" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d @"$(( $1 / 1000 ))" '+%Y-%m-%d %H:%M:%S'; }

say "Time range:"
say "  Start: $(fmt_ts "$FIRST_TS")"
say "  End:   $(fmt_ts "$LAST_TS")"
say ""

# 4) Latest snapshot quality (only if exists)
if [ "$USE_SNAPSHOT_RANGE" -eq 1 ]; then
  say "3) Latest snapshot (debug)…"
  curl -s "${SERVER_URL}/debug/snapshot-latest" | jq .
  say ""
fi

# 5) Passive backtest (always run for comparison)
say "4) Running Passive Market Making backtest…"
PASSIVE_RES="$(curl -s -X POST "${SERVER_URL}/backtest/run" \
  -H "Content-Type: application/json" \
  -d "{\"strategy\":\"passive\",\"symbol\":\"${SYMBOL}\",\"startTime\":${FIRST_TS},\"endTime\":${LAST_TS}}" )"

# Check for API error
if [ "$(echo "$PASSIVE_RES" | jq -r '.error // empty')" != "" ]; then
  echo "❌ Backtest error: $(echo "$PASSIVE_RES" | jq -r '.error')"
  echo "$PASSIVE_RES" | jq .
  exit 1
fi

echo "$PASSIVE_RES" | jq .
say ""

# Extract passive stats
P_TRADES="$(echo "$PASSIVE_RES" | jq -r '.stats.trades | length')"
P_TOTAL_EDGE="$(echo "$PASSIVE_RES" | jq -r '.stats.totalEdge')"
P_AVG_EDGE="$(echo "$PASSIVE_RES" | jq -r '.stats.avgEdge')"
P_WIN_RATE="$(echo "$PASSIVE_RES" | jq -r '.stats.winRate')"

# 6) Inventory-aware backtest
say "5) Running Inventory-Aware MM backtest…"
INV_RES="$(curl -s -X POST "${SERVER_URL}/backtest/run" \
  -H "Content-Type: application/json" \
  -d "{\"strategy\":\"inventory\",\"symbol\":\"${SYMBOL}\",\"startTime\":${FIRST_TS},\"endTime\":${LAST_TS}}" )"

if [ "$(echo "$INV_RES" | jq -r '.error // empty')" != "" ]; then
  echo "❌ Backtest error: $(echo "$INV_RES" | jq -r '.error')"
  echo "$INV_RES" | jq .
  exit 1
fi

echo "$INV_RES" | jq .
say ""

# Extract inventory stats
I_TRADES="$(echo "$INV_RES" | jq -r '.stats.trades | length')"
I_TOTAL_EDGE="$(echo "$INV_RES" | jq -r '.stats.totalEdge')"
I_AVG_EDGE="$(echo "$INV_RES" | jq -r '.stats.avgEdge')"
I_WIN_RATE="$(echo "$INV_RES" | jq -r '.stats.winRate')"

# 7) Optional single-strategy run (if user asked)
if [ "$STRATEGY" != "passive" ] && [ "$STRATEGY" != "inventory" ]; then
  say "⚠️ Unknown strategy '$STRATEGY'. Showing both standard strategies."
fi

# 8) Summaries
hr
say "Results Summary — Passive Market Making"
say "Trades executed:  ${P_TRADES}"
say "Total edge:       \$${P_TOTAL_EDGE}"
say "Avg edge/contract:\$${P_AVG_EDGE}"
printf "Win rate:         %.1f%%\n" "$(echo "$P_WIN_RATE * 100" | bc -l)"
say ""

hr
say "Results Summary — Inventory-Aware MM"
say "Trades executed:  ${I_TRADES}"
say "Total edge:       \$${I_TOTAL_EDGE}"
say "Avg edge/contract:\$${I_AVG_EDGE}"
printf "Win rate:         %.1f%%\n" "$(echo "$I_WIN_RATE * 100" | bc -l)"
say ""

# 9) Comparison
hr
printf "%-20s | %12s | %16s\n" "" "Passive" "Inventory-Aware"
printf "%-20s-+-%12s-+-%16s\n" "$(printf '%.0s-' {1..20})" "$(printf '%.0s-' {1..12})" "$(printf '%.0s-' {1..16})"
printf "%-20s | %12s | %16s\n" "Trades"        "${P_TRADES}"      "${I_TRADES}"
printf "%-20s | %12s | %16s\n" "Total Edge"    "\$${P_TOTAL_EDGE}" "\$${I_TOTAL_EDGE}"
printf "%-20s | %12s | %16s\n" "Avg/Contract"  "\$${P_AVG_EDGE}"   "\$${I_AVG_EDGE}"
printf "%-20s | %11.1f%% | %15.1f%%\n" "Win Rate" "$(echo "$P_WIN_RATE * 100" | bc -l)" "$(echo "$I_WIN_RATE * 100" | bc -l)"
hr

say "✓ Backtest complete!"
