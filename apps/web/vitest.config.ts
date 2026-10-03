import { defineConfig } from 'vitest/config';

// Unit tests only; Playwright owns e2e/*.spec.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
