// vite.config.js
import { defineConfig } from 'vitest/config';   // ⬅️ switch from 'vite' to 'vitest/config'
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core-types': path.resolve(__dirname, 'packages/core-types/src'),
      '@vol-core':   path.resolve(__dirname, 'packages/vol-core/src'),
    },
  },
  test: {
    // keep vitest from double-running mirrored tests
    exclude: ['**/.tmp/**','node_modules','dist','build','.next','coverage'],
    environment: 'node',
    globals: true,
    include: ['**/*.test.{ts,tsx,js}'],
  },
});
