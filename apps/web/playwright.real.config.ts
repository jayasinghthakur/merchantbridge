import { defineConfig, devices } from '@playwright/test';

/**
 * Real-stack E2E: no page.route() mocks, no webServer. The specs drive a running web app that talks to a running
 * apps/api, exactly as a reviewer's browser would.
 *
 * Local (memory mode, no secrets, so the playground and /connect are disabled):
 *   pnpm --filter @mb/api start                                    # API on :8787
 *   NEXT_PUBLIC_API_URL=http://localhost:8787 pnpm --filter @mb/web build && pnpm --filter @mb/web start   # :3000
 *   pnpm --filter @mb/web exec playwright test -c playwright.real.config.ts
 * CI runs exactly this in the `e2e` job of .github/workflows/ci.yml and uploads e2e-real/screenshots/ and the HTML
 * report as artifacts. 7 behavioural tests (pages.spec.ts, tools.spec.ts) + 28 screenshot checks (7 pages x 390/1440
 * px x light/dark, each audited for horizontal overflow and WCAG AA contrast).
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
  // CI also writes an HTML report (uploaded as an artifact by the e2e job in .github/workflows/ci.yml).
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/real' }]]
    : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results/real',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
