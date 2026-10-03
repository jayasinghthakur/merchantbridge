import { randomBytes } from 'node:crypto';
import type { Clock, ConnectionRecord, ConnectionStore, ErrorCode, Kv, Logger } from '@mb/core';
import { ConnectorError, ERROR_CODES, isConnectorError } from '@mb/core';
import { reconnectRequiredError } from './errors';
import type { RefreshResult, ZohoOAuthClient } from './oauth-client';
import type { TokenVault } from './vault';

/**
 * Hands out Zoho access tokens per connection. Tokens are cached in Kv (encrypted) and refreshed single-flight
 * across all API instances, because Zoho allows only ~10 token requests per 10 minutes.
 */
export interface AccessTokenProvider {
  /** Cached token, or a refreshed one. Throws ConnectorError (RECONNECT_REQUIRED, UPSTREAM_ERROR). */
  getAccessToken(conn: ConnectionRecord): Promise<string>;
  /**
   * After Zoho answered 401 to `failedToken`: refreshes only if the cache still holds that token, otherwise
   * returns the newer token another caller already fetched.
   */
  refreshAfterUnauthorized(conn: ConnectionRecord, failedToken: string): Promise<string>;
  /** Seeds the cache with the token from the code exchange so the first tool call needs no refresh. */
  primeAccessToken(conn: ConnectionRef, accessToken: string, expiresInS: number): Promise<void>;
  /** Drops the cached token (e.g. on disconnect). */
  invalidate(conn: ConnectionRef): Promise<void>;
}

export type ConnectionRef = Pick<ConnectionRecord, 'tenantId' | 'id'>;

export interface AccessTokenProviderOptions {
  kv: Kv;
  clock: Clock;
  vault: TokenVault;
  connections: ConnectionStore;
  oauth: Pick<ZohoOAuthClient, 'refresh'>;
  log: Logger;
  /** Upper bound for the cached access token. Default 55 min (Zoho tokens live 60 min). */
  cacheTtlMs?: number;
  /** Refresh lock lifetime; must exceed the token request timeout. Default 15 s. */
  lockTtlMs?: number;
  /** How long a caller waits for another instance's refresh. Default 10 s. */
  waitTimeoutMs?: number;
  /** Poll interval while waiting. Default 100 ms. */
  pollIntervalMs?: number;
}

export const tokenCacheKey = (c: ConnectionRef): string => `tok:${c.tenantId}:${c.id}`;
const lockKey = (c: ConnectionRef): string => `toklock:${c.tenantId}:${c.id}`;
const cooldownKey = (c: ConnectionRef): string => `tokcool:${c.tenantId}:${c.id}`;

/** Refresh this long before Zoho's stated expiry, so an in-flight call never carries a just-expired token. */
const EXPIRY_MARGIN_MS = 60_000;
const MIN_CACHE_TTL_MS = 1_000;
/** After invalid_grant, waiters fail fast instead of each retrying a dead refresh token. */
const RECONNECT_COOLDOWN_MS = 60_000;
/** After a transient failure, concurrent callers share the failure instead of stampeding Zoho Accounts. */
const DEFAULT_COOLDOWN_MS = 5_000;

interface Cooldown {
  code: ErrorCode;
  retryable: boolean;
  /** The original error's agent-safe hint (our own static strings), replayed to later callers. */
  hint?: string;
}

const RETRY_HINT = 'Retry after retry_after_s seconds.';
const MAX_HINT_LENGTH = 300;

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

function parseCooldown(raw: string): Cooldown {
  try {
    const parsed = JSON.parse(raw) as Partial<Cooldown>;
    if (isErrorCode(parsed.code)) {
      const hint =
        typeof parsed.hint === 'string' && parsed.hint.length <= MAX_HINT_LENGTH
          ? parsed.hint
          : undefined;
      return {
        code: parsed.code,
        retryable: parsed.retryable !== false,
        ...(hint === undefined ? {} : { hint }),
      };
    }
  } catch {
    // Unreadable marker: fall through to the generic code.
  }
  return { code: 'UPSTREAM_ERROR', retryable: true };
}

