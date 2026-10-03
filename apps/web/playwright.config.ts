import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, MOCK_API_URL } from './e2e/constants';

/**
 * E2E runs `next dev` with NEXT_PUBLIC_API_URL pointing at a same-origin path that does not exist; every API
 * request is answered by page.route() mocks in the tests, so no apps/api, model or Zoho is involved.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // CI also writes an HTML report (uploaded as an artifact by the e2e job in .github/workflows/ci.yml).
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/mocked' }]]
    : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev --port ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NEXT_PUBLIC_API_URL: MOCK_API_URL, NEXT_TELEMETRY_DISABLED: '1' },
  },
});
