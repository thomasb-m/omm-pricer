#!/usr/bin/env bash
set -euo pipefail

TMP="$(mktemp -t appundo).mjs"
cat > "$TMP" <<'JS'
import fs from 'fs';
import path from 'path';

const exts = ['.ts', '.tsx', '.mts', '.cts'];
const idxs = exts.map(e => path.join('index' + e));

function hasTsTarget(specBare, basedir) {
  const abs = path.resolve(basedir, specBare);
  for (const e of exts) if (fs.existsSync(abs + e)) return true;
  for (const i of idxs) if (fs.existsSync(path.join(abs, i))) return true;
  return false;
}

function processFile(f) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;
  const dir = path.dirname(f);

  // static: import ... from '...js'
  src = src.replace(/(from\s+['"])(\.{1,2}\/[^'"]+?)(\.js)(['"])/g, (m, pre, base, ext, post) =>
    hasTsTarget(base, dir) ? pre + base + post : m
  );

  // side-effect import: import '...js'
  src = src.replace(/(^\s*import\s+['"])(\.{1,2}\/[^'"]+?)(\.js)(['"])/gm, (m, pre, base, ext, post) =>
    hasTsTarget(base, dir) ? pre + base + post : m
  );

  // re-exports: export ... from '...js'
  src = src.replace(/(^\s*export\s+(?:\*|{)[^;]*?\sfrom\s+['"])(\.{1,2}\/[^'"]+?)(\.js)(['"])/gm, (m, pre, base, ext, post) =>
    hasTsTarget(base, dir) ? pre + base + post : m
  );

  // dynamic import('...js')
  src = src.replace(/(import\s*\(\s*['"])(\.{1,2}\/[^'"]+?)(\.js)(['"]\s*\))/g, (m, pre, base, ext, post) =>
    hasTsTarget(base, dir) ? pre + base + post : m
  );

  if (src !== before) {
    fs.writeFileSync(f, src);
    console.log('reverted(app)', path.relative(process.cwd(), f));
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(p);
    } else if (/\.(mts|cts|ts|tsx)$/.test(entry.name)) {
      processFile(p);
    }
  }
}
walk('apps');
JS

node "$TMP"
rm -f "$TMP"
echo "✅ reverted .js specifiers in apps/* where TS source exists"
