import type { PlaygroundRequest } from '@mb/core/telemetry';
import { expect, test } from '@playwright/test';
import { mockApi } from './mock-api';

test.describe('playground', () => {
  test('scenario card runs a tool step and shows the answer', async ({ page }) => {
    let sent: PlaygroundRequest | null = null;
    await mockApi(page, { onPlaygroundRequest: (r) => (sent = r) });
    await page.goto('/playground');
    await expect(page.getByTestId('demo-badge').first()).toContainText('DEMO DATA');

    await page.locator('[data-scenario="dispute-evidence"]').click();

    const steps = page.getByTestId('tool-step');
    await expect(steps).toHaveCount(2);
    await expect(steps.first()).toContainText('zoho_find_by_payment_reference');
    await expect(steps.first()).toContainText('184 ms');
    await expect(steps.nth(1).getByTestId('cached-badge')).toBeVisible();
    await expect(page.getByTestId('assistant-text').last()).toContainText('INV-00031');
    // Bold rendered as an element, not as literal asterisks.
    await expect(page.getByTestId('assistant-text').last().locator('strong').first()).toBeVisible();
    await expect(page.getByTestId('run-done')).toContainText('2 tool calls');

    expect(sent).not.toBeNull();
    const req = sent as unknown as PlaygroundRequest;
    expect(req.scenario_id).toBe('dispute-evidence');
    expect(req.session_id).toMatch(/[0-9a-f-]{8,}/);
    expect(req.faults).toEqual([]);
  });

  test('code 44 fault shows a RATE_LIMITED step with the circuit decision', async ({ page }) => {
    let sent: PlaygroundRequest | null = null;
    await mockApi(page, { onPlaygroundRequest: (r) => (sent = r) });
    await page.goto('/playground');

    const toggle = page.getByTestId('fault-rate_limit_44');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.locator('[data-scenario="cod-stock"]').click();

    await expect(page.getByTestId('error-code-badge')).toHaveText('RATE_LIMITED');
    await expect(page.getByTestId('decision-circuit_open')).toContainText('circuit open 60s');
    await expect(page.getByTestId('run-done')).toBeVisible();
    expect((sent as unknown as PlaygroundRequest).faults).toEqual(['rate_limit_44']);
  });

  test('refusal scenario makes zero tool calls', async ({ page }) => {
    await mockApi(page);
    await page.goto('/playground');
    await page.locator('[data-scenario="refuse-write"]').click();

    await expect(page.getByTestId('assistant-text')).toContainText('read-only');
    await expect(page.getByTestId('run-done')).toContainText('0 tool calls');
    await expect(page.getByTestId('tool-step')).toHaveCount(0);
  });

  test('a paused playground explains why, points to the Tools explorer and sends nothing', async ({ page }) => {
    let calls = 0;
    await mockApi(page, { status: { playground_enabled: false }, onPlaygroundRequest: () => (calls += 1) });
    await page.goto('/playground');
    const off = page.getByTestId('playground-off');
    await expect(off).toContainText('Live agent paused');
    await expect(off.getByRole('link', { name: 'Open the Tools explorer' })).toHaveAttribute('href', '/tools');
    await expect(page.locator('[data-scenario="cod-stock"]')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
    await expect(page.getByTestId('trace-paused')).toBeVisible();
    expect(calls).toBe(0);
  });

  test('PLAYGROUND_DISABLED from the API (status was stale) points to the Tools explorer', async ({ page }) => {
    await mockApi(page, {
      playground: async (_req, route) => {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'PLAYGROUND_DISABLED',
              message: 'The live agent is paused; use the Tools explorer, which needs no LLM.',
            },
          },
        });
      },
    });
    await page.goto('/playground');
    await page.locator('[data-scenario="cod-stock"]').click();

    const err = page.getByTestId('playground-error');
    await expect(err).toContainText('The live agent is paused');
    await expect(err).toContainText('use the Tools explorer, which needs no LLM');
    await expect(err.getByRole('link', { name: 'Open the Tools explorer' })).toHaveAttribute('href', '/tools');
  });

  test('replayed runs are badged', async ({ page }) => {
    await mockApi(page, {
      playground: async (_req, route) => {
        await route.fulfill({
          headers: { 'content-type': 'text/event-stream' },
          body:
            'data: {"type":"session","session_id":"s","model":"claude-haiku-4-5","replay":true,"faults":[]}\n\n' +
            'data: {"type":"assistant_text","text":"Recorded answer."}\n\n' +
            'data: {"type":"done","stop_reason":"end_turn","tool_calls":0,"input_tokens":1,"output_tokens":1,"duration_ms":5}\n\n',
        });
      },
    });
    await page.goto('/playground');
    await page.locator('[data-scenario="cod-stock"]').click();
    await expect(page.getByTestId('replay-badge')).toBeVisible();
  });

  test('RATE_LIMITED from the API shows a countdown and blocks sending', async ({ page }) => {
    await mockApi(page, {
      playground: async (_req, route) => {
        await route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: '10 questions per 10 minutes', retry_after_s: 42 } },
        });
      },
    });
    await page.goto('/playground');
    await page.locator('[data-scenario="cod-stock"]').click();
    await expect(page.getByTestId('retry-countdown')).toContainText(/ask again in 4\ds/);
    await expect(page.locator('[data-scenario="cod-stock"]')).toBeDisabled();
  });

  test('free-text question is sent and the box clears', async ({ page }) => {
    let sent: PlaygroundRequest | null = null;
    await mockApi(page, { onPlaygroundRequest: (r) => (sent = r) });
    await page.goto('/playground');
    const box = page.getByLabel('Ask your own question');
    await box.fill('Which invoices are overdue?');
    await box.press('Enter');
    await expect(page.getByTestId('run-done')).toBeVisible();
    await expect(box).toHaveValue('');
    const req = sent as unknown as PlaygroundRequest;
    expect(req.message).toBe('Which invoices are overdue?');
    expect(req.scenario_id).toBeUndefined();
  });

  test('a stream that ends early is reported', async ({ page }) => {
    await mockApi(page, {
      playground: async (_req, route) => {
        await route.fulfill({
          headers: { 'content-type': 'text/event-stream' },
          body: 'data: {"type":"session","session_id":"s","model":"m","replay":false,"faults":[]}\n\n',
        });
      },
    });
    await page.goto('/playground');
    await page.locator('[data-scenario="cod-stock"]').click();
    await expect(page.getByTestId('playground-interrupted')).toBeVisible();
  });
});
