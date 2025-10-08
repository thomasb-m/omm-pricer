#!/usr/bin/env bash
set -euo pipefail

# Find repo root
if git rev-parse --git-dir > /dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
else
  echo "❌ Not inside a git repository"
  exit 1
fi

cd "$REPO_ROOT"

OUT="${OUT:-context-pack.txt}"

echo "📦 Repository context pack"
echo "📂 Files tracked by git:"

# Build file list (macOS compatible)
FILE_LIST=()
while IFS= read -r line; do
  FILE_LIST+=("$line")
done < <(git ls-files 'src/**/*.ts' 'apps/**/*.ts' '*.ts' '*.json' '*.yaml' '*.yml' 2>/dev/null | grep -v node_modules)

echo "✅ Tracked ${#FILE_LIST[@]} files"

if [ "${LIST_ONLY:-0}" = "1" ]; then
  printf "📄 LIST:\n"
  printf "%s\n" "${FILE_LIST[@]}"
  exit 0
fi

# Build context pack
{
  echo "# Repository: $(basename "$REPO_ROOT")"
  echo "# Generated: $(date)"
  echo ""
  
  for f in "${FILE_LIST[@]}"; do
    echo "=== $f ==="
    cat "$f"
    echo ""
  done
} > "$OUT"

echo "✅ Context pack written to: $OUT"