export function createAccessTokenProvider(opts: AccessTokenProviderOptions): AccessTokenProvider {
  const { kv, clock, vault, connections, oauth, log } = opts;
  const cacheTtlMs = opts.cacheTtlMs ?? 55 * 60_000;
  const lockTtlMs = opts.lockTtlMs ?? 15_000;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;

  const ids = (c: ConnectionRef) => ({ tenant_id: c.tenantId, connection_id: c.id });

  function assertActive(conn: ConnectionRecord): void {
    if (conn.status !== 'active') throw reconnectRequiredError();
  }

  async function readCache(conn: ConnectionRef): Promise<string | null> {
    const enc = await kv.get(tokenCacheKey(conn));
    if (enc === null) return null;
    try {
      return vault.decrypt(enc);
    } catch {
      // e.g. vault key rotated: treat as a miss rather than failing the call.
      log.warn(ids(conn), 'cached access token could not be decrypted; discarding');
      await kv.del(tokenCacheKey(conn));
      return null;
    }
  }

  async function writeCache(conn: ConnectionRef, token: string, expiresInS: number): Promise<void> {
    const ttlMs = Math.max(
      MIN_CACHE_TTL_MS,
      Math.min(cacheTtlMs, expiresInS * 1000 - EXPIRY_MARGIN_MS),
    );
    await kv.set(tokenCacheKey(conn), vault.encrypt(token), { ttlMs });
  }

  async function throwIfCoolingDown(conn: ConnectionRef): Promise<void> {
    const raw = await kv.get(cooldownKey(conn));
    if (raw === null) return;
    const marker = parseCooldown(raw);
    if (marker.code === 'RECONNECT_REQUIRED') throw reconnectRequiredError();
    const message = 'A recent Zoho token refresh for this connection failed.';
    if (!marker.retryable) {
      // A retry_after_s would contradict retryable: false (e.g. a client misconfiguration).
      throw new ConnectorError(marker.code, message, {
        retryable: false,
        ...(marker.hint === undefined ? {} : { hint: marker.hint }),
      });
    }
    const pttl = await kv.pttl(cooldownKey(conn));
    throw new ConnectorError(marker.code, message, {
      retryable: true,
      retryAfterS: Math.max(1, Math.ceil((pttl > 0 ? pttl : DEFAULT_COOLDOWN_MS) / 1000)),
      hint: marker.hint ?? RETRY_HINT,
    });
  }

  async function startCooldown(
    conn: ConnectionRef,
    marker: Cooldown,
    ttlMs: number,
  ): Promise<void> {
    await kv.set(cooldownKey(conn), JSON.stringify(marker), { ttlMs });
  }

  async function releaseLock(conn: ConnectionRef, owner: string): Promise<void> {
    try {
      // Kv has no compare-and-delete; the get→del race only matters if the lock already expired mid-refresh.
      if ((await kv.get(lockKey(conn))) === owner) await kv.del(lockKey(conn));
    } catch {
      log.warn(ids(conn), 'failed to release token refresh lock; it will expire');
    }
  }

  async function onRefreshFailure(conn: ConnectionRecord, e: unknown): Promise<never> {
    if (isConnectorError(e) && e.code === 'RECONNECT_REQUIRED') {
      log.warn({ ...ids(conn), error_code: 'invalid_grant' }, 'zoho refresh token rejected');
      await startCooldown(
        conn,
        { code: 'RECONNECT_REQUIRED', retryable: false },
        RECONNECT_COOLDOWN_MS,
      );
      await kv.del(tokenCacheKey(conn));
      try {
        await connections.markNeedsReconnect(conn.tenantId, conn.id, 'invalid_grant');
      } catch {
        log.error(ids(conn), 'failed to mark connection needs_reconnect');
      }
      throw reconnectRequiredError();
    }
    if (isConnectorError(e)) {
      log.warn(
        { ...ids(conn), error_code: e.code, retryable: e.retryable },
        'zoho token refresh failed',
      );
      const ttlMs = e.retryAfterS === undefined ? DEFAULT_COOLDOWN_MS : e.retryAfterS * 1000;
      await startCooldown(
        conn,
        { code: e.code, retryable: e.retryable, ...(e.hint === undefined ? {} : { hint: e.hint }) },
        ttlMs,
      );
      throw e;
    }
    log.error(
      { ...ids(conn), err_name: e instanceof Error ? e.name : typeof e },
      'unexpected error during zoho token refresh',
    );
    await startCooldown(conn, { code: 'UPSTREAM_ERROR', retryable: true }, DEFAULT_COOLDOWN_MS);
    throw new ConnectorError('UPSTREAM_ERROR', 'Could not refresh the Zoho access token.', {
      retryable: true,
    });
  }

  /** Runs with the lock held. `stale` is a token known to be rejected (or null for a plain cache miss). */
  async function refreshHoldingLock(conn: ConnectionRecord, stale: string | null): Promise<string> {
    const cached = await readCache(conn);
    if (cached !== null && cached !== stale) return cached;
    if (cached !== null) {
      // Zoho already rejected this token (401). Drop it now so that, if the refresh fails, callers hit the
      // cooldown instead of spending a governed Zoho API call on a guaranteed 401.
      await kv.del(tokenCacheKey(conn));
    }
    await throwIfCoolingDown(conn);

    let refreshToken: string;
    try {
      refreshToken = vault.decrypt(conn.refreshTokenEnc);
    } catch {
      // Not marked needs_reconnect: a vault-key misconfiguration would otherwise disconnect every tenant.
      log.error(ids(conn), 'stored refresh token could not be decrypted');
      throw new ConnectorError('UPSTREAM_ERROR', 'Stored Zoho credentials could not be read.', {
        retryable: false,
        hint: 'Ask the merchant to reconnect Zoho Inventory at /connect.',
      });
    }

    let result: RefreshResult;
    try {
      result = await oauth.refresh({ refreshToken, accountsServer: conn.accountsServer });
    } catch (e) {
      return onRefreshFailure(conn, e);
    }
    await writeCache(conn, result.accessToken, result.expiresInS);
    log.info({ ...ids(conn), expires_in_s: result.expiresInS }, 'zoho access token refreshed');
    return result.accessToken;
  }

  async function refreshSingleFlight(
    conn: ConnectionRecord,
    stale: string | null,
  ): Promise<string> {
    const deadline = clock.now() + waitTimeoutMs;
    for (;;) {
      const owner = randomBytes(9).toString('base64url');
      if (await kv.set(lockKey(conn), owner, { nx: true, ttlMs: lockTtlMs })) {
        try {
          return await refreshHoldingLock(conn, stale);
        } finally {
          await releaseLock(conn, owner);
        }
      }
      if (clock.now() >= deadline) {
        log.warn(ids(conn), 'timed out waiting for zoho token refresh');
        throw new ConnectorError('UPSTREAM_ERROR', 'Timed out waiting for a Zoho token refresh.', {
          retryable: true,
          retryAfterS: 1,
        });
      }
      await clock.sleep(pollIntervalMs);
      const fresh = await readCache(conn);
      if (fresh !== null && fresh !== stale) return fresh;
      await throwIfCoolingDown(conn);
    }
  }

  return {
    async getAccessToken(conn) {
      assertActive(conn);
      const cached = await readCache(conn);
      if (cached !== null) return cached;
      return refreshSingleFlight(conn, null);
    },

    async refreshAfterUnauthorized(conn, failedToken) {
      assertActive(conn);
      const cached = await readCache(conn);
      if (cached !== null && cached !== failedToken) return cached;
      return refreshSingleFlight(conn, failedToken);
    },

    async primeAccessToken(conn, accessToken, expiresInS) {
      await kv.del(cooldownKey(conn));
      await writeCache(conn, accessToken, expiresInS);
    },

    async invalidate(conn) {
      await kv.del(tokenCacheKey(conn));
    },
  };
}
