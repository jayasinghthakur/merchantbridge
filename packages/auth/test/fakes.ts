import { randomBytes } from 'node:crypto';
import type { ConnectionRecord, ConnectionStore, Kv, Logger, NewConnection } from '@mb/core';
import type { FetchInit, FetchLike, FetchResponseLike, TokenVault } from '../src/index';
import { ZOHO_DATA_CENTERS } from '../src/index';

export const CLIENT_ID = '1000.FAKECLIENTID0001';
export const CLIENT_SECRET = 'cs_SUPERSECRET_9f8e7d6c5b4a';
export const REDIRECT_URI = 'https://api.mb.test/oauth/zoho/callback';
export const STATE_SECRET = 'state-secret-0123456789abcdef0123456789abcdef';
export const VAULT_KEY = randomBytes(32).toString('base64');
export const SCOPES = ['ZohoInventory.settings.READ', 'ZohoInventory.items.READ'] as const;

export interface RecordedRequest {
  url: string;
  path: string;
  params: URLSearchParams;
  headers: Record<string, string>;
}

export type FakeMode =
  'ok' | 'throttle' | 'throttle_429' | 'server_error' | 'network' | 'bad_client';

function respond(status: number, body: unknown): FetchResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text: async () => text };
}

/**
 * Wire-shaped fake of Zoho Accounts (acc_oauth_web-apps_*.txt, acc_oauth_revoke-refresh-token.txt).
 * Completes via microtasks only, so it stays deterministic with ManualClock.
 */
export class FakeAccounts {
  readonly requests: RecordedRequest[] = [];
  mode: FakeMode = 'ok';
  /** `api_domain` returned by the token endpoint. */
  apiDomain: string = ZOHO_DATA_CENTERS.in.apiDomain;
  omitRefreshToken = false;
  revokeStatus = 200;
  legacyRevokeStatus = 200;
  readonly issuedAccessTokens: string[] = [];
  readonly issuedRefreshTokens: string[] = [];
  readonly issuedCodes: string[] = [];
  private readonly codes = new Map<string, string>();
  private readonly liveRefreshTokens = new Set<string>();
  private seq = 0;

  issueCode(): string {
    const n = ++this.seq;
    const code = `1000.authcode${n}.CODESECRET${n}`;
    const refresh = `1000.refreshtok${n}.RTSECRET${n}`;
    this.codes.set(code, refresh);
    this.liveRefreshTokens.add(refresh);
    this.issuedCodes.push(code);
    this.issuedRefreshTokens.push(refresh);
    return code;
  }

  /** A refresh token as if issued by an earlier consent. */
  issueRefreshToken(): string {
    const n = ++this.seq;
    const refresh = `1000.refreshtok${n}.RTSECRET${n}`;
    this.liveRefreshTokens.add(refresh);
    this.issuedRefreshTokens.push(refresh);
    return refresh;
  }

  revokeRefreshToken(token: string): void {
    this.liveRefreshTokens.delete(token);
  }

  tokenRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path === '/oauth/v2/token');
  }

  private newAccessToken(): string {
    const token = `1000.accesstok${++this.seq}.ATSECRET${this.seq}`;
    this.issuedAccessTokens.push(token);
    return token;
  }

  readonly fetch: FetchLike = async (url: string, init: FetchInit) => {
    const u = new URL(url);
    const params = new URLSearchParams(init.body);
    this.requests.push({ url, path: u.pathname, params, headers: { ...init.headers } });
    // Let concurrent callers interleave, as they would against a real server.
    await Promise.resolve();
    await Promise.resolve();

    if (this.mode === 'network') throw new TypeError('fetch failed');
    if (this.mode === 'server_error') return respond(503, '<html>Service Unavailable</html>');

    if (u.pathname === '/oauth/v2/revoke/token') {
      const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      if (init.headers.authorization !== `Basic ${basic}`)
        return respond(401, { error: 'invalid_client' });
      const token = params.get('token') ?? '';
      if (this.revokeStatus === 200) this.liveRefreshTokens.delete(token);
      return respond(this.revokeStatus, this.revokeStatus === 200 ? { status: 'success' } : {});
    }
    if (u.pathname === '/oauth/v2/token/revoke') return respond(this.legacyRevokeStatus, {});
    if (u.pathname !== '/oauth/v2/token') return respond(404, 'Not Found');

    if (this.mode === 'throttle') {
      return respond(400, {
        error: 'Access Denied',
        error_description:
          'You have made too many requests continuously. Please try again after some time.',
      });
    }
    if (this.mode === 'throttle_429') return respond(429, '');
    if (this.mode === 'bad_client' || params.get('client_id') !== CLIENT_ID) {
      return respond(200, { error: 'invalid_client' });
    }
    if (params.get('client_secret') !== CLIENT_SECRET) {
      return respond(200, { error: 'invalid_client_secret' });
    }

    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      if (params.get('redirect_uri') !== REDIRECT_URI) {
        return respond(200, { error: 'invalid_redirect_uri' });
      }
      const code = params.get('code') ?? '';
      const refresh = this.codes.get(code);
      if (refresh === undefined) return respond(200, { error: 'invalid_code' });
      this.codes.delete(code); // single use
      return respond(200, {
        access_token: this.newAccessToken(),
        ...(this.omitRefreshToken ? {} : { refresh_token: refresh }),
        api_domain: this.apiDomain,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (grant === 'refresh_token') {
      // Per acc_oauth_web-apps_access-token-expiry.txt a revoked refresh token answers `invalid_code`.
      if (!this.liveRefreshTokens.has(params.get('refresh_token') ?? '')) {
        return respond(200, { error: 'invalid_code' });
      }
      return respond(200, {
        access_token: this.newAccessToken(),
        api_domain: this.apiDomain,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    return respond(400, 'Bad Request');
  };
}

export class InMemoryConnectionStore implements ConnectionStore {
  readonly rows = new Map<string, ConnectionRecord>();
  readonly reconnectMarks: Array<{ tenantId: string; connectionId: string; errorCode: string }> =
    [];
  private seq = 0;

  async get(tenantId: string, connectionId: string): Promise<ConnectionRecord | null> {
    const row = this.rows.get(connectionId);
    return row && row.tenantId === tenantId ? row : null;
  }

  async getActiveForTenant(tenantId: string): Promise<ConnectionRecord | null> {
    return (
      [...this.rows.values()].find((r) => r.tenantId === tenantId && r.status === 'active') ?? null
    );
  }

  async upsert(input: NewConnection): Promise<ConnectionRecord> {
    const now = new Date(0).toISOString();
    const row: ConnectionRecord = {
      ...input,
      id: `conn_${++this.seq}`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async markNeedsReconnect(
    tenantId: string,
    connectionId: string,
    errorCode: string,
  ): Promise<void> {
    this.reconnectMarks.push({ tenantId, connectionId, errorCode });
    const row = await this.get(tenantId, connectionId);
    if (row) this.rows.set(row.id, { ...row, status: 'needs_reconnect', lastErrorCode: errorCode });
  }

  async markRevoked(tenantId: string, connectionId: string): Promise<void> {
    const row = await this.get(tenantId, connectionId);
    if (row) this.rows.set(row.id, { ...row, status: 'revoked' });
  }

  async touchSuccess(tenantId: string, connectionId: string): Promise<void> {
    const row = await this.get(tenantId, connectionId);
    if (row) this.rows.set(row.id, { ...row, lastSuccessAt: new Date(0).toISOString() });
  }
}

export function connectionInput(vault: TokenVault, refreshToken: string): NewConnection {
  const dc = ZOHO_DATA_CENTERS.in;
  return {
    tenantId: 'tenant_a',
    provider: 'zoho_inventory',
    dc: dc.key,
    accountsServer: dc.accountsServer,
    apiDomain: dc.apiDomain,
    organizationId: '60012345678',
    organizationName: 'Chai & Co',
    plan: 'free',
    scopes: [...SCOPES],
    refreshTokenEnc: vault.encrypt(refreshToken),
  };
}

/** A Kv that forwards to `inner` except for the methods in `overrides` (fault injection). */
export function delegatingKv(inner: Kv, overrides: Partial<Kv> = {}): Kv {
  return {
    get: (key) => inner.get(key),
    set: (key, value, opts) => inner.set(key, value, opts),
    del: (key) => inner.del(key),
    incr: (key, ttlMs) => inner.incr(key, ttlMs),
    pttl: (key) => inner.pttl(key),
    zadd: (key, score, member) => inner.zadd(key, score, member),
    zrem: (key, member) => inner.zrem(key, member),
    zremrangebyscore: (key, min, max) => inner.zremrangebyscore(key, min, max),
    zcard: (key) => inner.zcard(key),
    ...overrides,
  };
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: object;
  msg?: string;
}

export class CapturingLogger implements Logger {
  readonly entries: LogEntry[] = [];
  debug(obj: object, msg?: string): void {
    this.entries.push({ level: 'debug', obj, msg });
  }
  info(obj: object, msg?: string): void {
    this.entries.push({ level: 'info', obj, msg });
  }
  warn(obj: object, msg?: string): void {
    this.entries.push({ level: 'warn', obj, msg });
  }
  error(obj: object, msg?: string): void {
    this.entries.push({ level: 'error', obj, msg });
  }
  dump(): string {
    return JSON.stringify(this.entries);
  }
}
