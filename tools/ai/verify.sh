#!/usr/bin/env bash
set -euo pipefail
echo "[verify] Node: $(node -v)"
echo "[verify] PWD: $(pwd)"
./node_modules/.bin/ts-node --transpile-only --compiler-options '{"module":"commonjs"}' tools/ai/verify.ts
