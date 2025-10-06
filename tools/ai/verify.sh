#!/usr/bin/env bash
set -euo pipefail
echo "[verify] Node: $(node -v)"
echo "[verify] PWD: $(pwd)"

# Run the TypeScript sanity checks without jest
./node_modules/.bin/ts-node --compiler-options '{"module":"commonjs"}' tools/ai/verify.ts
