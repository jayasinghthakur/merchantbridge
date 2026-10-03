import type { ApiErrorResponse, ToolsResponse } from '@mb/core/http';
import { API_ROUTES } from '@mb/core/http';
import { expect, gotoObservingStatus, parseMcpBody, test } from './fixtures';

test('home renders the live tool count from /api/status', async ({ page }) => {
  const { body: status } = await gotoObservingStatus(page, '/');
  expect(status.tool_count).toBeGreaterThan(0);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'A private Agent Studio-style connector for Zoho Inventory',
  );
  const count = page.getByTestId('home-tool-count');
  await expect(count).toHaveAttribute('data-source', 'live');
  await expect(count).toHaveText(String(status.tool_count));
  await expect(
    page.getByRole('heading', { name: `${status.tool_count} read-only tools` }),
  ).toBeVisible();
  await expect(page.getByTestId('mcp-demo-command')).toContainText(
    `claude mcp add --transport http mb-demo ${status.demo_mcp_url}`,
  );
  await expect(page.getByTestId('not-affiliated')).toBeVisible();
});

test('docs renders CAN / CANNOT, the live tool table and the real demo MCP URL', async ({
  page,
  request,
}) => {
  const toolsSeen = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith(API_ROUTES.tools),
  );
  const { body: status } = await gotoObservingStatus(page, '/docs');
  const tools = (await (await toolsSeen).json()) as ToolsResponse;

  await expect(page.getByRole('heading', { name: 'What it can and cannot do' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Can', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cannot', exact: true })).toBeVisible();
  await expect(page.getByTestId('docs-can')).toContainText('exact SKU');
  await expect(page.getByTestId('docs-cannot')).toContainText(
    'Create, edit, cancel or delete anything',
  );
  await expect(page.getByTestId('docs-tool-count')).toHaveText(String(status.tool_count));

  const table = page.getByTestId('docs-tool-table');
  await expect(table.locator('tbody tr')).toHaveCount(tools.tools.length);
  for (const t of tools.tools) await expect(table).toContainText(t.name);

  const demoUrl = status.demo_mcp_url;
  expect(demoUrl).toMatch(/^https?:\/\/[^/]+(\/.*)?\/mcp\/demo$/);
  await expect(page.getByTestId('docs-claude-code-demo')).toContainText(
    `claude mcp add --transport http mb-demo ${demoUrl}`,
  );
  await expect(page.getByTestId('docs-connector-url').locator('pre')).toHaveText(demoUrl);

  // The URL on the page is a working MCP server, not just a string: tools/list over Streamable HTTP.
  const res = await request.post(demoUrl, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(res.status()).toBe(200);
  const rpc = parseMcpBody(res.headers()['content-type'] ?? '', await res.text()) as {
    result?: { tools?: { name: string }[] };
  };
  expect(rpc.result?.tools?.map((t) => t.name)).toEqual(tools.tools.map((t) => t.name));
});

test('connect shows the disabled-connect note when the API has no Zoho credentials', async ({
  page,
  request,
}) => {
  const { body: status, apiBase } = await gotoObservingStatus(page, '/connect');
  const submit = page.getByRole('button', { name: 'Continue to Zoho' });
  await expect(page.getByRole('heading', { name: 'Connect Zoho Inventory' })).toBeVisible();

  if (status.connect_enabled) {
    test
      .info()
      .annotations.push({
        type: 'deployment',
        description: 'connect is enabled; checked the open form',
      });
    await expect(page.getByTestId('connect-disabled')).toHaveCount(0);
    await expect(submit).toBeEnabled();
    return;
  }

  const note = page.getByTestId('connect-disabled');
  await expect(note).toContainText('Connecting is closed right now');
  await expect(note.getByRole('link', { name: 'Tools explorer' })).toHaveAttribute(
    'href',
    '/tools',
  );
  await expect(submit).toBeDisabled();
  await expect(page.getByLabel('Invite code')).toBeDisabled();

  // The API agrees: starting OAuth bounces straight to the error page instead of Zoho.
  const start = await request.get(
    `${apiBase}${API_ROUTES.oauthStart}?dc=in&invite=e2e-not-a-code`,
    {
      maxRedirects: 0,
    },
  );
  expect(start.status()).toBe(302);
  const location = start.headers()['location'] ?? '';
  expect(location).toMatch(/\/connect\/error\?reason=connect_disabled$/);
  expect(location).not.toContain('zoho');

  await page.goto(new URL(location).pathname + new URL(location).search);
  await expect(page.getByTestId('connect-error')).toContainText(
    'Connecting real organizations is closed here',
  );
});

test('playground shows the PLAYGROUND_DISABLED state and points to the Tools explorer', async ({
  page,
  request,
}) => {
  const playgroundCalls: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith(API_ROUTES.playground)) playgroundCalls.push(r.url());
  });
  const { body: status, apiBase } = await gotoObservingStatus(page, '/playground');
  await expect(page.getByTestId('demo-badge').first()).toContainText('DEMO DATA');
  const card = page.locator('[data-scenario="cod-stock"]');

  if (status.playground_enabled) {
    test
      .info()
      .annotations.push({
        type: 'deployment',
        description: 'playground is enabled; no model call made',
      });
    await expect(page.getByTestId('playground-off')).toHaveCount(0);
    await expect(card).toBeEnabled();
    return;
  }

  // The API reports the same state the page shows (asked outside the browser, so it is not a page error).
  const res = await request.post(`${apiBase}${API_ROUTES.playground}`, {
    data: { message: 'ping', session_id: 'e2e-real-probe', faults: [] },
  });
  expect(res.status()).toBe(503);
  const body = (await res.json()) as ApiErrorResponse;
  expect(body.error.code).toBe('PLAYGROUND_DISABLED');

  const off = page.getByTestId('playground-off');
  await expect(off).toContainText('Live agent paused');
  await expect(off).toContainText('Tools explorer');
  await expect(page.getByTestId('scenario-card')).toHaveCount(5);
  for (const c of await page.getByTestId('scenario-card').all()) await expect(c).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Ask your own question')).toBeDisabled();
  await expect(page.getByTestId('trace-paused')).toBeVisible();
  expect(playgroundCalls, 'a paused playground must not send doomed requests').toEqual([]);

  await off.getByRole('link', { name: 'Open the Tools explorer' }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await expect(page.getByRole('heading', { name: 'Tool explorer', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Run zoho_/ })).toBeVisible();
});
