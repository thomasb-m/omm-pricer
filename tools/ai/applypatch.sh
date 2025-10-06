#!/usr/bin/env bash
set -euo pipefail
usage(){ echo "Usage: $0 <patch-name> [--no-commit]"; }
[ $# -ge 1 ] || { usage; exit 1; }
NAME="$1"; shift || true
NO_COMMIT=0; [ "${1-}" = "--no-commit" ] && NO_COMMIT=1

PATCH_DIR="tools/ai/patches"
PATCH_SH="$PATCH_DIR/$NAME.sh"
PATCH_DIFF="$PATCH_DIR/$NAME.patch"

[ -f "$PATCH_SH" ] || [ -f "$PATCH_DIFF" ] || { echo "No patch: $PATCH_SH or $PATCH_DIFF"; exit 1; }

PREV_HEAD="$(git rev-parse --short HEAD)"

if [ -f "$PATCH_DIFF" ]; then
  echo "[applypatch] git apply $PATCH_DIFF"
  git apply --3way --whitespace=fix "$PATCH_DIFF" || git apply --whitespace=fix "$PATCH_DIFF"
fi
if [ -f "$PATCH_SH" ]; then
  echo "[applypatch] bash $PATCH_SH"
  bash "$PATCH_SH"
fi

# if patch script already committed, stop
if [ "$(git rev-parse --short HEAD)" != "$PREV_HEAD" ]; then
  git --no-pager log -1 --oneline
  exit 0
fi

if [ "$NO_COMMIT" -eq 0 ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    git add -A
    COMMIT_MSG="applypatch: $NAME"
    if [ -f "$PATCH_SH" ]; then
      CM=$(grep -m1 '^COMMIT_MSG=' "$PATCH_SH" | sed -E "s/^COMMIT_MSG=['\"]?(.*)['\"]?/\1/")
      [ -n "${CM:-}" ] && COMMIT_MSG="$CM"
      CM2=$(grep -m1 '^# COMMIT:' "$PATCH_SH" | sed -E 's/^# COMMIT:\s*//')
      [ -n "${CM2:-}" ] && COMMIT_MSG="$CM2"
    fi
    git commit -m "$COMMIT_MSG"
    echo "[applypatch] committed: $COMMIT_MSG"
  else
    echo "[applypatch] no changes to commit"
  fi
else
  echo "[applypatch] --no-commit; leaving changes staged"
fi
