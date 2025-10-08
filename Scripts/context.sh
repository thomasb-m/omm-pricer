#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------
# context.sh — repo-aware context packer
# ---------------------------------------------
# Options:
#   OUT=somefile.txt        # override pack filename
#   LIST_ONLY=1             # only write the file list, skip contents
#   MAX_FILE_BYTES=200000   # per-file cap (default 200k)
# ---------------------------------------------

# 0) Locate repo root
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
else
  echo "⚠️  Not in a Git repo; using current directory."
  REPO_ROOT="$(pwd)"
fi
cd "$REPO_ROOT"

OUT="${OUT:-context-pack.txt}"
LIST_OUT="context-files.txt"
MAX_FILE_BYTES="${MAX_FILE_BYTES:-200000}"
LIST_ONLY="${LIST_ONLY:-0}"

echo "📁 Repo root: $REPO_ROOT"
echo "📝 File list: $LIST_OUT"
echo "📦 Context pack: $OUT (LIST_ONLY=$LIST_ONLY, MAX_FILE_BYTES=$MAX_FILE_BYTES)"

# 1) Produce a clean list of tracked files
git ls-files > "$LIST_OUT"
echo "✅ Tracked file list written to $LIST_OUT ( $(wc -l < "$LIST_OUT") files )"

if [ "$LIST_ONLY" = "1" ]; then
  echo "ℹ️  LIST_ONLY=1: skipping content pack."
  exit 0
fi

# 2) Build source files list (macOS compatible - no mapfile)
SRC_FILES=()
while IFS= read -r line; do
  SRC_FILES+=("$line")
done < <(git ls-files \
  'src/**/*.[jt]s' 'src/**/*.[jt]sx' \
  'apps/**/src/**/*.[jt]s' 'apps/**/src/**/*.[jt]sx' \
  ':!:**/node_modules/**' ':!:**/.git/**' ':!:**/dist/**' ':!:**/build/**' ':!:**/.next/**' ':!:**/.turbo/**' \
  2>/dev/null || true)

# Fallback if no matches
if [ "${#SRC_FILES[@]}" -eq 0 ]; then
  while IFS= read -r line; do
    SRC_FILES+=("$line")
  done < <(git ls-files '*.[jt]s' '*.[jt]sx' \
    ':!:**/node_modules/**' ':!:**/.git/**' ':!:**/dist/**' ':!:**/build/**' ':!:**/.next/**' ':!:**/.turbo/**' \
    2>/dev/null || true)
fi

# 3) Write the pack
: > "$OUT"
{
  echo "===== OMM PRICER CONTEXT PACK ====="
  echo "Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "Repo root: $REPO_ROOT"
  echo "Total tracked files: $(wc -l < "$LIST_OUT")"
  echo ""
  echo "Included source files (${#SRC_FILES[@]}):"
} >> "$OUT"

for f in "${SRC_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "⚠️  WARNING: $f not found" >&2
    continue
  fi
  size=$(wc -c < "$f" | tr -d ' ')
  echo " - $f (${size} bytes)" >> "$OUT"
done

{
  echo ""
  echo "===== BEGIN FILE CONTENTS ====="
} >> "$OUT"

for f in "${SRC_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi
  size=$(wc -c < "$f" | tr -d ' ')
  echo "" >> "$OUT"
  echo "---------- BEGIN $f (bytes=$size) ----------" >> "$OUT"
  if [ "$size" -le "$MAX_FILE_BYTES" ]; then
    sed -n "1,999999p" "$f" >> "$OUT"
  else
    echo "[truncated to ${MAX_FILE_BYTES} bytes]" >> "$OUT"
    head -c "$MAX_FILE_BYTES" "$f" >> "$OUT"
  fi
  echo "" >> "$OUT"
  echo "---------- END $f ----------" >> "$OUT"
done

echo "✅ Context pack written to $OUT"
