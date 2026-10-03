import type { ExplorerCallRequest, ExplorerCallResponse } from '@mb/core/http';
import { API_ROUTES } from '@mb/core/http';
import type { Page } from '@playwright/test';
import { expect, gotoObservingTools, test } from './fixtures';

const SKU = 'CHAI-250';

/** Fills zoho_get_item, clicks Run and returns the real explorer exchange the page received. */
async function runGetItem(
  page: Page,
): Promise<{ sent: ExplorerCallRequest; got: ExplorerCallResponse }> {
  await page
    .getByTestId('tool-list')
    .getByRole('button', { name: /zoho_get_item/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Get item', level: 2 })).toBeVisible();
  await page.getByLabel(/^sku/).fill(SKU);
  const pending = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname.endsWith(API_ROUTES.explorerCall),
  );
  await page.getByRole('button', { name: 'Run zoho_get_item' }).click();
  const res = await pending;
  expect(res.status()).toBe(200);
  return {
    sent: res.request().postDataJSON() as ExplorerCallRequest,
    got: (await res.json()) as ExplorerCallResponse,
  };
}

test('tools lists every tool the real API returns', async ({ page }) => {
  const { body } = await gotoObservingTools(page, '/tools');
  expect(body.tools.length).toBeGreaterThan(0);
  expect(body.tools.map((t) => t.name)).toContain('zoho_get_item');

  const list = page.getByTestId('tool-list');
  await expect(list.getByRole('button')).toHaveCount(body.tools.length);
  for (const t of body.tools) {
    await expect(list.getByRole('button', { name: new RegExp(`${t.name}$`) })).toContainText(
      t.title,
    );
  }
  await expect(
    page.getByText(`${body.server.name} v${body.server.version} · ${body.tools.length} tools`),
  ).toBeVisible();
  // The first tool is selected and its real schema-driven form is rendered.
  const first = body.tools[0];
  if (first) await expect(page.getByRole('button', { name: `Run ${first.name}` })).toBeVisible();
});

test('runs zoho_get_item for CHAI-250 and shows the raw JSON-RPC response and decisions', async ({
  page,
}) => {
  await gotoObservingTools(page, '/tools');
  const { sent, got } = await runGetItem(page);

  expect(sent).toMatchObject({ tool: 'zoho_get_item', args: { sku: SKU }, faults: [] });
  expect(got.decisions.length).toBeGreaterThan(0);

  await expect(page.getByTestId('explorer-summary')).toContainText('ok');
  await expect(page.getByTestId('explorer-summary')).toContainText(`${got.duration_ms} ms`);
  await expect(page.getByTestId('rpc-request')).toContainText('"method": "tools/call"');
  await expect(page.getByTestId('rpc-request')).toContainText(`"sku": "${SKU}"`);
  const response = page.getByTestId('rpc-response');
  await expect(response).toContainText('"jsonrpc": "2.0"');
  await expect(response).toContainText(`"sku": "${SKU}"`);
  await expect(response).toContainText('"isError": false');
  // The envelope the agent reads, shown on its own above the raw exchange.
  const result = page.getByTestId('rpc-result');
  await expect(result).toContainText(`"sku": "${SKU}"`);
  await expect(result).toContainText('"demo": true');
  await expect(result).not.toContainText('dev.merchantbridge/trace');

  const decisions = page.getByTestId('explorer-decisions');
  await expect(decisions.getByRole('listitem')).toHaveCount(got.decisions.length);
  await expect(decisions).toContainText('admitted');
});

test('the Zoho 429 (code 44) fault surfaces RATE_LIMITED with the circuit decision', async ({
  page,
}) => {
  await gotoObservingTools(page, '/tools');
  const toggle = page.getByRole('switch', { name: 'Zoho 429 (code 44)' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const { sent, got } = await runGetItem(page);
  expect(sent).toMatchObject({
    tool: 'zoho_get_item',
    args: { sku: SKU },
    faults: ['rate_limit_44'],
  });
  expect(got.decisions.map((d) => d.type)).toContain('circuit_open');

  await expect(page.getByTestId('explorer-error-badge')).toContainText('RATE_LIMITED');
  const response = page.getByTestId('rpc-response');
  await expect(response).toContainText('"isError": true');
  await expect(response).toContainText('"code": "RATE_LIMITED"');
  await expect(response).toContainText('"retry_after_s"');
  await expect(page.getByTestId('rpc-result')).toContainText('"retryable": true');
  await expect(page.getByTestId('decision-circuit_open')).toContainText(/circuit open \d+s/);
  await expect(page.getByTestId('decision-rejected')).toContainText('RATE_LIMITED');
});
