import { defineConfig } from 'vitest/config';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(__dirname, '../..');
const tsconfigPath = path.join(root, 'tsconfig.json');

function loadAliases() {
  try {
    const ts = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    const paths = ts?.compilerOptions?.paths ?? {};
    const entries = Object.entries(paths);
    return entries.map(([key, value]) => {
      // key like "@vol-core/*" -> "@vol-core"
      const find = key.replace(/\/\*$/, '');
      const first = Array.isArray(value) ? value[0] : value;
      // value like "packages/vol-core/src/*" -> ".../packages/vol-core/src"
      const target = first.replace(/\/\*$/, '');
      return {
        find,
        replacement: path.resolve(root, target),
      };
    });
  } catch (e) {
    console.warn('Could not load tsconfig paths for Vitest aliases:', e);
    return [];
  }
}

export default defineConfig({
  resolve: {
    alias: loadAliases(),
  },
  // keep Tailwind/PostCSS out of server unit tests
  css: { postcss: {} },
  test: {
    environment: 'node',
    include: ['apps/server/tests/**/*.test.ts'],
  },
});
