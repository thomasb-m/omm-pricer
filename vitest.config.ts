import { defineConfig } from 'vitest/config';
import path from 'node:path';
import fs from 'node:fs';

const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');

function loadAliases() {
  try {
    const ts = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    const paths = ts?.compilerOptions?.paths ?? {};
    return Object.entries(paths).map(([key, value]) => {
      const find = key.replace(/\/\*$/, '');
      const first = Array.isArray(value) ? value[0] : value;
      const target = first.replace(/\/\*$/, '');
      return { find, replacement: path.resolve(process.cwd(), target) };
    });
  } catch {
    return [];
  }
}

export default defineConfig({
  css: { postcss: {} },
  resolve: { alias: loadAliases() },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'packages/**/tests/**/*.{test,spec}.ts',
      'apps/**/?(src|tests)/**/*.{test,spec}.{ts,js}'
    ],
    exclude: ['.tmp/**','dist/**','node_modules/**'],
  },
});
