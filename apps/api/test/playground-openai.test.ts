import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceEvent } from '@mb/core';
import { DEMO_IDS } from '@mb/core';
import { DEMO_TENANT_ID } from '@mb/db';
import { buildApp, createAppParts } from '../src/app';
import { DEFAULT_LLM_BASE_URL, loadConfig, resolveLlmSettings } from '../src/config';
import {
  LlmProviderError,
  parseResetDuration,
  retryAfterSeconds,
} from '../src/playground/llm-error';
import { runAgentOpenAI } from '../src/playground/openai-engine';
import { PLAYGROUND_DISABLED_MESSAGE, mapAgentError } from '../src/playground/route';
import { scriptedAnthropic } from './anthropic-fake';
import type { Json } from './helpers';
import { noNetwork, sessionId, testContext } from './helpers';
import type { OpenAiTurn } from './openai-fake';
import { OPENAI_ENV, TEST_LLM_BASE_URL, TEST_LLM_KEY, scriptedOpenAi } from './openai-fake';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

const TOOL_THEN_TEXT: OpenAiTurn[] = [
  {
    kind: 'tool_calls',
    calls: [{ id: 'call_01', name: 'zoho_get_item', arguments: { sku: 'CHAI-250' } }],
  },
  { kind: 'text', text: 'CHAI-250 is in stock in Bengaluru at ₹180.00.' },
];

async function setup(
  opts: { env?: Record<string, string>; script?: OpenAiTurn[]; fallback?: OpenAiTurn } = {},
) {
  const llm = scriptedOpenAi(opts.script ?? TOOL_THEN_TEXT, opts.fallback);
  const { ctx, logs } = await testContext({
    env: { ...OPENAI_ENV, ...opts.env },
    llmFetch: llm.fetch,
    fetch: noNetwork,
  });
  const parts = createAppParts(ctx);
  const app = await buildApp(ctx, parts);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { ctx, app, parts, llm, logs };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    message: 'Is CHAI-250 in stock in Bengaluru?',
    session_id: sessionId('oa'),
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

type ToolResultEvent = Extract<TraceEvent, { type: 'tool_result' }>;

describe('LLM provider selection (env contract)', () => {
  const settings = (env: Record<string, string>) =>
    loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env }).llm;

  it('defaults to openai when MB_LLM_API_KEY is set, anthropic when only ANTHROPIC_API_KEY is, else none', () => {
    expect(settings({ MB_LLM_API_KEY: TEST_LLM_KEY })).toEqual({
      provider: 'openai',
      model: 'llama-3.3-70b-versatile',
      baseUrl: DEFAULT_LLM_BASE_URL,
      hasKey: true,
    });
    expect(DEFAULT_LLM_BASE_URL).toBe('https://api.groq.com/openai/v1');
    expect(settings({ ANTHROPIC_API_KEY: 'sk-ant-test' })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      hasKey: true,
    });
    // Both keys: the free provider wins unless MB_LLM_PROVIDER says otherwise.
    expect(
      settings({ MB_LLM_API_KEY: TEST_LLM_KEY, ANTHROPIC_API_KEY: 'sk-ant-test' }).provider,
    ).toBe('openai');
    expect(
      settings({
        MB_LLM_PROVIDER: 'anthropic',
        MB_LLM_API_KEY: TEST_LLM_KEY,
        ANTHROPIC_API_KEY: 'sk-ant-test',
      }),
    ).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5', hasKey: true });
    expect(settings({})).toMatchObject({ provider: null, hasKey: false });
  });

  it('honours MB_PLAYGROUND_MODEL and MB_LLM_BASE_URL, and rejects an unknown provider', () => {
    expect(
      settings({
        MB_LLM_PROVIDER: 'OpenAI',
        MB_LLM_API_KEY: 'ollama',
        MB_LLM_BASE_URL: 'http://localhost:11434/v1/',
        MB_PLAYGROUND_MODEL: 'llama3.1:8b',
      }),
    ).toEqual({
      provider: 'openai',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
      hasKey: true,
    });
    expect(() => loadConfig({ NODE_ENV: 'test', MB_LLM_PROVIDER: 'cohere' })).toThrow(
      /MB_LLM_PROVIDER/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', MB_LLM_BASE_URL: 'not a url' })).toThrow(
      /MB_LLM_BASE_URL/,
    );
  });

  it('a selected provider without its key leaves the playground off', () => {
    const openaiNoKey = settings({ MB_LLM_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(openaiNoKey).toMatchObject({ provider: 'openai', hasKey: false });
    const anthropicNoKey = resolveLlmSettings({
      MB_LLM_PROVIDER: 'anthropic',
      MB_LLM_API_KEY: TEST_LLM_KEY,
      MB_LLM_BASE_URL: undefined,
      ANTHROPIC_API_KEY: undefined,
      MB_PLAYGROUND_MODEL: undefined,
    });
    expect(anthropicNoKey).toMatchObject({ provider: 'anthropic', hasKey: false });
    expect(
      loadConfig({
        NODE_ENV: 'test',
        MB_PLAYGROUND_ENABLED: 'true',
        MB_LLM_PROVIDER: 'openai',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      }).playgroundEnabled,
    ).toBe(false);
  });
});

