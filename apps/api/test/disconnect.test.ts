import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ZOHO_DATA_CENTERS, generateApiKey } from '@mb/auth';
import { API_ROUTES, DEMO_IDS } from '@mb/core';
import { DEMO_ORGANIZATION_ID, ZOHO_SCOPES } from '@mb/zoho-inventory';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { REFRESH_TOKEN, createLiveUpstream } from './fakes';
import { LIVE_ENV, routeClient, sessionId, structured, testContext } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup() {
  const upstream = createLiveUpstream();
  const { ctx, logs } = await testContext({ env: LIVE_ENV, fetch: upstream.fetch });
  const app = await buildApp(ctx);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { ctx, app, upstream, logs };
}

async function seedTenant(ctx: AppContext) {
  const tenant = await ctx.stores.tenants.create({ name: 'Merchant', kind: 'live' });
  const conn = await ctx.stores.connections.upsert({
    tenantId: tenant.id,
    provider: 'zoho_inventory',
    dc: 'in',
    accountsServer: ZOHO_DATA_CENTERS.in.accountsServer,
    apiDomain: ZOHO_DATA_CENTERS.in.apiDomain,
    organizationId: DEMO_ORGANIZATION_ID,
    organizationName: 'Merchant org',
    plan: null,
    scopes: [...ZOHO_SCOPES],
    refreshTokenEnc: ctx.auth!.vault.encrypt(REFRESH_TOKEN),
  });
  const key = generateApiKey();
  await ctx.stores.apiKeys.create({ tenantId: tenant.id, prefix: key.prefix, hash: key.hash });
  return { tenant, conn, key: key.key };
}

function disconnect(app: FastifyInstance, authorization?: string) {
  return app.inject({
    method: 'POST',
    url: API_ROUTES.disconnect,
    headers: authorization ? { authorization } : {},
  });
}

describe('POST /api/connection/disconnect', () => {
  it('revokes at Zoho, marks the connection revoked and revokes the calling key', async () => {
    const { app, ctx, upstream, logs } = await setup();
    const t = await seedTenant(ctx);

    const res = await disconnect(app, `Bearer ${t.key}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      revoked_locally: true,
      revoked_at_zoho: true,
      had_connection: true,
    });
    expect(upstream.calls.filter((c) => c.path === '/oauth/v2/revoke/token')).toHaveLength(1);

    const conn = await ctx.stores.connections.get(t.tenant.id, t.conn.id);
    expect(conn?.status).toBe('revoked');
    expect(await ctx.stores.connections.getActiveForTenant(t.tenant.id)).toBeNull();

    // The key is gone: a second disconnect and any /mcp call are unauthorized.
    expect((await disconnect(app, `Bearer ${t.key}`)).statusCode).toBe(401);
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${t.key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.statusCode).toBe(401);

    const logged = logs.text();
    expect(logged).not.toContain(REFRESH_TOKEN);
    expect(logged).not.toContain(t.key);
  });

  it('still revokes locally when Zoho cannot be reached', async () => {
    const { app, ctx, upstream } = await setup();
    const t = await seedTenant(ctx);
    upstream.state.revokeFails = true;

    const res = await disconnect(app, `Bearer ${t.key}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      revoked_locally: true,
      revoked_at_zoho: false,
      had_connection: true,
    });
    expect((await ctx.stores.connections.get(t.tenant.id, t.conn.id))?.status).toBe('revoked');
    expect((await disconnect(app, `Bearer ${t.key}`)).statusCode).toBe(401);
  });

  it('rejects missing or malformed keys and other methods', async () => {
    const { app } = await setup();
    for (const header of [undefined, 'Bearer nope', `Bearer mb_live_${'x'.repeat(32)}`]) {
      const res = await disconnect(app, header);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="merchantbridge"');
    }
    const get = await app.inject({ method: 'GET', url: API_ROUTES.disconnect });
    expect(get.statusCode).toBe(405);
  });

  it('leaves the public demo untouched', async () => {
    const { app, ctx } = await setup();
    const t = await seedTenant(ctx);
    expect((await disconnect(app, `Bearer ${t.key}`)).statusCode).toBe(200);

    const client = await routeClient(app, '/mcp/demo', {
      headers: { 'x-mb-session': sessionId('disconnect-demo') },
    });
    cleanup.push(() => client.close());
    const res = await client.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
    expect(res.isError).not.toBe(true);
    expect(structured(res).meta).toMatchObject({ demo: true });
  });
});
