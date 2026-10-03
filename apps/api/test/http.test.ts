import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, SCENARIOS, systemClock } from '@mb/core';
import type { Clock } from '@mb/core';
import { createMemoryStores } from '@mb/db';
import { buildApp } from '../src/app';
import { testContext } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(
  env: Record<string, string> = {},
  stores = createMemoryStores(),
  clock: Clock = systemClock,
) {
  const { ctx } = await testContext({ env, stores, clock });
  const app = await buildApp(ctx);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { app, ctx, stores };
}

describe('health', () => {
  it('live is always 200; ready reports storage mode and probes kv + store', async () => {
    const clock = new ManualClock(Date.now());
    const { app, stores } = await setup({}, createMemoryStores(), clock);
    expect((await app.inject({ url: '/health/live' })).json()).toEqual({ ok: true });
    const ready = await app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      storage: 'memory',
      kv: 'memory-kv',
      checks: { kv: true, store: true },
    });

    stores.tenants.get = () => Promise.reject(new Error('db down'));
    clock.advance(2_001); // probes are coalesced for 2 s
    const down = await app.inject({ url: '/health/ready' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ ok: false, checks: { store: false } });
  });

  it('health is exempt from the Host check; other routes are not', async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ url: '/health/live', headers: { host: 'fly-internal:8787' } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/status', headers: { host: 'evil.example' } })).statusCode,
    ).toBe(403);
  });

  it('GET / answers 200 for platform readiness probes (Hugging Face Spaces), whatever the Host', async () => {
    const { app } = await setup();
    const body = { service: 'merchantbridge-api', version: '0.1.0', docs: '/api/status' };
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Exempt from the Host check like /health/*: an internal probe Host (pod IP:port) must not 403 it.
    const internal = await app.inject({ url: '/', headers: { host: '10.0.3.7:7860' } });
    expect(internal.statusCode).toBe(200);
    expect(internal.json()).toEqual(body);
    expect((await app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(200);
    // Only the bare root: everything else still gets the Host check and the safe 404.
    expect(
      (await app.inject({ url: '/api/tools', headers: { host: '10.0.3.7:7860' } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/nope' })).statusCode).toBe(404);
  });
});

describe('public API', () => {
  it('GET /api/status', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/status' });
    expect(res.json()).toEqual({
      version: '0.1.0',
      playground_enabled: false,
      // No provider configured: the free OpenAI-compatible default's model (the playground stays off).
      model: 'openai/gpt-oss-120b',
      demo_mcp_url: 'http://localhost:8787/mcp/demo',
      tool_count: 10,
      turnstile_site_key: null,
      connect_enabled: false,
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('GET /api/tools and /api/scenarios', async () => {
    const { app } = await setup();
    const tools = (await app.inject({ url: '/api/tools' })).json();
    expect(tools.server).toEqual({ name: 'merchantbridge', version: '0.1.0' });
    expect(tools.tools).toHaveLength(10);
    expect(Object.keys(tools.tools[0]).sort()).toEqual(
      [
        'annotations',
        'description',
        'inputJsonSchema',
        'name',
        'outputJsonSchema',
        'scopes',
        'title',
      ].sort(),
    );
    expect((await app.inject({ url: '/api/scenarios' })).json()).toEqual(
      JSON.parse(JSON.stringify(SCENARIOS)),
    );
  });

  it('CORS on /api/* only for configured origins', async () => {
    const { app } = await setup({ MB_CORS_ORIGINS: 'https://merchantbridge-*.vercel.app' });
    const allowed = await app.inject({
      url: '/api/status',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const preview = await app.inject({
      url: '/api/status',
      headers: { origin: 'https://merchantbridge-git-x.vercel.app' },
    });
    expect(preview.headers['access-control-allow-origin']).toBe(
      'https://merchantbridge-git-x.vercel.app',
    );
    const denied = await app.inject({
      url: '/api/status',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET /metrics exposes tool-call metrics without tenant labels', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/explorer/call',
      payload: {
        tool: 'zoho_get_connection_status',
        args: {},
        session_id: 'metrics-session-1',
        faults: [],
      },
    });
    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(
      'mb_tool_calls_total{tool="zoho_get_connection_status",status="ok",error_code="none",demo="true"} 1',
    );
    expect(res.payload).toContain('mb_tool_call_duration_seconds_bucket');
    expect(res.payload).not.toMatch(/tenant|session/);
  });

  it('no-store on /oauth/* and /api/playground', async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ url: '/oauth/zoho/start?dc=in&invite=x' })).headers['cache-control'],
    ).toBe('no-store');
    expect(
      (await app.inject({ method: 'POST', url: '/api/playground', payload: {} })).headers[
        'cache-control'
      ],
    ).toBe('no-store');
  });
});
