import type { ConnectionRecord, Kv } from '@mb/core';
import { ConnectorError, ManualClock, MemoryKv, noopLogger } from '@mb/core';
import { describe, expect, it } from 'vitest';
import {
  createAccessTokenProvider,
  createTokenVault,
  createZohoOAuthClient,
  tokenCacheKey,
  type AccessTokenProviderOptions,
} from '../src/index';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  FakeAccounts,
  InMemoryConnectionStore,
  REDIRECT_URI,
  VAULT_KEY,
  connectionInput,
  delegatingKv,
} from './fakes';

async function setup(overrides: Partial<AccessTokenProviderOptions> = {}) {
  const clock = new ManualClock();
  const kv = new MemoryKv(clock);
  const fake = new FakeAccounts();
  const vault = createTokenVault(VAULT_KEY);
  const connections = new InMemoryConnectionStore();
  const oauth = createZohoOAuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetch: fake.fetch,
  });
  const provider = createAccessTokenProvider({
    kv,
    clock,
    vault,
    connections,
    oauth,
    log: noopLogger,
    ...overrides,
  });
  const refreshToken = fake.issueRefreshToken();
  const conn = await connections.upsert(connectionInput(vault, refreshToken));
  return { clock, kv, fake, vault, connections, provider, conn, refreshToken };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('getAccessToken', () => {
  it('20 parallel calls with an empty cache make exactly 1 token request', async () => {
    // ManualClock adds every waiter's sleep to one shared timeline (19 waiters × polls), unlike real time;
    // a short poll keeps that artificial total far below waitTimeoutMs.
    const { clock, fake, provider, conn } = await setup({ pollIntervalMs: 10 });
    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => provider.getAccessToken(conn)),
    );
    expect(fake.tokenRequests()).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set([fake.issuedAccessTokens[0]]));
    // The other 19 really did contend for the lock and wait.
    expect(clock.sleeps.length).toBeGreaterThan(0);

    // Lock released: a later forced refresh can take it.
    await provider.refreshAfterUnauthorized(conn, tokens[0] as string);
    expect(fake.tokenRequests()).toHaveLength(2);
  });

  it('serves from an encrypted 55-minute cache, then refreshes', async () => {
    const { clock, kv, fake, provider, conn } = await setup();
    const first = await provider.getAccessToken(conn);
    expect(await provider.getAccessToken(conn)).toBe(first);
    expect(fake.tokenRequests()).toHaveLength(1);

    const raw = await kv.get(tokenCacheKey(conn));
    expect(raw?.startsWith('v1.')).toBe(true);
    expect(raw).not.toContain(first);
    expect(tokenCacheKey(conn)).toBe(`tok:${conn.tenantId}:${conn.id}`);
    expect(await kv.pttl(tokenCacheKey(conn))).toBe(55 * 60_000);

    clock.advance(55 * 60_000);
    const second = await provider.getAccessToken(conn);
    expect(second).not.toBe(first);
    expect(fake.tokenRequests()).toHaveLength(2);
  });

  it('keys the cache by tenant and connection', async () => {
    const { fake, vault, connections, provider, conn } = await setup();
    const other = await connections.upsert({
      ...connectionInput(vault, fake.issueRefreshToken()),
      tenantId: 'tenant_b',
    });
    const a = await provider.getAccessToken(conn);
    const b = await provider.getAccessToken(other);
    expect(a).not.toBe(b);
    expect(fake.tokenRequests()).toHaveLength(2);
  });

  it('isolates tenants even when connection ids collide (cache, lock and cooldown keys)', async () => {
    const { fake, vault, provider, conn } = await setup();
    const a = await provider.getAccessToken(conn);
    const dead = fake.issueRefreshToken();
    fake.revokeRefreshToken(dead);
    const sameIdOtherTenant: ConnectionRecord = {
      ...conn,
      tenantId: 'tenant_b',
      refreshTokenEnc: vault.encrypt(dead),
    };
    // Must not be served tenant_a's cached token; its own refresh token is dead.
    await expect(provider.getAccessToken(sameIdOtherTenant)).rejects.toMatchObject({
      code: 'RECONNECT_REQUIRED',
    });
    // tenant_b's reconnect cooldown must not leak into tenant_a.
    expect(await provider.getAccessToken(conn)).toBe(a);
    const refreshed = await provider.refreshAfterUnauthorized(conn, a);
    expect(refreshed).not.toBe(a);
    expect(fake.tokenRequests()).toHaveLength(3);
  });

  it('refreshes two tenants with colliding connection ids concurrently, without one waiting on the other', async () => {
    const { clock, fake, vault, provider, conn } = await setup();
    const sameIdOtherTenant: ConnectionRecord = {
      ...conn,
      tenantId: 'tenant_b',
      refreshTokenEnc: vault.encrypt(fake.issueRefreshToken()),
    };
    const [a, b] = await Promise.all([
      provider.getAccessToken(conn),
      provider.getAccessToken(sameIdOtherTenant),
    ]);
    expect(a).not.toBe(b);
    expect(fake.tokenRequests()).toHaveLength(2);
    expect(clock.sleeps).toHaveLength(0);
  });

  it('uses a primed token without any request', async () => {
    const { fake, provider, conn } = await setup();
    await provider.primeAccessToken(conn, '1000.primed.token', 3600);
    expect(await provider.getAccessToken(conn)).toBe('1000.primed.token');
    expect(fake.requests).toHaveLength(0);
    await provider.invalidate(conn);
    expect(await provider.getAccessToken(conn)).not.toBe('1000.primed.token');
  });

  it('treats an undecryptable cache entry as a miss', async () => {
    const { kv, fake, provider, conn } = await setup();
    await kv.set(tokenCacheKey(conn), 'v1.garbage.garbage.garbage');
    expect(await provider.getAccessToken(conn)).toBe(fake.issuedAccessTokens[0]);
  });

  it('throws RECONNECT_REQUIRED for a non-active connection without calling Zoho', async () => {
    const { fake, provider, conn } = await setup();
    await provider.primeAccessToken(conn, '1000.primed.token', 3600);
    for (const status of ['needs_reconnect', 'revoked'] as const) {
      const e = await caught(provider.getAccessToken({ ...conn, status }));
      expect(e).toMatchObject({ code: 'RECONNECT_REQUIRED' });
      await expect(
        provider.refreshAfterUnauthorized({ ...conn, status }, 'x'),
      ).rejects.toMatchObject({
        code: 'RECONNECT_REQUIRED',
      });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('times out waiting on a lock held elsewhere', async () => {
    const { kv, fake, provider, conn } = await setup();
    await kv.set(`toklock:${conn.tenantId}:${conn.id}`, 'other-instance', { ttlMs: 60_000 });
    const e = await caught(provider.getAccessToken(conn));
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect(fake.requests).toHaveLength(0);
  });

  it('picks up a token refreshed by another instance while waiting', async () => {
    const { kv, clock, vault, fake, conn } = await setup();
    const lock = `toklock:${conn.tenantId}:${conn.id}`;
    await kv.set(lock, 'other-instance', { ttlMs: 60_000 });
    // The "other instance" finishes after the first poll.
    const slowClock = {
      now: () => clock.now(),
      sleep: async (ms: number) => {
        await clock.sleep(ms);
        await kv.set(tokenCacheKey(conn), vault.encrypt('1000.from.elsewhere'), { ttlMs: 60_000 });
      },
    };
    const provider = createAccessTokenProvider({
      kv,
      clock: slowClock,
      vault,
      connections: new InMemoryConnectionStore(),
      oauth: createZohoOAuthClient({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetch: fake.fetch,
      }),
      log: noopLogger,
    });
    expect(await provider.getAccessToken(conn)).toBe('1000.from.elsewhere');
    expect(fake.requests).toHaveLength(0);
  });

  it('re-checks the cache after taking the lock, so a miss that raced another refresh does not refresh again', async () => {
    const { kv, clock, vault, fake, connections, conn } = await setup();
    // Another instance already refreshed and released the lock, but this caller's first cache read
    // happened just before that write landed.
    await kv.set(tokenCacheKey(conn), vault.encrypt('1000.written.elsewhere'), { ttlMs: 60_000 });
    let staleReads = 1;
    const racy: Kv = delegatingKv(kv, {
      get: (key) =>
        key === tokenCacheKey(conn) && staleReads-- > 0 ? Promise.resolve(null) : kv.get(key),
    });
    const provider = createAccessTokenProvider({
      kv: racy,
      clock,
      vault,
      connections,
      oauth: createZohoOAuthClient({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetch: fake.fetch,
      }),
      log: noopLogger,
    });
    expect(await provider.getAccessToken(conn)).toBe('1000.written.elsewhere');
    expect(staleReads).toBeLessThan(1);
    expect(fake.tokenRequests()).toHaveLength(0);
  });
});

describe('refreshAfterUnauthorized', () => {
  it('does not refresh again when the failed token is already stale', async () => {
    const { fake, provider, conn } = await setup();
    const current = await provider.getAccessToken(conn);
    expect(await provider.refreshAfterUnauthorized(conn, '1000.older.token')).toBe(current);
    expect(fake.tokenRequests()).toHaveLength(1);
  });

  it('refreshes once when the cached token is the one that failed, even under concurrency', async () => {
    const { fake, provider, conn } = await setup();
    const failed = await provider.getAccessToken(conn);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => provider.refreshAfterUnauthorized(conn, failed)),
    );
    expect(fake.tokenRequests()).toHaveLength(2);
    expect(new Set(results)).toEqual(new Set([fake.issuedAccessTokens[1]]));
    expect(results[0]).not.toBe(failed);
    expect(await provider.getAccessToken(conn)).toBe(results[0]);
  });
});

