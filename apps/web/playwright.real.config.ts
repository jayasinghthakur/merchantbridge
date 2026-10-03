import { defineConfig, devices } from '@playwright/test';

/**
 * Real-stack E2E: no page.route() mocks, no webServer. The specs drive a running web app that talks to a running
 * apps/api, exactly as a reviewer's browser would.
 *
 * Local (memory mode, no secrets, so the playground and /connect are disabled):
 *   PORT=8787 pnpm --filter @mb/api start
 *   NEXT_PUBLIC_API_URL=http://localhost:8787 pnpm --filter @mb/web build && pnpm --filter @mb/web start
 *   pnpm --filter @mb/web exec playwright test -c playwright.real.config.ts
 *
 * Production verification: PLAYWRIGHT_BASE_URL=https://<web host> pnpm --filter @mb/web exec playwright test -c
 * playwright.real.config.ts. The API origin is never configured here: specs learn it from the requests the page
 * itself makes, so they always test the API the deployed bundle was built against.
 */
const baseURL = (process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export default defineConfig({
  testDir: './e2e-real',
  testMatch: '**/*.spec.ts',
  // The explorer route allows 30 calls per minute per IP; a small worker pool keeps a full run well inside it.
  workers: 2,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results/real',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
