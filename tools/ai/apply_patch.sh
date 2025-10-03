#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "" ]; then
  echo "Usage: tools/ai/apply_patch.sh <path-to-patch>"; exit 1; fi
PATCH_PATH="$1"
[ -f "$PATCH_PATH" ] || { echo "Patch not found: $PATCH_PATH"; exit 1; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[ai] Repo has uncommitted changes. Commit/stash first."; exit 1; fi

BR="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BR" != ai/* ]]; then
  echo "[ai] You are on '$BR'. Recommended: git checkout -B ai/<slug> origin/main"
  read -p "[ai] Continue anyway? [y/N] " yn; [[ "$yn" =~ ^[Yy]$ ]] || exit 1; fi

set +e; git apply --3way --index "$PATCH_PATH"; S=$?; set -e
if [ $S -ne 0 ]; then
  echo "[ai] 3-way failed; trying plain apply..."
  set +e; git apply "$PATCH_PATH"; S2=$?; set -e
  if [ $S2 -ne 0 ]; then
    echo "[ai] Patch failed. Try: git apply --reject --whitespace=fix $PATCH_PATH"; exit 1; fi
  echo "[ai] Applied without staging. Resolve conflicts if any, then:"
  echo "     git add -A && git commit -m \"AI: <summary>\""
else
  echo "[ai] Patch applied and staged. Next:"
  echo "     git commit -m \"AI: <summary>\" && git push -u origin $(git rev-parse --abbrev-ref HEAD)"
fi
