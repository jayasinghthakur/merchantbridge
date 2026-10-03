import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Client } from '@modelcontextprotocol/client';
import type { MbStores } from '@mb/db';
import { createMemoryStores } from '@mb/db';
import { MemoryKv, systemClock } from '@mb/core';
import type { Clock } from '@mb/core';
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config';
import type { AppConfig } from '../src/config';
import type { AppContext } from '../src/context';
import { createAppContext } from '../src/context';
import { createLogger } from '../src/infra/logger';
import type { FetchHandler } from '../src/inprocess';
import { connectInProcess } from '../src/inprocess';

/** 32 zero-ish bytes, base64: a test-only vault key. */
export const TEST_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_STATE_SECRET = 'test-state-secret-0123456789-abcdefghijklmnop';
export const TEST_INVITE = 'let-me-in-please';
export const TEST_CLIENT_SECRET = 'zoho-client-secret-DO-NOT-LOG';

export const LIVE_ENV: Record<string, string> = {
  ZOHO_CLIENT_ID: '1000.TESTCLIENTID',
  ZOHO_CLIENT_SECRET: TEST_CLIENT_SECRET,
  ZOHO_REDIRECT_URI: 'http://localhost:8787/oauth/zoho/callback',
  MB_ENCRYPTION_KEY: TEST_VAULT_KEY,
  MB_STATE_SECRET: TEST_STATE_SECRET,
  MB_CONNECT_INVITE_CODE: TEST_INVITE,
};

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env });
}

/** Any outbound request a test did not plan for fails loudly (tests never touch the network). */
export const noNetwork: typeof fetch = (input) =>
  Promise.reject(
    new Error(
      `unexpected outbound fetch in test: ${String(input instanceof Request ? input.url : input)}`,
    ),
  );

export interface CapturedLogs {
  lines: string[];
  text(): string;
}

export function captureLogger(level = 'debug') {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const log = createLogger(level, false, stream);
  const logs: CapturedLogs = { lines, text: () => lines.join('') };
  return { log, logs };
}

export interface TestContextOptions {
  env?: Record<string, string>;
  fetch?: typeof fetch;
  anthropic?: () => Anthropic;
  clock?: Clock;
  stores?: MbStores;
  logLevel?: string;
}

export async function testContext(opts: TestContextOptions = {}) {
  const clock = opts.clock ?? systemClock;
  const { log, logs } = captureLogger(opts.logLevel ?? 'debug');
  const stores = opts.stores ?? createMemoryStores({ clock });
  const ctx: AppContext = await createAppContext(testConfig(opts.env), {
    fetch: opts.fetch ?? noNetwork,
    clock,
    kv: new MemoryKv(clock),
    stores,
    log,
    governorRandom: () => 0,
    usageFlushMs: 60_000,
    ...(opts.anthropic ? { anthropic: opts.anthropic } : {}),
  });
  return { ctx, logs, stores };
}

export function demoClient(
  handler: FetchHandler,
  opts: { session?: string; faults?: string[]; negotiation?: 'auto' | 'legacy' } = {},
): Promise<Client> {
  const headers: Record<string, string> = {};
  if (opts.session) headers['x-mb-session'] = opts.session;
  if (opts.faults) headers['x-mb-faults'] = opts.faults.join(',');
  return connectInProcess({
    handler,
    headers,
    clientName: 'api-test',
    clientVersion: '1.0.0',
    negotiation: opts.negotiation ?? 'auto',
  });
}

let seq = 0;
export function sessionId(prefix = 'test'): string {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A fetch that goes through `app.inject` (full Fastify route stack, no sockets). */
export function injectFetch(
  app: FastifyInstance,
  extra: { headers?: Record<string, string>; remoteAddress?: string } = {},
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    const url = new URL(req.url);
    const headers: Record<string, string> = { ...extra.headers };
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';
    const res = await app.inject({
      method: req.method as 'GET' | 'POST' | 'DELETE',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(hasBody ? { payload: await req.text() } : {}),
      ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
    });
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) outHeaders.append(k, item);
      else outHeaders.set(k, String(v));
    }
    const noBody = res.statusCode === 204 || res.statusCode === 304;
    return new Response(noBody ? null : res.rawPayload, {
      status: res.statusCode,
      headers: outHeaders,
    });
  };
}

/** MCP client over the Fastify routes (inject). */
export async function routeClient(
  app: FastifyInstance,
  path: string,
  opts: {
    headers?: Record<string, string>;
    negotiation?: 'auto' | 'legacy';
    remoteAddress?: string;
  } = {},
): Promise<Client> {
  const { Client: McpClient, StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/client');
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
    fetch: injectFetch(app, {
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
    }),
    ...(opts.headers ? { requestInit: { headers: opts.headers } } : {}),
  });
  const client = new McpClient(
    { name: 'route-test', version: '1.0.0' },
    { versionNegotiation: { mode: opts.negotiation ?? 'auto' } },
  );
  await client.connect(transport);
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON access in assertions
export type Json = any;

export function structured(res: { structuredContent?: unknown }): Json {
  return res.structuredContent as Json;
}