describe('GET /api/status per provider', () => {
  it('reports the openai model and playground_enabled', async () => {
    const { app } = await setup();
    const status = (await app.inject({ url: '/api/status' })).json();
    expect(status).toMatchObject({ playground_enabled: true, model: 'llama-3.3-70b-versatile' });
  });

  it('reports a custom MB_PLAYGROUND_MODEL', async () => {
    const { app } = await setup({ env: { MB_PLAYGROUND_MODEL: 'gemini-2.5-flash' } });
    expect((await app.inject({ url: '/api/status' })).json().model).toBe('gemini-2.5-flash');
  });

  it('reports the anthropic model when Anthropic is the provider', async () => {
    const anthropic = scriptedAnthropic([]);
    const { ctx } = await testContext({
      env: { MB_PLAYGROUND_ENABLED: 'true' },
      anthropic: anthropic.factory,
    });
    const app = await buildApp(ctx);
    cleanup.push(
      () => ctx.close(),
      () => app.close(),
    );
    expect((await app.inject({ url: '/api/status' })).json()).toMatchObject({
      playground_enabled: true,
      model: 'claude-haiku-4-5',
    });
  });

  it('is disabled (503 on the route) when the selected provider has no key', async () => {
    const anthropic = scriptedAnthropic([]);
    const { ctx } = await testContext({
      env: { MB_PLAYGROUND_ENABLED: 'true', MB_LLM_PROVIDER: 'openai' },
      anthropic: anthropic.factory,
    });
    const app = await buildApp(ctx);
    cleanup.push(
      () => ctx.close(),
      () => app.close(),
    );
    expect((await app.inject({ url: '/api/status' })).json()).toMatchObject({
      playground_enabled: false,
      model: 'llama-3.3-70b-versatile',
    });
    const res = await app.inject({ method: 'POST', url: '/api/playground', payload: body() });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: 'PLAYGROUND_DISABLED', message: PLAYGROUND_DISABLED_MESSAGE },
    });
    expect(anthropic.requests).toHaveLength(0);
  });
});

