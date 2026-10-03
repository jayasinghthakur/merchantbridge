import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceEvent } from '@mb/core';
import { DEMO_TENANT_ID } from '@mb/db';
import { buildApp, createAppParts } from '../src/app';
import { runAgent } from '../src/playground/engine';
import { PLAYGROUND_DISABLED_MESSAGE } from '../src/playground/route';
import { scriptedAnthropic } from './anthropic-fake';
import type { ScriptedTurn } from './anthropic-fake';
import { noNetwork, sessionId, testContext } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

const ENABLED = { MB_PLAYGROUND_ENABLED: 'true' };

const TOOL_THEN_TEXT: ScriptedTurn[] = [
  { kind: 'tool_use', id: 'toolu_01', name: 'zoho_get_item', input: { sku: 'CHAI-250' } },
  { kind: 'text', text: 'CHAI-250 is in stock in Bengaluru at ₹180.00.' },
];

async function setup(
  opts: {
    env?: Record<string, string>;
    script?: ScriptedTurn[];
    fetch?: typeof fetch;
    noAnthropic?: boolean;
  } = {},
) {
  const anthropic = scriptedAnthropic(opts.script ?? TOOL_THEN_TEXT);
  const { ctx, logs } = await testContext({
    env: { ...ENABLED, ...opts.env },
    ...(opts.noAnthropic ? {} : { anthropic: anthropic.factory }),
    fetch: opts.fetch ?? noNetwork,
  });
  const parts = createAppParts(ctx);
  const app = await buildApp(ctx, parts);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { ctx, app, parts, anthropic, logs };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    message: 'Is CHAI-250 in stock in Bengaluru?',
    session_id: sessionId('pg'),
    faults: [],
    ...overrides,
  };
}

function parseSse(payload: string): TraceEvent[] {
  return payload
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as TraceEvent);
}

