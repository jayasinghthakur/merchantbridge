import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConnectorError,
  ManualClock,
  UnknownToolError,
  createToolFactory,
  createToolRuntime,
  decodeCursor,
  defineConnector,
  encodeCursor,
  maskArgs,
  noopLogger,
  toMoney,
  type UsageEvent,
} from '../src/index';

interface FakeClient {
  items: Record<string, { name: string; secret: string }>;
}

const defineTool = createToolFactory<FakeClient>();

const getThing = defineTool({
  name: 'test_get_thing',
  title: 'Get thing',
  description: 'Returns a thing.',
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ id: z.string(), name: z.string() }),
  scopes: ['S.READ'],
  async handler({ id }, ctx) {
    ctx.note({ type: 'admitted', waited_ms: 0 });
    const item = ctx.client.items[id];
    if (!item) throw new ConnectorError('NOT_FOUND', `No thing ${id}.`);
    return { data: { id, ...item }, upstreamUrl: `https://example.test/things/${id}` };
  },
});

const boom = defineTool({
  name: 'test_boom',
  title: 'Boom',
  description: 'Throws.',
  input: z.object({}),
  output: z.object({}),
  scopes: ['S.READ'],
  handler() {
    return Promise.reject(new Error('secret token abc leaked'));
  },
});

function setup() {
  const events: UsageEvent[] = [];
  const runtime = createToolRuntime<FakeClient>({
    connector: defineConnector({ id: 'test', name: 'Test', scopes: ['S.READ'], tools: [getThing, boom] }),
    resolve: () =>
      Promise.resolve({
        client: { items: { a1: { name: 'Alpha', secret: 'do-not-leak' } } },
        organizationId: 'org1',
        budgetRemaining: () => Promise.resolve(42),
      }),
    emit: (e) => {
      events.push(e);
    },
    log: noopLogger,
    clock: new ManualClock(),
  });
  return { runtime, events };
}

const opts = { tenantId: 't1', requestId: 'r1', demo: true };

describe('ToolRuntime', () => {
  it('lists tools in deterministic order with JSON schemas and read-only annotations', () => {
    const { runtime } = setup();
    const tools = runtime.listTools();
    expect(tools.map((t) => t.name)).toEqual(['test_boom', 'test_get_thing']);
    expect(tools[1]!.inputJsonSchema).toMatchObject({ type: 'object', required: ['id'] });
    expect(tools[1]!.annotations.readOnlyHint).toBe(true);
  });

  it('returns an envelope, strips non-allow-listed fields, emits exactly one usage event', async () => {
    const { runtime, events } = setup();
    const res = await runtime.callTool('test_get_thing', { id: 'a1' }, opts);
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toMatchObject({
      data: { id: 'a1', name: 'Alpha' },
      meta: { organization_id: 'org1', budget_remaining_today: 42, demo: true },
    });
    expect(JSON.stringify(res.structuredContent)).not.toContain('do-not-leak');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'ok', upstream_calls: 1, tool: 'test_get_thing' });
  });

  it('maps bad args to INVALID_INPUT as an isError result, not a throw', async () => {
    const { runtime, events } = setup();
    const res = await runtime.callTool('test_get_thing', { id: 5 }, opts);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error: { code: 'INVALID_INPUT', retryable: false } });
    expect(events).toHaveLength(1);
  });

  it('maps ConnectorError and hides unexpected error details', async () => {
    const { runtime, events } = setup();
    const nf = await runtime.callTool('test_get_thing', { id: 'zz' }, opts);
    expect(nf.structuredContent).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const b = await runtime.callTool('test_boom', {}, opts);
    expect(b.structuredContent).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } });
    expect(b.text).not.toContain('secret token');
    expect(events.map((e) => e.error_code)).toEqual(['NOT_FOUND', 'UPSTREAM_ERROR']);
  });

  it('throws UnknownToolError for unknown tools (protocol error)', async () => {
    const { runtime } = setup();
    await expect(runtime.callTool('nope', {}, opts)).rejects.toBeInstanceOf(UnknownToolError);
  });
});

describe('format helpers', () => {
  it('converts money to minor units', () => {
    expect(toMoney(1234.5, 'inr')).toEqual({ amount_minor: 123450, currency: 'INR' });
    expect(toMoney(500, 'JPY')).toEqual({ amount_minor: 500, currency: 'JPY' });
    expect(toMoney(null, 'INR')).toBeNull();
  });

  it('round-trips cursors and rejects tampered ones', () => {
    const c = encodeCursor({ page: 3 });
    expect(decodeCursor<{ page: number }>(c).page).toBe(3);
    expect(() => decodeCursor('garbage')).toThrow(ConnectorError);
  });

  it('masks free text but keeps ids', () => {
    expect(maskArgs({ id: 'pay_DEMO8xK2', q: 'jane@example.com', limit: 5 })).toEqual({
      id: 'pay_DEMO8xK2',
      q: '<text:16>',
      limit: 5,
    });
  });
});
