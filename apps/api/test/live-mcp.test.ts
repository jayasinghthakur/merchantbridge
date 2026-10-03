import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ZOHO_DATA_CENTERS, generateApiKey } from '@mb/auth';
import { DEMO_IDS, zohoRateProfile } from '@mb/core';
import { DEMO_TENANT_ID, createMemoryStores } from '@mb/db';
import { DEMO_ORGANIZATION_ID, ZOHO_SCOPES } from '@mb/zoho-inventory';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { REFRESH_TOKEN, createLiveUpstream } from './fakes';
import { LIVE_ENV, routeClient, sessionId, structured, testContext } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(opts: { stores?: ReturnType<typeof createMemoryStores> } = {}) {
  const upstream = createLiveUpstream();
  const { ctx, logs } = await testContext({
    env: LIVE_ENV,
    fetch: upstream.fetch,
    ...(opts.stores ? { stores: opts.stores } : {}),
  });
  const app = await buildApp(ctx);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { ctx, app, upstream, logs };
}

async function seedTenant(
  ctx: AppContext,
  name: string,
  withConnection: boolean,
  organizationId: string = DEMO_ORGANIZATION_ID,
) {
  const tenant = await ctx.stores.tenants.create({ name, kind: 'live' });
  const conn = withConnection
    ? await ctx.stores.connections.upsert({
        tenantId: tenant.id,
        provider: 'zoho_inventory',
        dc: 'in',
        accountsServer: ZOHO_DATA_CENTERS.in.accountsServer,
        apiDomain: ZOHO_DATA_CENTERS.in.apiDomain,
        organizationId,
        organizationName: `${name} org`,
        plan: null,
        scopes: [...ZOHO_SCOPES],
        refreshTokenEnc: ctx.auth!.vault.encrypt(REFRESH_TOKEN),
      })
    : null;
  const key = generateApiKey();
  const record = await ctx.stores.apiKeys.create({
    tenantId: tenant.id,
    prefix: key.prefix,
    hash: key.hash,
  });
  return { tenant, conn, key: key.key, keyId: record.id };
}

