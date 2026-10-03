import { expect, test } from '@playwright/test';
import { mockApi } from './mock-api';

test('home shows the hero, principle table and the demo MCP command from /api/status', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'A private Agent Studio-style connector for Zoho Inventory',
  );
  await expect(page.getByTestId('mcp-demo-command')).toContainText(
    'claude mcp add --transport http mb-demo https://api.merchantbridge.test/mcp/demo',
  );
  await expect(page.getByRole('rowheader', { name: 'Audit trail' })).toBeVisible();
  await expect(page.getByTestId('not-affiliated')).toHaveText(
    'Independent take-home project. Not affiliated with Razorpay or Zoho.',
  );
});

test('tool explorer lists tools, builds args from the schema and shows the raw exchange', async ({
  page,
}) => {
  let body: unknown = null;
  await mockApi(page);
  await page.route('**/__mockapi/api/explorer/call', async (route) => {
    body = route.request().postDataJSON();
    await route.fallback();
  });
  await page.goto('/tools');
  await expect(page.getByTestId('demo-badge').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Find by payment reference' })).toBeVisible();

  // Faults belong to the tab's demo session, not to a tool: toggling before picking a tool must stick.
  await page.getByTestId('fault-expired_token').click();
  await page.getByRole('button', { name: /Get item/ }).click();
  await expect(page.getByTestId('fault-expired_token')).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel(/^sku/).fill('CHAI-250');
  await page.getByRole('button', { name: 'Run zoho_get_item' }).click();

  await expect(page.getByTestId('rpc-request')).toContainText('"tools/call"');
  await expect(page.getByTestId('rpc-response')).toContainText('Masala Chai 250g');
  await expect(page.getByTestId('rpc-result')).toContainText('"amount_minor": 18000');
  await expect(page.getByTestId('rpc-result')).not.toContainText('jsonrpc');
  await expect(page.getByTestId('explorer-summary')).toContainText('37 ms');
  expect(body).toMatchObject({
    tool: 'zoho_get_item',
    args: { sku: 'CHAI-250', include_locations: true },
    faults: ['expired_token'],
  });
});

test('tool explorer shows an error state with retry when the API is down', async ({ page }) => {
  await mockApi(page, { tools: 'error' });
  await page.goto('/tools');
  await expect(page.getByText('Could not load the tool list')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('docs keeps a Claude model in the Messages API snippet whatever the playground runs', async ({
  page,
}) => {
  await mockApi(page, { status: { model: 'llama-3.3-70b-versatile' } });
  await page.goto('/docs');
  const snippet = page.getByTestId('docs-messages-api');
  await expect(snippet).toContainText('"model": "claude-haiku-4-5"');
  await expect(snippet).not.toContainText('llama');
});

test('docs falls back to the static tool table', async ({ page }) => {
  await mockApi(page, { tools: 'error' });
  await page.goto('/docs');
  await expect(page.getByTestId('docs-tool-table')).toContainText('zoho_find_by_payment_reference');
  await expect(page.getByText('mcp-client-2025-11-20').first()).toBeVisible();
});

test('connect is disabled when the API says so', async ({ page }) => {
  await mockApi(page, { status: { connect_enabled: false } });
  await page.goto('/connect');
  await expect(page.getByTestId('connect-disabled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Zoho' })).toBeDisabled();
});

test('connect success shows the key once and clears the fragment', async ({ page }) => {
  await mockApi(page);
  await page.goto('/connect/success#key=mb_live_e2eTESTkey123&org=Chai%20%26%20Co&dc=in');
  await expect(page.getByTestId('api-key')).toContainText('mb_live_e2eTESTkey123');
  await expect(page.getByTestId('key-once-warning')).toBeVisible();
  await expect(page.getByText('Chai & Co')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.reload();
  await expect(page.getByText('There is no key to show')).toBeVisible();
});

test('connect error maps the reason to a message', async ({ page }) => {
  await mockApi(page);
  await page.goto('/connect/error?reason=access_denied');
  await expect(page.getByTestId('connect-error')).toContainText('Access was not granted');
});
