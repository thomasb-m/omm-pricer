#!/usr/bin/env bash
set -euo pipefail

# Optional: pass repo path as first arg (defaults to current dir)
REPO_ROOT="${1:-.}"

cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null || {
  echo "❌ Not inside a git repo: $REPO_ROOT"; exit 1;
}

# Create or reuse a feature branch name (you can override via env BRANCH_NAME=...)
BRANCH="${BRANCH_NAME:-fix/vol-core-black76-target-curve-$(date +%Y%m%d-%H%M%S)}"

# Show what we expect to have changed (purely informational)
echo "ℹ️  Staging all changes (including new files & lockfiles)..."
git status --porcelain=v1 || true

# Create/switch branch
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH"
fi

# Stage and commit
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  No staged changes; skipping commit."
else
  git commit -m "Fix: robust Black-76 (no Math.erf); add vol-core units; wrap targetCurvePricing with final size clamps; stabilize Vitest config"
fi

# Ensure we have a remote named origin
if git remote get-url origin >/dev/null 2>&1; then
  REMOTE_URL="$(git remote get-url origin)"
  echo "🔗 Using remote 'origin': $REMOTE_URL"
else
  echo "❌ No remote named 'origin'. Add one and rerun:"
  echo "   git remote add origin <your-remote-url>"
  exit 1
fi

# Push and set upstream
git push -u origin "$BRANCH"

echo "✅ Pushed branch: $BRANCH"
echo
echo "📥 On your laptop:"
echo "   git fetch origin"
echo "   git checkout -b $BRANCH --track origin/$BRANCH"
echo "   # or merge to main:"
echo "   # git checkout main && git merge --no-ff $BRANCH"
