#!/usr/bin/env bash
set -euo pipefail

echo "🐍 Generating aggregated TS fixtures from Python outputs..."

PY_AGG="vol-core-validation/aggregate_results_to_ts.py"

if [ ! -f "$PY_AGG" ]; then
  echo "ERROR: $PY_AGG not found."
  exit 1
fi

python "$PY_AGG"

echo "✅ Wrote vol-core-validation/output/cc_fixtures.json"
