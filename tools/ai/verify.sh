#!/usr/bin/env bash
set -euo pipefail
echo "[ai] Node:"; node -v || true

run_if_present () {
  local CMD="$1"
  echo ""; echo "▶ $CMD"
  if npm run | grep -qE "^  $CMD$"; then npm run -s "$CMD"
  elif command -v pnpm >/dev/null 2>&1 && pnpm -s run | grep -qE "^  $CMD$"; then pnpm -s "$CMD"
  else echo "(no $CMD script defined)"; fi
}

if [ -f pnpm-lock.yaml ]; then
  command -v pnpm >/dev/null 2>&1 || { command -v corepack >/dev/null 2>&1 && corepack enable && corepack prepare pnpm@latest --activate || true; }
  pnpm install --frozen-lockfile || pnpm install
elif [ -f package-lock.json ] || [ -f package.json ]; then
  npm ci || npm install
else
  echo "[ai] No package.json at repo root; skipping install."
fi

run_if_present typecheck
run_if_present lint
run_if_present test
run_if_present build
echo ""; echo "[ai] Done."
