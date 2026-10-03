import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ProtocolError } from '@modelcontextprotocol/client';
import { DEMO_IDS } from '@mb/core';
import { DEMO_TENANT_ID } from '@mb/db';
import { buildApp, createAppParts } from '../src/app';
import type { AppContext } from '../src/context';
import { TRACE_META_KEY } from '../src/mcp';
import type { Json } from './helpers';
import { routeClient, sessionId, structured, testContext } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(): Promise<{
  app: FastifyInstance;
  ctx: AppContext;
  parts: ReturnType<typeof createAppParts>;
}> {
  const { ctx } = await testContext();
  const parts = createAppParts(ctx);
  const app = await buildApp(ctx, parts);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { app, ctx, parts };
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe.each(['auto', 'legacy'] as const)(
  'demo MCP contract over /mcp/demo (%s)',
  (negotiation) => {
    it('tools/list returns every runtime tool in stable name order with real schemas', async () => {
      const { app, parts } = await setup();
      const client = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId() },
      });
      cleanup.push(() => client.close());
      const { tools } = await client.listTools();
      const expected = parts.runtime.listTools().map((t) => t.name);
      expect(tools.map((t) => t.name)).toEqual(expected);
      expect([...expected].sort()).toEqual(expected);
      const item = tools.find((t) => t.name === 'zoho_get_item');
      expect(item?.inputSchema.properties).toHaveProperty('sku');
      expect(item?.outputSchema).toBeTruthy();
      expect(item?.annotations?.readOnlyHint).toBe(true);
      const again = await client.listTools();
      expect(again.tools.map((t) => t.name)).toEqual(expected);
    });

    it('every scenario tool call succeeds against FakeZoho', async () => {
      const { app } = await setup();
      const client = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId() },
      });
      cleanup.push(() => client.close());
      await client.listTools();

      const pay = await client.callTool({
        name: 'zoho_find_by_payment_reference',
        arguments: { reference: DEMO_IDS.paymentRef },
      });
      expect(pay.isError).not.toBe(true);
      const match = structured(pay).data.matches[0];
      expect(match.resolved).toBe(true);
      expect(structured(pay).meta).toMatchObject({
        demo: true,
        organization_id: expect.any(String),
      });

      const so = await client.callTool({
        name: 'zoho_get_sales_order',
        arguments: { salesorder_id: match.sales_order.salesorder_id },
      });
      expect(so.isError).not.toBe(true);

      const item = await client.callTool({
        name: 'zoho_get_item',
        arguments: { sku: DEMO_IDS.sku },
      });
      expect(item.isError).not.toBe(true);
      expect(structured(item).data.rate).toEqual({ amount_minor: 18000, currency: 'INR' });
      // Text copy is the full JSON envelope (what Anthropic's mcpTools forwards to the model).
      const text = (item.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      expect(JSON.parse(text)).toEqual(structured(item));

      const customers = await client.callTool({
        name: 'zoho_search_customers',
        arguments: { name_contains: DEMO_IDS.rtoCustomer },
      });
      expect(customers.isError).not.toBe(true);
      const customerId = structured(customers).data.customers[0].contact_id;
      const orders = await client.callTool({
        name: 'zoho_list_sales_orders',
        arguments: { customer_id: customerId, status: 'void' },
      });
      expect(orders.isError).not.toBe(true);

      const today = new Date().toISOString().slice(0, 10);
      const invoices = await client.callTool({
        name: 'zoho_list_invoices',
        arguments: { status: 'unpaid', due_from: today, due_to: addDays(today, 7) },
      });
      expect(invoices.isError).not.toBe(true);

      const status = await client.callTool({ name: 'zoho_get_connection_status', arguments: {} });
      expect(structured(status).data).toMatchObject({ mode: 'demo', read_only: true });
    });

    it('bad args → isError INVALID_INPUT and exactly one usage event (demo tenant)', async () => {
      const { app, ctx } = await setup();
      const client = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId() },
      });
      cleanup.push(() => client.close());
      await client.listTools();
      await ctx.usage.flush();
      const before = (await ctx.stores.usage.recent(DEMO_TENANT_ID, 1000)).length;

      const res = await client.callTool({ name: 'zoho_get_item', arguments: { sku: 42 } });
      expect(res.isError).toBe(true);
      expect(structured(res).error).toMatchObject({ code: 'INVALID_INPUT', retryable: false });

      await ctx.usage.flush();
      const events = await ctx.stores.usage.recent(DEMO_TENANT_ID, 1000);
      expect(events.length - before).toBe(1);
      expect(events[0]).toMatchObject({
        tenant_id: DEMO_TENANT_ID,
        tool: 'zoho_get_item',
        status: 'error',
        error_code: 'INVALID_INPUT',
        demo: true,
      });
    });

    it('unknown tool → JSON-RPC error (not an isError result)', async () => {
      const { app } = await setup();
      const client = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId() },
      });
      cleanup.push(() => client.close());
      await expect(
        client.callTool({ name: 'zoho_delete_everything', arguments: {} }),
      ).rejects.toBeInstanceOf(ProtocolError);
    });

    it('X-MB-Faults rate_limit_44 → RATE_LIMITED with retry_after_s and a circuit_open decision', async () => {
      const { app } = await setup();
      const client = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId(), 'x-mb-faults': 'rate_limit_44' },
      });
      cleanup.push(() => client.close());
      const res = await client.callTool({
        name: 'zoho_get_item',
        arguments: { sku: DEMO_IDS.sku },
      });
      expect(res.isError).toBe(true);
      const err = structured(res).error;
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.retry_after_s).toBeGreaterThan(0);
      const trace = (res._meta as Json)[TRACE_META_KEY];
      expect(trace.decisions.some((d: Json) => d.type === 'circuit_open')).toBe(true);
    });

    it('expired_token → succeeds after a token refresh', async () => {
      const { app } = await setup();
      const session = sessionId();
      const client = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': session, 'x-mb-faults': 'expired_token' },
      });
      cleanup.push(() => client.close());
      const res = await client.callTool({ name: 'zoho_get_connection_status', arguments: {} });
      expect(res.isError).not.toBe(true);
      expect(structured(res).data.upstream).toEqual({ reachable: true, error_code: null });
      const trace = (res._meta as Json)[TRACE_META_KEY];
      // 401 attempt + retry with the refreshed token: two admitted upstream attempts.
      expect(trace.upstream_calls).toBe(2);
      // Later calls in the same session use the refreshed token directly.
      const again = await client.callTool({ name: 'zoho_get_connection_status', arguments: {} });
      expect((again._meta as Json)[TRACE_META_KEY].upstream_calls).toBe(1);
    });

    it('concurrency_1070 → retried, then success', async () => {
      const { app } = await setup();
      const client = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId(), 'x-mb-faults': 'concurrency_1070' },
      });
      cleanup.push(() => client.close());
      const res = await client.callTool({ name: 'zoho_get_connection_status', arguments: {} });
      expect(res.isError).not.toBe(true);
      const trace = (res._meta as Json)[TRACE_META_KEY];
      expect(trace.retries).toBeGreaterThanOrEqual(1);
      expect(trace.decisions.some((d: Json) => d.type === 'retried')).toBe(true);
    });

    it('faults are per session: session B is unaffected by session A toggling code 44', async () => {
      const { app } = await setup();
      const a = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId('a'), 'x-mb-faults': 'rate_limit_44' },
      });
      const b = await routeClient(app, '/mcp/demo', {
        negotiation,
        headers: { 'x-mb-session': sessionId('b') },
      });
      cleanup.push(
        () => a.close(),
        () => b.close(),
      );
      const ra = await a.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
      const rb = await b.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
      expect(ra.isError).toBe(true);
      expect(rb.isError).not.toBe(true);
    });
  },
);

describe('demo MCP HTTP behaviour', () => {
  it('GET and DELETE on /mcp/demo answer 405', async () => {
    const { app } = await setup();
    const get = await app.inject({
      method: 'GET',
      url: '/mcp/demo',
      headers: { accept: 'text/event-stream' },
    });
    expect(get.statusCode).toBe(405);
    const del = await app.inject({ method: 'DELETE', url: '/mcp/demo' });
    expect(del.statusCode).toBe(405);
  });

  it('rejects a Host outside allowedHosts with 403', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/demo',
      headers: {
        host: 'evil.example.net',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows any origin without credentials on /mcp/demo', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/mcp/demo',
      headers: { origin: 'https://some-host.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('limits /mcp/demo to 60 requests per minute per IP', async () => {
    const { app } = await setup();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/mcp/demo',
        remoteAddress: '203.0.113.9',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    for (let i = 0; i < 60; i++) await send();
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
