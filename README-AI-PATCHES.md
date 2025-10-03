# AI Patch Workflow

This repo uses a review-first flow. The AI delivers `.patch` files (unified diffs). You apply them onto a feature branch, review, test, and open a PR.

## Apply a patch
git checkout -B ai/<slug> origin/main
tools/ai/apply_patch.sh /path/to/file.patch

If clean, changes are staged:
git commit -m "AI: <summary>"
git push -u origin ai/<slug>

## Verify locally
tools/ai/verify.sh