describe('refresh failures', () => {
  it('invalid_grant → RECONNECT_REQUIRED and markNeedsReconnect, once for concurrent callers', async () => {
    const { fake, connections, provider, conn, refreshToken } = await setup();
    fake.revokeRefreshToken(refreshToken);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => provider.getAccessToken(conn)),
    );
    for (const r of results) {
      expect(r.status).toBe('rejected');
      const reason = (r as PromiseRejectedResult).reason as ConnectorError;
      expect(reason).toBeInstanceOf(ConnectorError);
      expect(reason.code).toBe('RECONNECT_REQUIRED');
      expect(reason.message).toBe('The Zoho connection needs to be re-authorized by the merchant.');
      expect(reason.hint).toBe('Ask the merchant to reconnect Zoho Inventory at /connect.');
    }
    expect(fake.tokenRequests()).toHaveLength(1);
    expect(connections.reconnectMarks).toEqual([
      { tenantId: conn.tenantId, connectionId: conn.id, errorCode: 'invalid_grant' },
    ]);
    expect((await connections.get(conn.tenantId, conn.id))?.status).toBe('needs_reconnect');
  });

  it('a literal invalid_grant from Zoho also marks the connection and throws RECONNECT_REQUIRED', async () => {
    const { clock, kv, vault, connections, conn } = await setup();
    let calls = 0;
    const provider = createAccessTokenProvider({
      kv,
      clock,
      vault,
      connections,
      oauth: createZohoOAuthClient({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetch: async () => {
          calls++;
          return { status: 400, text: async () => '{"error":"invalid_grant"}' };
        },
      }),
      log: noopLogger,
    });
    const e = await caught(provider.getAccessToken(conn));
    expect(e).toBeInstanceOf(ConnectorError);
    expect(e).toMatchObject({
      code: 'RECONNECT_REQUIRED',
      message: 'The Zoho connection needs to be re-authorized by the merchant.',
      hint: 'Ask the merchant to reconnect Zoho Inventory at /connect.',
    });
    expect(calls).toBe(1);
    expect(connections.reconnectMarks).toEqual([
      { tenantId: conn.tenantId, connectionId: conn.id, errorCode: 'invalid_grant' },
    ]);
  });

  it('stops handing out a token Zoho rejected (401) when the follow-up refresh fails', async () => {
    const { fake, provider, conn } = await setup();
    const rejected = await provider.getAccessToken(conn);
    fake.mode = 'throttle';
    await expect(provider.refreshAfterUnauthorized(conn, rejected)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
    // Serving `rejected` again would burn a governed Zoho API call on a guaranteed 401.
    const e = await caught(provider.getAccessToken(conn));
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect(fake.tokenRequests()).toHaveLength(2);
  });

  it('replays a non-retryable failure to later callers without a retry_after_s or retry hint', async () => {
    const { fake, provider, conn } = await setup();
    fake.mode = 'bad_client';
    const first = (await caught(provider.getAccessToken(conn))) as ConnectorError;
    expect(first).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
    const again = (await caught(provider.getAccessToken(conn))) as ConnectorError;
    expect(again).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
    expect(again.retryAfterS).toBeUndefined();
    expect(again.hint).toBe(first.hint);
    expect(fake.tokenRequests()).toHaveLength(1);
  });

  it('replays a throttle to later callers with the remaining retry_after_s and the throttle hint', async () => {
    const { clock, fake, provider, conn } = await setup();
    fake.mode = 'throttle';
    const first = (await caught(provider.getAccessToken(conn))) as ConnectorError;
    clock.advance(20_000);
    const again = (await caught(provider.getAccessToken(conn))) as ConnectorError;
    expect(again).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, retryAfterS: 40 });
    expect(again.hint).toBe(first.hint);
  });

  it('throttle → retryable UPSTREAM_ERROR, and callers back off without hitting Zoho again', async () => {
    const { clock, fake, provider, conn } = await setup();
    fake.mode = 'throttle';
    const e = await caught(provider.getAccessToken(conn));
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, retryAfterS: 60 });
    expect(fake.tokenRequests()).toHaveLength(1);

    clock.advance(30_000);
    const again = await caught(provider.getAccessToken(conn));
    expect(again).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect((again as ConnectorError).retryAfterS).toBeLessThanOrEqual(30);
    expect(fake.tokenRequests()).toHaveLength(1);

    fake.mode = 'ok';
    clock.advance(31_000);
    expect(await provider.getAccessToken(conn)).toBe(fake.issuedAccessTokens[0]);
    expect(fake.tokenRequests()).toHaveLength(2);
  });

  it('transient failures are shared by concurrent callers', async () => {
    const { fake, provider, conn } = await setup();
    fake.mode = 'server_error';
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => provider.getAccessToken(conn)),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fake.tokenRequests()).toHaveLength(1);
  });

  it('an unreadable stored refresh token fails without marking the connection', async () => {
    const { fake, connections, provider, conn } = await setup();
    const broken: ConnectionRecord = { ...conn, refreshTokenEnc: 'v1.bad.bad.bad' };
    const e = await caught(provider.getAccessToken(broken));
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
    expect(fake.requests).toHaveLength(0);
    expect(connections.reconnectMarks).toHaveLength(0);
  });
});
