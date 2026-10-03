import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@mb/core';
import { buildApp } from '../src/app';
import { sessionId, testContext } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup() {
  const { ctx } = await testContext();
  const app = await buildApp(ctx);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { app, ctx };
}

describe('POST /api/explorer/call', () => {
  it('returns the raw JSON-RPC request and response plus the governor decisions', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/explorer/call',
      payload: {
        tool: 'zoho_get_item',
        args: { sku: DEMO_IDS.sku },
        session_id: sessionId('ex'),
        faults: [],
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.request).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } },
    });
    expect(out.response).toMatchObject({ jsonrpc: '2.0', id: out.request.id });
    expect(out.response.result.structuredContent.data.sku).toBe(DEMO_IDS.sku);
    expect(out.response.result.content[0].type).toBe('text');
    expect(out.decisions.some((d: { type: string }) => d.type === 'admitted')).toBe(true);
    expect(out.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('applies faults from the request and shows the error result', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/explorer/call',
      payload: {
        tool: 'zoho_get_item',
        args: { sku: DEMO_IDS.sku },
        session_id: sessionId('ex'),
        faults: ['rate_limit_44'],
      },
    });
    const out = res.json();
    expect(out.response.result.isError).toBe(true);
    expect(out.response.result.structuredContent.error.code).toBe('RATE_LIMITED');
    expect(out.decisions.some((d: { type: string }) => d.type === 'circuit_open')).toBe(true);
  });

  it('shows an unknown tool as a JSON-RPC error', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/explorer/call',
      payload: { tool: 'zoho_nope', args: {}, session_id: sessionId('ex'), faults: [] },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.response.error).toMatchObject({ code: expect.any(Number) });
    expect(out.decisions).toEqual([]);
  });

  it('validates the body and rate limits at 30 per minute per IP', async () => {
    const { app } = await setup();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/explorer/call',
      payload: { tool: 'zoho_get_item', args: {}, session_id: 'x', faults: [] },
    });
    expect(bad.statusCode).toBe(400);
    for (let i = 0; i < 29; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/explorer/call',
        payload: {
          tool: 'zoho_get_connection_status',
          args: {},
          session_id: sessionId('ex'),
          faults: [],
        },
      });
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/explorer/call',
      payload: {
        tool: 'zoho_get_connection_status',
        args: {},
        session_id: sessionId('ex'),
        faults: [],
      },
    });
    expect(limited.statusCode).toBe(429);
  });
});
