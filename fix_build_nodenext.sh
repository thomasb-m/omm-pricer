#!/usr/bin/env bash
set -euo pipefail

TMPDIR="$(mktemp -d -t tsfix)"
PATCH="$TMPDIR/patch.mjs"
PKG_CODEMOD="$TMPDIR/pkg_codemod.mjs"
APP_UNDO="$TMPDIR/app_undo.mjs"

# --- tsconfig patcher: NodeNext for packages, Bundler for apps with Vite ---
cat > "$PATCH" <<'JS'
import fs from 'fs';
import path from 'path';

function parseJsonc(t){
  const noBom=t.replace(/^\uFEFF/,'');
  const noBlock=noBom.replace(/\/\*[\s\S]*?\*\//g,'');
  const noLine=noBlock.replace(/(^|[^:])\/\/.*$/gm,'$1');
  const noTrail=noLine.replace(/,\s*([}\]])/g,'$1');
  return JSON.parse(noTrail);
}

const file=process.argv[2], kind=process.argv[3]; // "pkg" | "app"
if(!file||!fs.existsSync(file)) process.exit(0);
const raw=fs.readFileSync(file,'utf8');
let json;
try{ json=JSON.parse(raw); }catch{ json=parseJsonc(raw); }

json.compilerOptions ??= {};
const co=json.compilerOptions;

if(kind==='pkg'){
  co.module='NodeNext';
  co.moduleResolution='NodeNext';
} else {
  // Apps: let Vite/Vitest resolve TS sources
  co.module='ESNext';
  co.moduleResolution='Bundler';
}
co.skipLibCheck = true;
const types=new Set([...(co.types??[])]);
['node','vitest','undici-types'].forEach(t=>types.add(t));
co.types=[...types];

fs.writeFileSync(file, JSON.stringify(json,null,2)+'\n');
console.log('patched', kind, path.relative(process.cwd(),file));
JS

# --- packages: add .js (or /index.js) to relative imports/exports ---
cat > "$PKG_CODEMOD" <<'JS'
import fs from 'fs';
import path from 'path';
const file=process.argv[2];
if(!file||!fs.existsSync(file)) process.exit(0);
const dir=path.dirname(file);
let src=fs.readFileSync(file,'utf8'), changed=false;

const pats=[
  /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
  /(^\s*import\s+['"])(\.{1,2}\/[^'"]+)(['"])/gm,
  /(^\s*export\s+(?:\*|{)[^;]*?\sfrom\s+['"])(\.{1,2}\/[^'"]+)(['"])/gm
];

const hasExt=p=>/\.[a-zA-Z0-9]+($|\?)/.test(p);
function toJs(spec, dir){
  const [bare, q='']=spec.split('?');
  const abs=path.resolve(dir, bare);
  try{
    const st=fs.statSync(abs);
    if(st.isDirectory()) return bare.replace(/\/$/,'') + '/index.js' + (q?('?'+q):'');
  }catch{}
  return bare + '.js' + (q?('?'+q):'');
}

for(const rx of pats){
  src=src.replace(rx, (_,pre,spec,post)=>{
    if(!(spec.startsWith('./')||spec.startsWith('../'))) return pre+spec+post;
    if(hasExt(spec)) return pre+spec+post;
    const fixed=toJs(spec,dir); changed ||= fixed!==spec;
    return pre+fixed+post;
  });
}
if(changed){ fs.writeFileSync(file,src); console.log('rewritten(pkg)', path.relative(process.cwd(),file)); }
JS

# --- apps: undo .js suffix when TS source exists (prefer extensionless) ---
cat > "$APP_UNDO" <<'JS'
import fs from 'fs';
import path from 'path';
const file=process.argv[2];
if(!file||!fs.existsSync(file)) process.exit(0);
const dir=path.dirname(file);
let src=fs.readFileSync(file,'utf8'), changed=false;

const pats=[
  /(from\s+['"])(\.{1,2}\/[^'"]+?)(\.js)(['"])/g,
  /(^\s*import\s+['"])(\.{1,2}\/[^'"]+?)(\.js)(['"])/gm,
  /(^\s*export\s+(?:\*|{)[^;]*?\sfrom\s+['"])(\.{1,2}\/[^'"]+?)(\.js)(['"])/gm
];

function candidates(specBare, dir){
  const abs=path.resolve(dir, specBare);
  return [
    abs+'.ts',
    abs+'.tsx',
    path.join(abs,'index.ts'),
    path.join(abs,'index.tsx')
  ];
}

for(const rx of pats){
  src=src.replace(rx, (m,pre,base,ext,post)=>{
    // Try to find TS source to target; if found, drop extension for bundler
    const exists = candidates(base,dir).some(p=>fs.existsSync(p));
    if(exists){ changed=true; return pre+base+post; }
    return m;
  });
}

if(changed){ fs.writeFileSync(file,src); console.log('rewritten(app)', path.relative(process.cwd(),file)); }
JS

# 1) Patch tsconfigs: packages => NodeNext, apps => Bundler (if present)
for f in packages/*/tsconfig.json; do
  [ -f "$f" ] && node "$PATCH" "$f" pkg || true
done
for f in apps/*/tsconfig.json; do
  if [ -f "$f" ]; then
    # treat as app (Bundler), which plays nice with Vite
    node "$PATCH" "$f" app || true
  fi
done
# root tsconfig: leave as NodeNext (libs/refs)
[ -f tsconfig.json ] && node "$PATCH" tsconfig.json pkg || true

# 2) Rewrite imports in packages only
while IFS= read -r -d '' f; do node "$PKG_CODEMOD" "$f"; done \
  < <(find packages -type f \( -name "*.ts" -o -name "*.tsx" \) ! -path "*/node_modules/*" ! -path "*/dist/*" -print0)

# 3) Undo accidental .js imports inside apps (prefer extensionless)
while IFS= read -r -d '' f; do node "$APP_UNDO" "$f"; done \
  < <(find apps -type f \( -name "*.ts" -o -name "*.tsx" \) ! -path "*/node_modules/*" -print0)

rm -rf "$TMPDIR"
echo "✅ packages: ESM specifiers fixed (.js); apps: reverted for Vite"
