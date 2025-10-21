#!/usr/bin/env bash
set -euo pipefail
name="${1:?Usage: tools/ai/newpatch_skeleton.sh <patch-name>}"
path="tools/ai/patches/${name}.sh"
if [ -e "$path" ]; then
  echo "Patch already exists: $path" >&2
  exit 1
fi
cat > "$path" <<'TEMPLATE'
#!/usr/bin/env bash
set -euo pipefail
# COMMIT: <short commit message>

# --- overwrite files below (copy the whole file content into heredocs) ---

# cat > apps/server/src/some/file.ts <<'TS'
# // full file content…
# TS

# git add apps/server/src/some/file.ts
TEMPLATE
chmod +x "$path"
echo "Patch skeleton created at: $path"
echo "Edit it, then run: bash tools/ai/applypatch.sh $(basename "$path" .sh)"
