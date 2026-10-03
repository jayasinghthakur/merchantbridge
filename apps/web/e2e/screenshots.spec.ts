import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disputeEvents, mockApi } from './mock-api';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

/**
 * page.route() can only fulfill a body all at once, so for a mid-trace capture the playground fetch is replaced
 * in the page with a stream that sends the first frames and then stays open.
 */
async function holdPlaygroundStreamOpen(page: Page) {
  const frames = disputeEvents()
    .slice(0, 5)
    .map((e) => `data: ${JSON.stringify(e)}\n\n`);
  await page.addInitScript((chunks: string[]) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/__mockapi/api/playground')) return realFetch(input, init);
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      );
    };
  }, frames);
}

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`screenshots ${vp.name} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });

      async function shot(page: Page, name: string) {
        // The Next dev indicator is dev-only chrome; keep it out of review screenshots.
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: path.join(OUT, `${name}-${vp.name}-${scheme}.png`),
          fullPage: true,
        });
      }

      async function noHorizontalOverflow(page: Page) {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      }

      test('home', async ({ page }) => {
        await mockApi(page);
        await page.goto('/');
        await expect(page.getByTestId('mcp-demo-command')).toContainText('api.merchantbridge.test');
        await noHorizontalOverflow(page);
        await shot(page, 'home');
      });

      test('playground mid-trace', async ({ page }) => {
        await mockApi(page);
        await holdPlaygroundStreamOpen(page);
        await page.goto('/playground');
        await page.locator('[data-scenario="dispute-evidence"]').click();
        await expect(page.getByTestId('tool-step')).toHaveCount(2);
        await expect(page.getByTestId('tool-step').nth(1)).toContainText('running');
        await noHorizontalOverflow(page);
        await shot(page, 'playground');
      });

      test('tools', async ({ page }) => {
        await mockApi(page);
        await page.goto('/tools');
        if (vp.width >= 768) await page.getByRole('button', { name: /Get item/ }).click();
        else await page.getByLabel('Tool', { exact: true }).selectOption('zoho_get_item');
        await page.getByLabel(/^sku/).fill('CHAI-250');
        await page.getByRole('button', { name: 'Run zoho_get_item' }).click();
        await expect(page.getByTestId('rpc-response')).toBeVisible();
        await noHorizontalOverflow(page);
        await shot(page, 'tools');
      });

      test('docs', async ({ page }) => {
        await mockApi(page);
        await page.goto('/docs');
        await expect(page.getByTestId('docs-tool-table')).toBeVisible();
        await noHorizontalOverflow(page);
        await shot(page, 'docs');
      });
    });
  }
}
