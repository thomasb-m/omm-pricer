import { defineConfig } from 'vitest/config';

export default defineConfig({
  // prevent Vite from scanning for a root postcss.config.js
  css: { postcss: {} },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