describe('POST /api/playground', () => {
  it('503 PLAYGROUND_DISABLED when the kill switch is off or no key is configured', async () => {
    for (const opts of [{ env: { MB_PLAYGROUND_ENABLED: 'false' } }, { noAnthropic: true }]) {
      const { app } = await setup(opts);
      const res = await app.inject({ method: 'POST', url: '/api/playground', payload: body() });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        error: { code: 'PLAYGROUND_DISABLED', message: PLAYGROUND_DISABLED_MESSAGE },
      });
    }
  });

  it('400 on a bad body', async () => {
    const { app, anthropic } = await setup();
    const bad = [
      body({ message: 'x'.repeat(501) }),
      body({ message: '' }),
      body({ session_id: 'short' }),
      body({ faults: ['drop_tables'] }),
      body({ scenario_id: 'no-such-card' }),
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/playground', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    }
    expect(anthropic.requests).toHaveLength(0);
  });

  it('429 RATE_LIMITED after 10 questions per 10 minutes from one IP', async () => {
    const { app } = await setup({ script: [] });
    for (let i = 0; i < 10; i++) {
      const ok = await app.inject({ method: 'POST', url: '/api/playground', payload: body() });
      expect(ok.statusCode).toBe(200);
    }
    const res = await app.inject({ method: 'POST', url: '/api/playground', payload: body() });
    expect(res.statusCode).toBe(429);
    const err = res.json().error;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retry_after_s).toBeGreaterThan(0);
    // Another IP still gets through.
    const other = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body(),
      remoteAddress: '198.51.100.7',
    });
    expect(other.statusCode).toBe(200);
  });

  it('429 when the global daily cap is reached', async () => {
    const { app } = await setup({ script: [], env: { MB_PLAYGROUND_DAILY_CAP: '2' } });
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/playground',
        payload: body(),
        remoteAddress: `198.51.100.${i + 1}`,
      });
      expect(ok.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body(),
      remoteAddress: '198.51.100.99',
    });
    expect(res.statusCode).toBe(429);
  });

  it('requires a valid Turnstile token on the first message of a session', async () => {
    const verifications: string[] = [];
    const turnstileFetch: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://challenges.cloudflare.com/')) return noNetwork(input, init);
      const raw = init?.body;
      const params =
        raw instanceof URLSearchParams
          ? raw
          : new URLSearchParams(typeof raw === 'string' ? raw : '');
      verifications.push(params.get('response') ?? '');
      return new Response(JSON.stringify({ success: params.get('response') === 'good-token' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const { app } = await setup({
      script: [],
      env: { TURNSTILE_SECRET_KEY: 'ts-secret' },
      fetch: turnstileFetch,
    });
    const session = sessionId('ts');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body({ session_id: session }),
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('BAD_REQUEST');
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body({ session_id: session, turnstile_token: 'bad-token' }),
    });
    expect(wrong.statusCode).toBe(403);
    const good = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body({ session_id: session, turnstile_token: 'good-token' }),
    });
    expect(good.statusCode).toBe(200);
    // Verified for the session: the next message needs no token.
    const next = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body({ session_id: session }),
    });
    expect(next.statusCode).toBe(200);
    expect(verifications).toEqual(['bad-token', 'good-token']);
  });

  it('streams session → tool_call → tool_result → assistant_text → done', async () => {
    const { app, anthropic, ctx } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body({ scenario_id: 'cod-stock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseSse(res.payload);
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'tool_call',
      'tool_result',
      'assistant_text',
      'assistant_text',
      'done',
    ]);
    const call = events[1] as Extract<TraceEvent, { type: 'tool_call' }>;
    expect(call).toMatchObject({
      call_id: 'toolu_01',
      tool: 'zoho_get_item',
      args: { sku: 'CHAI-250' },
    });
    const result = events[2] as Extract<TraceEvent, { type: 'tool_result' }>;
    expect(result).toMatchObject({ call_id: 'toolu_01', is_error: false, error_code: null });
    expect(result.decisions.some((d) => d.type === 'admitted')).toBe(true);
    expect(result.upstream_calls).toBeGreaterThan(0);
    expect(typeof result.budget_remaining_today).toBe('number');
    const done = events.at(-1) as Extract<TraceEvent, { type: 'done' }>;
    expect(done).toMatchObject({ stop_reason: 'end_turn', tool_calls: 1 });
    expect(done.input_tokens).toBeGreaterThan(0);

    // What the runner sent to the Messages API.
    expect(anthropic.requests).toHaveLength(2);
    const first = anthropic.requests[0]!;
    expect(first.model).toBe('claude-haiku-4-5');
    expect(first.max_tokens).toBe(1024);
    expect(first.tool_choice).toEqual({ type: 'auto' });
    expect(first.stream).toBe(true);
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral' });
    const names = (
      first.tools as Array<{ name: string; input_schema: Record<string, unknown> }>
    ).map((t) => t.name);
    expect(names).toContain('zoho_get_item');
    expect(
      first.tools.every(
        (t: { input_schema: Record<string, unknown> }) => !('$schema' in t.input_schema),
      ),
    ).toBe(true);
    const toolResult = anthropic.requests[1]!.messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_01' });
    expect(JSON.stringify(toolResult.content)).toContain('CHAI-250');

    // The tool call is a real demo MCP call: one usage event on the demo tenant.
    await ctx.usage.flush();
    const usage = await ctx.stores.usage.recent(DEMO_TENANT_ID, 10);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      tool: 'zoho_get_item',
      client_name: 'merchantbridge-playground',
    });
  });

  it('maps Anthropic failures to SSE error events', async () => {
    const cases: Array<[ScriptedTurn, string]> = [
      [
        {
          kind: 'error',
          status: 429,
          body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
          headers: { 'retry-after': '7' },
        },
        'RATE_LIMITED',
      ],
      [
        {
          kind: 'error',
          status: 400,
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'You have reached your specified workspace API usage limits.',
            },
          },
        },
        'BUDGET_EXHAUSTED',
      ],
      [
        {
          kind: 'error',
          status: 500,
          body: { type: 'error', error: { type: 'api_error', message: 'boom' } },
        },
        'INTERNAL',
      ],
    ];
    for (const [turn, code] of cases) {
      const { app } = await setup({ script: [turn] });
      const res = await app.inject({ method: 'POST', url: '/api/playground', payload: body() });
      const events = parseSse(res.payload);
      expect(events[0]?.type).toBe('session');
      const err = events.at(-1) as Extract<TraceEvent, { type: 'error' }>;
      expect(err).toMatchObject({ type: 'error', code });
      if (code === 'RATE_LIMITED') expect(err.retry_after_s).toBe(7);
      expect(err.message).not.toContain('boom');
    }
  });

  it('aborts the run when the client disconnects', async () => {
    const { app, anthropic } = await setup({ script: [{ kind: 'hang' }] });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/playground`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('"type":"session"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    // Wait until the (hanging) Anthropic request is in flight, then disconnect.
    for (let i = 0; i < 100 && anthropic.requests.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(anthropic.requests).toHaveLength(1);
    controller.abort();
    for (let i = 0; i < 200 && anthropic.aborted.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(anthropic.aborted).toEqual([true]);
  });
});

describe('runAgent (shared with evals)', () => {
  it('returns tool calls, usage and final text, and refuses writes without tools when the model does', async () => {
    const { ctx, parts } = await setup({
      script: [{ kind: 'text', text: 'I can only read Zoho Inventory.' }],
    });
    const scripted = scriptedAnthropic([
      { kind: 'text', text: 'I can only read Zoho Inventory; cancel it in Zoho.' },
    ]);
    const events: TraceEvent[] = [];
    const result = await runAgent({
      message: 'Cancel SO-00012.',
      session: sessionId('eval'),
      faults: [],
      model: 'claude-haiku-4-5',
      anthropic: scripted.client,
      mcpHandler: parts.demo.handler,
      onEvent: (e) => events.push(e),
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toContain('only read');
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe('done');
    void ctx;
  });

  it('reports a governor rejection in the trace when a fault is on', async () => {
    const { parts } = await setup();
    const scripted = scriptedAnthropic(TOOL_THEN_TEXT);
    const events: TraceEvent[] = [];
    const result = await runAgent({
      message: 'Stock of CHAI-250?',
      session: sessionId('eval'),
      faults: ['rate_limit_44'],
      model: 'claude-haiku-4-5',
      anthropic: scripted.client,
      mcpHandler: parts.demo.handler,
      onEvent: (e) => events.push(e),
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'zoho_get_item',
        is_error: true,
        error_code: 'RATE_LIMITED',
      }),
    ]);
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      TraceEvent,
      { type: 'tool_result' }
    >;
    expect(tr.decisions.some((d) => d.type === 'circuit_open')).toBe(true);
    // The model saw an is_error tool_result carrying our JSON error body.
    const sent = scripted.requests[1]!.messages.at(-1).content[0];
    expect(sent.is_error).toBe(true);
    expect(JSON.stringify(sent.content)).toContain('RATE_LIMITED');
  });
});