describe('POST /api/playground on the OpenAI-compatible provider', () => {
  it('streams session → tool_call → tool_result → assistant_text → done against the real demo MCP endpoint', async () => {
    const { app, llm, ctx } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground',
      payload: body({ scenario_id: 'cod-stock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.payload);
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'tool_call',
      'tool_result',
      'assistant_text',
      'done',
    ]);
    expect(events[0]).toMatchObject({ type: 'session', model: 'llama-3.3-70b-versatile' });
    expect(events[1]).toMatchObject({
      call_id: 'call_01',
      tool: 'zoho_get_item',
      args: { sku: 'CHAI-250' },
    });
    const result = events[2] as ToolResultEvent;
    expect(result).toMatchObject({ call_id: 'call_01', is_error: false, error_code: null });
    expect(result.decisions.some((d) => d.type === 'admitted')).toBe(true);
    expect(result.upstream_calls).toBeGreaterThan(0);
    expect(typeof result.budget_remaining_today).toBe('number');
    expect(events[3]).toEqual({
      type: 'assistant_text',
      text: 'CHAI-250 is in stock in Bengaluru at ₹180.00.',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      stop_reason: 'end_turn',
      tool_calls: 1,
      input_tokens: 201 + 202,
      output_tokens: 31 + 32,
    });

    // What was sent to {MB_LLM_BASE_URL}/chat/completions.
    expect(llm.requests).toHaveLength(2);
    const first = llm.requests[0]!;
    expect(first.url).toBe(`${TEST_LLM_BASE_URL}/chat/completions`);
    expect(first.authorization).toBe(`Bearer ${TEST_LLM_KEY}`);
    expect(first.body).toMatchObject({
      model: 'llama-3.3-70b-versatile',
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.2,
    });
    expect(first.body.messages[0].role).toBe('system');
    expect(first.body.messages[1]).toEqual({
      role: 'user',
      content: 'Is CHAI-250 in stock in Bengaluru?',
    });
    const tools = first.body.tools as Json[];
    expect(
      tools.every((t) => t.type === 'function' && t.function.parameters.type === 'object'),
    ).toBe(true);
    expect(tools.some((t) => '$schema' in t.function.parameters)).toBe(false);
    expect(tools.map((t) => t.function.name)).toContain('zoho_get_item');
    const second = llm.requests[1]!.body.messages as Json[];
    expect(second.at(-2)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_01', function: { name: 'zoho_get_item' } }],
    });
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_01' });
    expect(second.at(-1).content).toContain('CHAI-250');
    expect(JSON.parse(second.at(-1).content).data.sku).toBe('CHAI-250');

    // A real demo MCP call: one usage event on the demo tenant.
    await ctx.usage.flush();
    const usage = await ctx.stores.usage.recent(DEMO_TENANT_ID, 10);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      tool: 'zoho_get_item',
      client_name: 'merchantbridge-playground',
    });
  });

  it('runs parallel tool_calls from one turn and answers each tool_call_id in order', async () => {
    const { app, llm } = await setup({
      script: [
        {
          kind: 'tool_calls',
          text: 'Checking both.',
          calls: [
            { id: 'call_a', name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } },
            {
              id: 'call_b',
              name: 'zoho_find_by_payment_reference',
              arguments: { reference: DEMO_IDS.paymentRef },
            },
          ],
        },
        { kind: 'text', text: 'Both found.' },
      ],
    });
    const events = parseSse(
      (await app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
    );
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'assistant_text',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'assistant_text',
      'done',
    ]);
    const results = events.filter((e): e is ToolResultEvent => e.type === 'tool_result');
    expect(results.map((r) => r.call_id).sort()).toEqual(['call_a', 'call_b']);
    expect(results.every((r) => !r.is_error)).toBe(true);
    const msgs = llm.requests[1]!.body.messages as Json[];
    expect(msgs.slice(-2).map((m) => [m.role, m.tool_call_id])).toEqual([
      ['tool', 'call_a'],
      ['tool', 'call_b'],
    ]);
    expect(msgs.at(-2).content).toContain(DEMO_IDS.sku);
    expect(msgs.at(-1).content).toContain(DEMO_IDS.paymentRef);
    expect(events.at(-1)).toMatchObject({ type: 'done', tool_calls: 2 });
  });

  it('maps a provider 429 to RATE_LIMITED with retry_after_s from the headers', async () => {
    const headerCases: Array<[Record<string, string>, number]> = [
      [{ 'retry-after': '7' }, 7],
      [{ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '7.66s' }, 8],
    ];
    for (const [headers, expected] of headerCases) {
      const { app, llm } = await setup({
        script: [
          {
            kind: 'error',
            status: 429,
            headers,
            body: {
              error: {
                message:
                  'Rate limit reached for model llama-3.3-70b-versatile on tokens per minute (TPM)',
                type: 'tokens',
                code: 'rate_limit_exceeded',
              },
            },
          },
        ],
      });
      const events = parseSse(
        (await app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
      );
      expect(events.map((e) => e.type)).toEqual(['session', 'error']);
      expect(events[1]).toEqual({
        type: 'error',
        code: 'RATE_LIMITED',
        message: 'The AI model is busy right now; try again shortly.',
        retry_after_s: expected,
      });
      // Waiting 7 s exceeds the playground's retry ceiling, so there is exactly one request.
      expect(llm.requests).toHaveLength(1);
    }
  });

  it('a per-minute token 429 on the second turn surfaces as RATE_LIMITED with retry_after_s, after the trace so far', async () => {
    // Groq's real TPM message links to its billing page; that must not be read as "quota spent".
    const groqTpm = (retryHeader: Record<string, string>): OpenAiTurn => ({
      kind: 'error',
      status: 429,
      headers: retryHeader,
      body: {
        error: {
          message:
            'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 9100, Requested 4100. Please try again in 6.02s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
          type: 'tokens',
          code: 'rate_limit_exceeded',
        },
      },
    });
    for (const [headers, expected] of [
      [{ 'retry-after': '7' }, 7],
      [{}, 7], // no header: "try again in 6.02s" from the body, rounded up
    ] as const) {
      const { app, llm } = await setup({ script: [TOOL_THEN_TEXT[0]!, groqTpm(headers)] });
      const events = parseSse(
        (await app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
      );
      expect(events.map((e) => e.type)).toEqual(['session', 'tool_call', 'tool_result', 'error']);
      expect(events.at(-1)).toEqual({
        type: 'error',
        code: 'RATE_LIMITED',
        message: 'The AI model is busy right now; try again shortly.',
        retry_after_s: expected,
      });
      expect(llm.requests).toHaveLength(2);
    }

    // Gemini's OpenAI endpoint says "exceeded your current quota" for per-minute limits too.
    const gemini = new LlmProviderError({
      kind: 'http',
      status: 429,
      body: JSON.stringify({
        error: {
          message:
            'You exceeded your current quota, please check your plan and billing details. Quota: GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ retryDelay: '17s' }],
        },
      }),
      message: 'x',
    });
    expect(mapAgentError(gemini)).toMatchObject({ code: 'RATE_LIMITED', retry_after_s: 17 });
  });

  it('retries a short per-minute 429 once (Retry-After ≤ the playground ceiling) and then answers', async () => {
    const { app, llm } = await setup({
      script: [
        {
          kind: 'error',
          status: 429,
          headers: { 'retry-after': '0' },
          body: { error: { message: 'on tokens per minute (TPM)', code: 'rate_limit_exceeded' } },
        },
        ...TOOL_THEN_TEXT,
      ],
    });
    const events = parseSse(
      (await app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', tool_calls: 1 });
    expect(llm.requests).toHaveLength(3);
  });

  it('maps spent quota or credits to BUDGET_EXHAUSTED', async () => {
    const quotaTurns: OpenAiTurn[] = [
      {
        kind: 'error',
        status: 429,
        body: {
          error: {
            message: 'You exceeded your current quota, please check your plan and billing details.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
      },
      {
        kind: 'error',
        status: 429,
        headers: { 'retry-after': '3600' },
        body: {
          error: {
            message:
              'Rate limit reached for model llama-3.3-70b-versatile on tokens per day (TPD): Limit 100000, Used 99990',
            code: 'rate_limit_exceeded',
          },
        },
      },
      { kind: 'error', status: 402, body: { error: { message: 'Insufficient credits' } } },
    ];
    for (const turn of quotaTurns) {
      const { app, llm } = await setup({ script: [turn] });
      const events = parseSse(
        (await app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
      );
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'BUDGET_EXHAUSTED' });
      expect(llm.requests).toHaveLength(1);
    }
  });

  it('maps 401 to INTERNAL and logs "LLM provider rejected the key" without the key', async () => {
    const { app, logs } = await setup({
      script: [
        {
          kind: 'error',
          status: 401,
          body: {
            error: {
              message: `Invalid API Key ${TEST_LLM_KEY}`,
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
        },
      ],
    });
    const res = await app.inject({ method: 'POST', url: '/api/playground', payload: body() });
    const events = parseSse(res.payload);
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'INTERNAL',
      message: 'The agent hit an unexpected error. Please try again.',
    });
    expect(res.payload).not.toContain(TEST_LLM_KEY);
    const logged = logs.text();
    expect(logged).toContain('LLM provider rejected the key');
    expect(logged).toContain('"status":401');
    expect(logged).not.toContain(TEST_LLM_KEY);
    expect(logged).not.toContain('gsk_');
  });

  it('maps 5xx (after one retry) and network failures to INTERNAL', async () => {
    const boom: OpenAiTurn = {
      kind: 'error',
      status: 503,
      body: { error: { message: `upstream boom (key ${TEST_LLM_KEY})` } },
    };
    const five = await setup({ script: [boom, boom] });
    const ev5 = parseSse(
      (await five.app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
    );
    expect(ev5.at(-1)).toMatchObject({ type: 'error', code: 'INTERNAL' });
    expect((ev5.at(-1) as { message: string }).message).not.toContain('boom');
    expect(five.llm.requests).toHaveLength(2);
    expect(five.logs.text()).toContain('playground run failed');
    expect(five.logs.text()).not.toContain(TEST_LLM_KEY);

    const net = await setup({ script: [{ kind: 'network' }, { kind: 'network' }] });
    const evN = parseSse(
      (await net.app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
    );
    expect(evN.at(-1)).toMatchObject({ type: 'error', code: 'INTERNAL' });
  });

  it('retries a 5xx once and then succeeds', async () => {
    const { app, llm } = await setup({
      script: [
        { kind: 'error', status: 500, body: { error: { message: 'x' } } },
        ...TOOL_THEN_TEXT,
      ],
    });
    const events = parseSse(
      (await app.inject({ method: 'POST', url: '/api/playground', payload: body() })).payload,
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', tool_calls: 1 });
    expect(llm.requests).toHaveLength(3);
  });

  it('aborts the provider request when the client disconnects', async () => {
    const { app, llm } = await setup({ script: [{ kind: 'hang' }] });
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
    for (let i = 0; i < 100 && llm.requests.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(llm.requests).toHaveLength(1);
    controller.abort();
    for (let i = 0; i < 200 && llm.aborted.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(llm.aborted).toEqual([true]);
  });
});

describe('runAgentOpenAI (shared with evals)', () => {
  async function engine(
    script: OpenAiTurn[],
    extra: { maxToolCalls?: number; maxInputTokens?: number } = {},
  ) {
    const { parts } = await setup({ script: [] });
    const llm = scriptedOpenAi(script);
    const events: TraceEvent[] = [];
    const result = await runAgentOpenAI({
      message: 'Stock of CHAI-250?',
      session: sessionId('oae'),
      faults: [],
      mcpHandler: parts.demo.handler,
      onEvent: (e) => events.push(e),
      llm: {
        baseUrl: TEST_LLM_BASE_URL,
        apiKey: TEST_LLM_KEY,
        model: 'llama-3.3-70b-versatile',
        fetch: llm.fetch,
      },
      ...extra,
    });
    return { result, events, llm };
  }

  it('caps tool calls per question: calls past the cap never reach MCP and come back as error text', async () => {
    const call = (id: string) => ({ id, name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
    const { result, events, llm } = await engine(
      [
        { kind: 'tool_calls', calls: [call('c1'), call('c2'), call('c3')] },
        { kind: 'text', text: 'done' },
      ],
      { maxToolCalls: 2 },
    );
    // The refused call is recorded synchronously; the two real ones when MCP answers.
    expect(result.toolCalls.map((c) => [c.call_id, c.is_error]).sort()).toEqual([
      ['c1', false],
      ['c2', false],
      ['c3', true],
    ]);
    const refused = events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result' && e.call_id === 'c3',
    );
    expect(refused).toMatchObject({ is_error: true, error_code: null, upstream_calls: 0 });
    const tools = (llm.requests[1]!.body.messages as Json[]).filter((m) => m.role === 'tool');
    expect(tools.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
    expect(tools[2].content).toContain('tool-call budget');
    expect(result.finalText).toBe('done');
  });

  it('answers invalid tool-argument JSON with an error result instead of crashing', async () => {
    const { result, events, llm } = await engine([
      {
        kind: 'tool_calls',
        calls: [{ id: 'bad', name: 'zoho_get_item', arguments: '{"sku": "CHAI-' }],
      },
      {
        kind: 'tool_calls',
        calls: [{ id: 'good', name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } }],
      },
      { kind: 'text', text: 'CHAI-250: 38 available.' },
    ]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.toolCalls).toEqual([
      {
        call_id: 'bad',
        tool: 'zoho_get_item',
        args: {},
        is_error: true,
        error_code: 'INVALID_INPUT',
      },
      expect.objectContaining({ call_id: 'good', is_error: false }),
    ]);
    const badResult = events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result' && e.call_id === 'bad',
    );
    expect(badResult).toMatchObject({ is_error: true, error_code: 'INVALID_INPUT' });
    const reply = (llm.requests[1]!.body.messages as Json[]).at(-1);
    expect(reply).toMatchObject({ role: 'tool', tool_call_id: 'bad' });
    expect(reply.content).toMatch(/not valid JSON/);
  });

  it('answers an unknown tool name with an error result', async () => {
    const { result, llm } = await engine([
      { kind: 'tool_calls', calls: [{ id: 'x', name: 'zoho_cancel_sales_order', arguments: {} }] },
      { kind: 'text', text: 'I can only read.' },
    ]);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'zoho_cancel_sales_order', is_error: true }),
    ]);
    expect((llm.requests[1]!.body.messages as Json[]).at(-1).content).toMatch(/no tool named/);
  });

  it('passes the governor error body to the model when a fault is on', async () => {
    const { parts } = await setup({ script: [] });
    const llm = scriptedOpenAi(TOOL_THEN_TEXT);
    const events: TraceEvent[] = [];
    const result = await runAgentOpenAI({
      message: 'Stock of CHAI-250?',
      session: sessionId('oaf'),
      faults: ['rate_limit_44'],
      mcpHandler: parts.demo.handler,
      onEvent: (e) => events.push(e),
      llm: { baseUrl: TEST_LLM_BASE_URL, apiKey: TEST_LLM_KEY, model: 'm', fetch: llm.fetch },
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'zoho_get_item',
        is_error: true,
        error_code: 'RATE_LIMITED',
      }),
    ]);
    const tr = events.find((e): e is ToolResultEvent => e.type === 'tool_result');
    expect(tr?.decisions.some((d) => d.type === 'circuit_open')).toBe(true);
    expect((llm.requests[1]!.body.messages as Json[]).at(-1).content).toContain('RATE_LIMITED');
  });

  it('stops before the next request once the input-token budget is spent, and at the iteration cap', async () => {
    const loop: OpenAiTurn[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'tool_calls' as const,
      calls: [{ id: `l${i}`, name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } }],
    }));
    const tok = await engine(loop, { maxInputTokens: 300 });
    // 201 + 202 ≥ 300 after the second response: its tool call never runs.
    expect(tok.llm.requests).toHaveLength(2);
    expect(tok.result).toMatchObject({ stopReason: 'tool_use', inputTokens: 403 });
    expect(tok.result.toolCalls).toHaveLength(1);

    const cap = await engine(loop);
    expect(cap.llm.requests).toHaveLength(6);
    expect(cap.result.stopReason).toBe('tool_use');
    expect(cap.events.at(-1)).toMatchObject({ type: 'done', stop_reason: 'tool_use' });
  });

  it('maps finish_reason length/content_filter to max_tokens/refusal and splits long answers', async () => {
    const long = 'word '.repeat(100).trim();
    const { result, events } = await engine([{ kind: 'text', text: long, finishReason: 'length' }]);
    expect(result.stopReason).toBe('max_tokens');
    const texts = events.filter((e) => e.type === 'assistant_text');
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.map((e) => (e as { text: string }).text).join('')).toBe(long);
    const refusal = await engine([{ kind: 'text', text: 'no', finishReason: 'content_filter' }]);
    expect(refusal.result.stopReason).toBe('refusal');
  });
});

describe('provider error helpers', () => {
  it('parses OpenAI/Groq reset durations', () => {
    expect(parseResetDuration('7.66s')).toBeCloseTo(7.66);
    expect(parseResetDuration('2m59.56s')).toBeCloseTo(179.56);
    expect(parseResetDuration('1h2m3s')).toBe(3723);
    expect(parseResetDuration('120ms')).toBeCloseTo(0.12);
    expect(parseResetDuration('12')).toBe(12);
    expect(parseResetDuration('soon')).toBeNull();
    expect(
      retryAfterSeconds(
        new Headers({ 'x-ratelimit-reset-requests': '2m', 'x-ratelimit-reset-tokens': '5s' }),
      ),
    ).toBe(5);
  });

  it('never keeps the key in an error message', () => {
    const e = new LlmProviderError({ kind: 'network', message: 'x' });
    expect(mapAgentError(e)).toMatchObject({ code: 'INTERNAL' });
    expect(mapAgentError(new Error('other'))).toMatchObject({ code: 'INTERNAL' });
  });
});
