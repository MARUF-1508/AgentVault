import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit/integration tests only; e2e/ belongs to Playwright.
    include: ['test/**/*.test.ts'],
  },
});
