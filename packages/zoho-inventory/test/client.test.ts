import { ConnectorError, UpstreamError } from '@mb/core';
import { describe, expect, it } from 'vitest';
import type { ZohoTokenSource } from '../src/client';
import { createZohoApi } from '../src/client';
import { DEMO_ORGANIZATION_ID, createDemoDataset } from '../src/fake/dataset';
import { createFakeZoho } from '../src/fake/server';
import { MapCache, NOW, StubGovernor, apiDeps, captureLogger } from './helpers';

const SECRET = 'secret-token-123';

interface Captured {
  url: string;
  method: string;
  auth: string | null;
}

/** A fetch that replays canned responses (the last one repeats) and records every request. */
function scripted(...responses: (() => Response)[]) {
  const seen: Captured[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
    });
    const next = responses[Math.min(seen.length - 1, responses.length - 1)];
    if (!next) throw new Error('no scripted response');
    return Promise.resolve(next());
  };
  return { fetch: fetchFn, seen };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

function staticTokens(): ZohoTokenSource & { refreshes: string[] } {
  let current = SECRET;
  const refreshes: string[] = [];
  return {
    refreshes,
    get: () => Promise.resolve(current),
    refreshAfterUnauthorized: (failed) => {
      refreshes.push(failed);
      current = `${SECRET}-fresh`;
      return Promise.resolve(current);
    },
  };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('ZohoClient request building', () => {
  it('issues GET with the Zoho-oauthtoken header and adds organization_id', async () => {
    const s = scripted(json(200, { code: 0, message: 'success', items: [] }));
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens() }));
    const res = await api.get('items', { search_text: 'chai', page: 1 });
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]?.method).toBe('GET');
    expect(s.seen[0]?.auth).toBe(`Zoho-oauthtoken ${SECRET}`);
    const url = new URL(s.seen[0]?.url ?? '');
    expect(url.pathname).toBe('/inventory/v1/items');
    expect(url.searchParams.get('organization_id')).toBe(DEMO_ORGANIZATION_ID);
    expect(url.searchParams.get('search_text')).toBe('chai');
    expect(res.url).not.toContain('?');
    expect(res.cached).toBe(false);
  });

  it('omits organization_id on organizations endpoints', async () => {
    const s = scripted(json(200, { code: 0, organizations: [] }));
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens() }));
    await api.get('organizations');
    await api.get(`organizations/${DEMO_ORGANIZATION_ID}`);
    for (const r of s.seen) expect(new URL(r.url).searchParams.has('organization_id')).toBe(false);
  });

  it.each([
    'items/../contacts',
    'salesorders/1/status/void',
    'settings/locations/enable',
    'items?organization_id=1',
    'invoices/abc/def',
    'invoices/a b',
    'users',
    'shipmentorders',
    '',
    'https://evil.example/items',
  ])('rejects disallowed path %j before any fetch', async (path) => {
    const s = scripted(json(200, { code: 0 }));
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens() }));
    const err = await caught(api.get(path));
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).retryable).toBe(false);
    expect(s.seen).toHaveLength(0);
  });

  it.each(['organization_id', 'authtoken', 'Bad-Key', 'a=b'])(
    'rejects query key %j',
    async (key) => {
      const s = scripted(json(200, { code: 0 }));
      const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens() }));
      await expect(api.get('items', { [key]: 'x' })).rejects.toBeInstanceOf(ConnectorError);
      expect(s.seen).toHaveLength(0);
    },
  );

  it('refuses a live connection whose apiDomain is not a Zoho API host', () => {
    const s = scripted(json(200, { code: 0 }));
    const live = {
      mode: 'live' as const,
      dc: 'in',
      scopes: [],
      organizationName: null,
      plan: null,
    };
    expect(() =>
      createZohoApi(
        apiDeps({
          fetch: s.fetch,
          tokens: staticTokens(),
          apiDomain: 'https://evil.example',
          connection: live,
        }),
      ),
    ).toThrow();
    expect(() =>
      createZohoApi(
        apiDeps({
          fetch: s.fetch,
          tokens: staticTokens(),
          apiDomain: 'https://www.zohoapis.in',
          connection: live,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createZohoApi(
        apiDeps({
          fetch: s.fetch,
          tokens: staticTokens(),
          apiDomain: 'http://www.zohoapis.in',
          connection: live,
        }),
      ),
    ).toThrow();
  });

  it('builds web deep links and exposes info and snapshot', async () => {
    const s = scripted(json(200, { code: 0 }));
    const governor = new StubGovernor();
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens(), governor }));
    expect(api.webUrl('salesorder', '123')).toBe(
      `https://inventory.zoho.in/app/${DEMO_ORGANIZATION_ID}#/salesorders/123`,
    );
    expect(api.webUrl('organization')).toBe(
      `https://inventory.zoho.in/app/${DEMO_ORGANIZATION_ID}`,
    );
    expect(api.info()).toMatchObject({ mode: 'demo', dc: 'in', plan: 'free' });
    await expect(api.snapshot()).resolves.toMatchObject({ circuit: 'closed', daily_budget: 500 });
  });
});

