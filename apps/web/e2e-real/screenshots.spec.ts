import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROUTES } from '@mb/core/http';
import type { Page } from '@playwright/test';
import { auditLayout } from './audit';
import { expect, gotoObservingStatus, gotoObservingTools, test } from './fixtures';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

interface PageCase {
  name: string;
  /** Navigates and waits until the page shows its real, API-driven state. */
  open(page: Page, wide: boolean): Promise<void>;
}

const PAGES: PageCase[] = [
  {
    name: 'home',
    async open(page) {
      await gotoObservingStatus(page, '/');
      await expect(page.getByTestId('home-tool-count')).toHaveAttribute('data-source', 'live');
    },
  },
  {
    name: 'playground',
    async open(page) {
      const { body } = await gotoObservingStatus(page, '/playground');
      if (!body.playground_enabled) await expect(page.getByTestId('playground-off')).toBeVisible();
      else await expect(page.getByTestId('scenario-card').first()).toBeEnabled();
    },
  },
  {
    name: 'tools',
    async open(page, wide) {
      await gotoObservingTools(page, '/tools');
      if (wide)
        await page
          .getByTestId('tool-list')
          .getByRole('button', { name: /zoho_get_item/ })
          .click();
      else await page.getByLabel('Tool', { exact: true }).selectOption('zoho_get_item');
      await page.getByLabel(/^sku/).fill('CHAI-250');
      const done = page.waitForResponse((r) =>
        new URL(r.url()).pathname.endsWith(API_ROUTES.explorerCall),
      );
      await page.getByRole('button', { name: 'Run zoho_get_item' }).click();
      expect((await done).status()).toBe(200);
      await expect(page.getByTestId('rpc-response')).toContainText('CHAI-250');
    },
  },
  {
    name: 'docs',
    async open(page) {
      const tools = page.waitForResponse((r) =>
        new URL(r.url()).pathname.endsWith(API_ROUTES.tools),
      );
      await gotoObservingStatus(page, '/docs');
      expect((await tools).status()).toBe(200);
      await expect(page.getByTestId('docs-tool-table')).toBeVisible();
      await expect(page.getByTestId('docs-tool-source')).toContainText('live');
    },
  },
  {
    name: 'connect',
    async open(page) {
      const { body } = await gotoObservingStatus(page, '/connect');
      if (!body.connect_enabled) await expect(page.getByTestId('connect-disabled')).toBeVisible();
      else await expect(page.getByRole('button', { name: 'Continue to Zoho' })).toBeEnabled();
    },
  },
  {
    name: 'connect-error',
    async open(page) {
      await page.goto('/connect/error?reason=invalid_invite');
      await expect(page.getByTestId('connect-error')).toBeVisible();
    },
  },
  {
    name: 'connect-success-empty',
    async open(page) {
      await page.goto('/connect/success');
      await expect(page.getByText('There is no key to show')).toBeVisible();
    },
  },
];

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`real stack ${vp.name}px ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });

      for (const pc of PAGES) {
        test(pc.name, async ({ page }) => {
          await pc.open(page, vp.width >= 768);
          await page.evaluate(async () => {
            await document.fonts.ready;
            window.scrollTo(0, 0);
          });
          const file = path.join(OUT, `${pc.name}-${vp.name}-${scheme}.png`);
          await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });

          const audit = await auditLayout(page);
          expect.soft(audit.pageOverflowPx, 'page scrolls horizontally').toBeLessThanOrEqual(0);
          expect.soft(audit.overflowing, 'elements outside the viewport').toEqual([]);
          expect.soft(audit.lowContrast, 'text below WCAG AA contrast').toEqual([]);
        });
      }
    });
  }
}
