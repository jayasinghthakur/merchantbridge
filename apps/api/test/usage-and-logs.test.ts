import { afterEach, describe, expect, it } from 'vitest';
import { ZOHO_DATA_CENTERS } from '@mb/auth';
import { DEMO_IDS } from '@mb/core';
import type { UsageEvent, UsageStore } from '@mb/core';
import { DEMO_TENANT_ID } from '@mb/db';
import { buildApp } from '../src/app';
import { createUsageEmitter, sanitizeUsageEvent } from '../src/usage';
import { GOOD_CODE, REFRESH_TOKEN, createLiveUpstream } from './fakes';
import { LIVE_ENV, TEST_CLIENT_SECRET, routeClient, sessionId, testContext } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: new Date().toISOString(),
    request_id: 'req-1',
    tenant_id: DEMO_TENANT_ID,
    organization_id: null,
    connector: 'zoho_inventory',
    tool: 'zoho_get_item',
    client_name: null,
    demo: true,
    status: 'ok',
    error_code: null,
    duration_ms: 1,
    upstream_calls: 1,
    cache_hits: 0,
    retries: 0,
    result_tokens: 10,
    args_masked: {},
    ...overrides,
  };
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('usage emitter', () => {
  it('truncates client_name to 64 chars and caps args_masked at 2 KB', () => {
    const clean = sanitizeUsageEvent(
      event({ client_name: 'c'.repeat(200), args_masked: { a: 'x'.repeat(3000) } }),
    );
    expect(clean.client_name).toHaveLength(64);
    expect(clean.args_masked).toEqual({ _truncated: true, _keys: 1 });
  });

  it('flushes in batches of 100 and never throws; drops after repeated failures', async () => {
    const batches: number[] = [];
    let failing = false;
    const store: UsageStore = {
      insertMany: (events) => {
        if (failing) return Promise.reject(new Error('db down'));
        batches.push(events.length);
        return Promise.resolve();
      },
      recent: () => Promise.resolve([]),
      deleteOlderThan: () => Promise.resolve(0),
    };
    const errors: string[] = [];
    const emitter = createUsageEmitter({
      store,
      log: { ...silent, error: (_o, m) => errors.push(m ?? '') },
      flushMs: 60_000,
      maxAttempts: 2,
    });
    for (let i = 0; i < 250; i++) emitter.emit(event());
    await emitter.flush();
    expect(batches.reduce((a, b) => a + b, 0)).toBe(250);
    expect(Math.max(...batches)).toBeLessThanOrEqual(100);

    failing = true;
    emitter.emit(event());
    await emitter.flush();
    expect(emitter.pending).toBe(1);
    await emitter.flush();
    expect(emitter.pending).toBe(0);
    expect(errors.some((m) => m.includes('dropped'))).toBe(true);
    await emitter.close();
  });
});

describe('usage events and secret hygiene end to end', () => {
  it('demo calls are recorded on DEMO_TENANT_ID with the client label', async () => {
    const { ctx } = await testContext();
    const app = await buildApp(ctx);
    cleanup.push(
      () => ctx.close(),
      () => app.close(),
    );
    const client = await routeClient(app, '/mcp/demo', {
      headers: { 'x-mb-session': sessionId() },
    });
    cleanup.push(() => client.close());
    await client.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
    await client.callTool({ name: 'zoho_search_customers', arguments: { name_contains: 'Rohan' } });
    await ctx.usage.flush();
    const events = await ctx.stores.usage.recent(DEMO_TENANT_ID, 10);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e).toMatchObject({
        tenant_id: DEMO_TENANT_ID,
        demo: true,
        status: 'ok',
        client_name: 'route-test',
      });
    }
    expect(events.find((e) => e.tool === 'zoho_get_item')?.args_masked).toEqual({
      sku: DEMO_IDS.sku,
    });
  });

  it('a full connect + live calls + refresh never logs keys, bearer tokens, auth codes or refresh tokens', async () => {
    const upstream = createLiveUpstream();
    const { ctx, logs } = await testContext({
      env: LIVE_ENV,
      fetch: upstream.fetch,
      logLevel: 'trace',
    });
    const app = await buildApp(ctx);
    cleanup.push(
      () => ctx.close(),
      () => app.close(),
    );

    const start = await app.inject({ url: '/oauth/zoho/start?dc=in&invite=let-me-in-please' });
    const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
    const cookie = String(start.headers['set-cookie']).split(';')[0] ?? '';
    const cb = await app.inject({
      url: `/oauth/zoho/callback?${new URLSearchParams({
        code: GOOD_CODE,
        state,
        location: 'in',
        'accounts-server': ZOHO_DATA_CENTERS.in.accountsServer,
      }).toString()}`,
      headers: { cookie },
    });
    const key = new URLSearchParams(String(cb.headers.location).split('#')[1]).get('key') ?? '';
    expect(key).toMatch(/^mb_live_/);

    const client = await routeClient(app, '/mcp', { headers: { authorization: `Bearer ${key}` } });
    cleanup.push(() => client.close());
    await client.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
    // Force a 401 → refresh → retry so the refresh path is logged too.
    const tenantKey = await ctx.stores.apiKeys.findActiveByHash(
      (await import('@mb/auth')).hashApiKey(key),
    );
    const conn = await ctx.stores.connections.getActiveForTenant(tenantKey!.tenantId);
    await ctx.auth!.tokens.primeAccessToken(conn!, 'stale-access-token-zzz', 3600);
    await client.callTool({ name: 'zoho_get_connection_status', arguments: {} });
    expect(upstream.tokenCalls('refresh_token')).toBe(1);
    // A wrong key is rejected and not echoed.
    await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer mb_live_${'Q'.repeat(32)}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    const all = logs.text();
    expect(all.length).toBeGreaterThan(0);
    const accessTokens = upstream.calls.length > 0 ? [await upstream.fake.tokens.get()] : [];
    for (const secret of [
      key,
      key.slice(8),
      `mb_live_${'Q'.repeat(32)}`,
      GOOD_CODE,
      REFRESH_TOKEN,
      TEST_CLIENT_SECRET,
      state,
      'stale-access-token-zzz',
      ...accessTokens,
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toMatch(/Bearer mb_live_/);
    expect(all).not.toMatch(/Zoho-oauthtoken/);
  });
});