describe('ZohoClient error mapping', () => {
  const cases: [string, () => Response, (e: unknown) => void][] = [
    [
      'HTTP 200 with code≠0 (1002) → NOT_FOUND',
      json(200, { code: 1002, message: 'Invoice does not exist.' }),
      (e) => expect(e).toMatchObject({ code: 'NOT_FOUND' }),
    ],
    [
      'HTTP 200 with code 57 → SCOPE_NOT_GRANTED',
      json(200, { code: 57, message: 'You are not authorized to perform this operation' }),
      (e) => expect(e).toMatchObject({ code: 'SCOPE_NOT_GRANTED' }),
    ],
    [
      'HTTP 200 with an unknown non-zero code → UPSTREAM_ERROR (not retryable)',
      json(200, { code: 9999, message: 'weird' }),
      (e) => expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false }),
    ],
    [
      'HTTP 200 with an unknown code but a "does not exist" message → NOT_FOUND',
      json(200, { code: 4242, message: 'Sales Order does not exist.' }),
      (e) => expect(e).toMatchObject({ code: 'NOT_FOUND' }),
    ],
    [
      'HTTP 200 with code 44 → rate_limit_minute',
      json(200, { code: 44, message: 'blocked' }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'rate_limit_minute' }),
    ],
    [
      'HTTP 200 with code 45 → rate_limit_daily',
      json(200, { code: 45, message: 'daily' }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'rate_limit_daily' }),
    ],
    [
      'HTTP 200 with code 1070 → concurrency',
      json(200, { code: 1070, message: 'in process' }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'concurrency' }),
    ],
    [
      'HTTP 200 without a code → unreadable',
      json(200, { items: [] }),
      (e) => expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false }),
    ],
    [
      '429 code 44 → rate_limit_minute',
      json(429, { code: 44, message: 'blocked' }, { 'retry-after': '30' }),
      (e) => {
        expect(e).toBeInstanceOf(UpstreamError);
        expect((e as UpstreamError).failure).toEqual({ kind: 'rate_limit_minute' });
        expect((e as UpstreamError).retryAfterS).toBe(30);
      },
    ],
    [
      '429 code 45 → rate_limit_daily',
      json(429, { code: 45, message: 'daily' }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'rate_limit_daily' }),
    ],
    [
      '429 code 1070 → concurrency',
      json(429, { code: 1070, message: 'in process' }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'concurrency' }),
    ],
    [
      'other 429 → concurrency',
      json(429, { code: 1, message: '?' }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'concurrency' }),
    ],
    [
      '503 with an HTML body → server',
      () => new Response('<html>down</html>', { status: 503 }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'server', status: 503 }),
    ],
    [
      '500 JSON → server',
      json(500, { code: 1, message: 'boom' }),
      (e) => expect((e as UpstreamError).failure).toEqual({ kind: 'server', status: 500 }),
    ],
    [
      '404 → NOT_FOUND',
      json(404, { code: 5, message: 'Invalid URL Passed' }),
      (e) => expect(e).toMatchObject({ code: 'NOT_FOUND' }),
    ],
    [
      '403 → SCOPE_NOT_GRANTED',
      json(403, { code: 1, message: 'nope' }),
      (e) => expect(e).toMatchObject({ code: 'SCOPE_NOT_GRANTED' }),
    ],
    [
      '400 → INVALID_INPUT with a generic message',
      json(400, { code: 2, message: `Invalid value passed for organization_id ${SECRET}` }),
      (e) => {
        expect(e).toMatchObject({ code: 'INVALID_INPUT' });
        expect((e as Error).message).not.toContain('organization_id');
      },
    ],
    [
      '405 → UPSTREAM_ERROR (not retryable)',
      json(405, { code: 37, message: 'no' }),
      (e) => expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false }),
    ],
    [
      'malformed JSON on 200 → unreadable response',
      () => new Response('{"code":0,"items":[', { status: 200 }),
      (e) => {
        expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
        expect((e as Error).message).toContain('unreadable');
      },
    ],
  ];

  it.each(cases)('%s', async (_name, response, check) => {
    const s = scripted(response);
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens() }));
    const err = await caught(api.get('invoices/123'));
    check(err);
    const text = JSON.stringify({ m: (err as Error).message, h: (err as ConnectorError).hint });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('https://');
    expect(text).not.toContain('organization_id=');
  });

  it('accepts code 0 with extra fields as success', async () => {
    const s = scripted(
      json(200, { code: 0, message: 'success', invoice: { invoice_id: '1' }, extra: { x: 1 } }),
    );
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens() }));
    const res = await api.get<{ invoice: { invoice_id: string } }>('invoices/1');
    expect(res.body.invoice.invoice_id).toBe('1');
  });

  it('maps a network TypeError to UpstreamError network', async () => {
    const fetchFn = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const api = createZohoApi(apiDeps({ fetch: fetchFn, tokens: staticTokens() }));
    const err = await caught(api.get('items'));
    expect((err as UpstreamError).failure).toEqual({ kind: 'network' });
  });

  it('maps an aborted attempt to UpstreamError timeout', async () => {
    const fake = createFakeZoho({ dataset: createDemoDataset({ now: NOW }), latencyMs: 200 });
    const governor = new StubGovernor({ signal: () => AbortSignal.timeout(5) });
    const api = createZohoApi(apiDeps({ fetch: fake.fetch, tokens: fake.tokens, governor }));
    const err = await caught(api.get('items'));
    expect((err as UpstreamError).failure).toEqual({ kind: 'timeout' });
  });

  it('runs every attempt inside governor.schedule and reports its decisions', async () => {
    const s = scripted(json(503, {}), json(200, { code: 0, items: [] }));
    const governor = new StubGovernor({ retries: 2 });
    const decisions: string[] = [];
    const api = createZohoApi(
      apiDeps({
        fetch: s.fetch,
        tokens: staticTokens(),
        governor,
        note: (d) => decisions.push(d.type),
      }),
    );
    await api.get('items');
    expect(governor.attempts).toBe(2);
    expect(decisions).toEqual(['admitted', 'retried', 'admitted']);
  });
});

