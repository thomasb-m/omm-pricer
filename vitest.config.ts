import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      '@core-types': path.resolve(__dirname, './packages/core-types/src/index.ts'),
      '@vol-core': path.resolve(__dirname, './packages/vol-core/src'),
      '@vol-validation': path.resolve(__dirname, './packages/vol-validation/src'),
    },
  },
});