function mcpPost(app: FastifyInstance, authorization?: string) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization ? { authorization } : {}),
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('live MCP (/mcp)', () => {
  it('missing, malformed, unknown and revoked keys → 401 with a Bearer challenge', async () => {
    const { app, ctx } = await setup();
    const { key, keyId, tenant } = await seedTenant(ctx, 'A', false);

    for (const header of [
      undefined,
      'Basic abc',
      'Bearer not-a-key',
      `Bearer mb_live_${'x'.repeat(32)}`,
    ]) {
      const res = await mcpPost(app, header);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="merchantbridge"');
      expect(res.json()).toHaveProperty('error');
    }
    expect((await mcpPost(app, `Bearer ${key}`)).statusCode).toBe(200);

    await ctx.stores.apiKeys.revoke(tenant.id, keyId);
    expect((await mcpPost(app, `Bearer ${key}`)).statusCode).toBe(401);
  });

  it('works end to end against a wire-compatible FakeZoho, including 401 → refresh → retry', async () => {
    const { app, ctx, upstream } = await setup();
    const a = await seedTenant(ctx, 'A', true);
    const client = await routeClient(app, '/mcp', {
      headers: { authorization: `Bearer ${a.key}` },
    });
    cleanup.push(() => client.close());
    await client.listTools();

    // Cold cache: one refresh-token grant, then the call.
    const first = await client.callTool({
      name: 'zoho_get_item',
      arguments: { sku: DEMO_IDS.sku },
    });
    expect(first.isError).not.toBe(true);
    expect(structured(first).meta).toMatchObject({
      demo: false,
      organization_id: DEMO_ORGANIZATION_ID,
    });
    expect(first._meta?.['dev.merchantbridge/trace']).toBeUndefined();
    expect(upstream.tokenCalls('refresh_token')).toBe(1);

    // A stale cached token: Zoho answers 401, the provider refreshes once, the call is retried and succeeds.
    await ctx.auth!.tokens.primeAccessToken(a.conn!, 'stale-access-token', 3600);
    const second = await client.callTool({ name: 'zoho_get_connection_status', arguments: {} });
    expect(second.isError).not.toBe(true);
    expect(structured(second).data).toMatchObject({ mode: 'live', upstream: { reachable: true } });
    expect(upstream.tokenCalls('refresh_token')).toBe(2);

    await ctx.usage.flush();
    const events = await ctx.stores.usage.recent(a.tenant.id, 10);
    expect(events.length).toBe(2);
    expect(events.every((e) => e.tenant_id === a.tenant.id && e.demo === false)).toBe(true);
  });

  it("tenant B's key cannot read tenant A's connection", async () => {
    const { app, ctx, upstream } = await setup();
    await seedTenant(ctx, 'A', true);
    const b = await seedTenant(ctx, 'B', false);
    const client = await routeClient(app, '/mcp', {
      headers: { authorization: `Bearer ${b.key}` },
    });
    cleanup.push(() => client.close());
    const res = await client.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
    expect(res.isError).toBe(true);
    expect(structured(res).error).toMatchObject({
      code: 'RECONNECT_REQUIRED',
      message: 'No Zoho Inventory organization is connected for this key.',
    });
    expect(upstream.calls).toHaveLength(0);
    await ctx.usage.flush();
    const events = await ctx.stores.usage.recent(b.tenant.id, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenant_id: b.tenant.id, error_code: 'RECONNECT_REQUIRED' });
  });

  it('the demo endpoint never touches the connection store', async () => {
    const stores = createMemoryStores();
    const spied: string[] = [];
    const real = stores.connections;
    stores.connections = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          spied.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const { app, ctx } = await setup({ stores });
    await seedTenant(ctx, 'A', true);
    spied.length = 0;

    const client = await routeClient(app, '/mcp/demo', {
      headers: { 'x-mb-session': sessionId(), 'x-mb-faults': 'expired_token' },
    });
    cleanup.push(() => client.close());
    for (const t of (await client.listTools()).tools) {
      await client.callTool({
        name: t.name,
        arguments: t.name === 'zoho_get_item' ? { sku: DEMO_IDS.sku } : {},
      });
    }
    // Even a demo call carrying a live key header stays on the demo path.
    const withKey = await app.inject({
      method: 'POST',
      url: '/mcp/demo',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer whatever',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(withKey.statusCode).toBe(200);
    expect(spied).toEqual([]);

    await ctx.usage.flush();
    const demoEvents = await ctx.stores.usage.recent(DEMO_TENANT_ID, 100);
    expect(demoEvents.length).toBeGreaterThan(0);
    expect(demoEvents.every((e) => e.tenant_id === DEMO_TENANT_ID && e.demo)).toBe(true);
  });

  it('/mcp sends no CORS headers', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/mcp',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate governor scope (Zoho limits are per organization)', () => {
  it('tenants of the same org share one minute bucket and daily budget; another org does not', async () => {
    const { app, ctx } = await setup();
    // Each OAuth connect creates a tenant, so one org can have several tenants (and keys).
    const a = await seedTenant(ctx, 'A', true);
    const b = await seedTenant(ctx, 'B', true);
    const c = await seedTenant(ctx, 'C', true, '60000000001');
    const status = async (key: string) => {
      const client = await routeClient(app, '/mcp', {
        headers: { authorization: `Bearer ${key}` },
      });
      cleanup.push(() => client.close());
      return structured(
        await client.callTool({ name: 'zoho_get_connection_status', arguments: {} }),
      ).data.governor;
    };

    const ga = await status(a.key);
    const gb = await status(b.key);
    expect(ga.used_this_minute).toBe(1);
    // B's call lands in the bucket A already used: one org, one budget.
    expect(gb.used_this_minute).toBe(2);
    expect(gb.budget_remaining_today).toBe(ga.budget_remaining_today - 1);

    // A different org (FakeZoho rejects it, but the attempt is still governed) has its own budget.
    const gc = await status(c.key);
    expect(gc.used_this_minute).toBe(1);
    expect(gc.budget_remaining_today).toBe(ga.budget_remaining_today);

    const profile = zohoRateProfile('free');
    const shared = await ctx.governor.snapshot({ key: `zoho:in:${DEMO_ORGANIZATION_ID}`, profile });
    expect(shared.used_this_minute).toBe(2);
    const other = await ctx.governor.snapshot({ key: 'zoho:in:60000000001', profile });
    expect(other.used_this_minute).toBe(1);
  });
});