describe('ZohoClient token refresh', () => {
  it('401 → refreshes once with the failed token → retries once → success', async () => {
    const s = scripted(
      json(401, { code: 57, message: 'unauthorized' }),
      json(200, { code: 0, items: [] }),
    );
    const tokens = staticTokens();
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens }));
    await api.get('items');
    expect(tokens.refreshes).toEqual([SECRET]);
    expect(s.seen.map((r) => r.auth)).toEqual([
      `Zoho-oauthtoken ${SECRET}`,
      `Zoho-oauthtoken ${SECRET}-fresh`,
    ]);
  });

  it('a second 401 → RECONNECT_REQUIRED without further refreshes', async () => {
    const s = scripted(json(401, { code: 57, message: 'unauthorized' }));
    const tokens = staticTokens();
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens }));
    const err = await caught(api.get('items'));
    expect(err).toMatchObject({ code: 'RECONNECT_REQUIRED', retryable: false });
    expect(tokens.refreshes).toHaveLength(1);
    expect(s.seen).toHaveLength(2);
  });

  it('treats invalid-token body code 14 like a 401', async () => {
    const s = scripted(
      json(200, { code: 14, message: 'Invalid value passed for authtoken' }),
      json(200, { code: 0 }),
    );
    const tokens = staticTokens();
    await createZohoApi(apiDeps({ fetch: s.fetch, tokens })).get('items');
    expect(tokens.refreshes).toHaveLength(1);
  });

  it('a refresh failure becomes RECONNECT_REQUIRED and leaks nothing', async () => {
    const s = scripted(json(401, { code: 57, message: 'unauthorized' }));
    const tokens: ZohoTokenSource = {
      get: () => Promise.resolve(SECRET),
      refreshAfterUnauthorized: () => Promise.reject(new Error(`invalid_grant for ${SECRET}`)),
    };
    const err = await caught(createZohoApi(apiDeps({ fetch: s.fetch, tokens })).get('items'));
    expect(err).toMatchObject({ code: 'RECONNECT_REQUIRED' });
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('works end-to-end against FakeZoho expired_token', async () => {
    const fake = createFakeZoho({
      dataset: createDemoDataset({ now: NOW }),
      faults: () => new Set(['expired_token']),
    });
    const before = await fake.tokens.get();
    const api = createZohoApi(apiDeps({ fetch: fake.fetch, tokens: fake.tokens }));
    await api.get('items');
    expect(await fake.tokens.get()).not.toBe(before);
    expect(fake.calls).toBe(2);
  });
});

describe('ZohoClient cache + logging', () => {
  it('caches items/org reads but never orders, invoices or payments', async () => {
    const s = scripted(json(200, { code: 0, items: [], invoices: [] }));
    const cache = new MapCache();
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens(), cache }));
    const a = await api.get('items', { sku: 'X' }, { cacheTtlMs: 60_000 });
    const b = await api.get('items', { sku: 'X' }, { cacheTtlMs: 60_000 });
    expect([a.cached, b.cached]).toEqual([false, true]);
    await api.get('invoices', undefined, { cacheTtlMs: 60_000 });
    await api.get('invoices', undefined, { cacheTtlMs: 60_000 });
    expect(s.seen).toHaveLength(3);
    expect([...cache.store.keys()].every((k) => k.startsWith('demo:test:'))).toBe(true);
  });

  it('logs at debug without tokens or query strings', async () => {
    const s = scripted(json(401, {}), json(200, { code: 0, items: [] }));
    const { log, lines } = captureLogger();
    const api = createZohoApi(apiDeps({ fetch: s.fetch, tokens: staticTokens(), log }));
    await api.get('items', { email: 'jane@example.com' });
    expect(lines.length).toBeGreaterThan(0);
    const dump = JSON.stringify(lines);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('jane@example.com');
    expect(dump).not.toContain('organization_id');
  });
});
