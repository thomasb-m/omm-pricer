import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@vol-core': path.resolve(__dirname, 'packages/vol-core/src'),
      '@vol-validation': path.resolve(__dirname, 'packages/vol-validation/src'),
      '@core-types': path.resolve(__dirname, 'packages/core-types/src'),
      'risk-core': path.resolve(__dirname, 'packages/risk-core/src'),
      'pc-fit': path.resolve(__dirname, 'packages/pc-fit/src'),
    }
  },
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.tmp/**',
      '**/verify/**'
    ]
  },
});
