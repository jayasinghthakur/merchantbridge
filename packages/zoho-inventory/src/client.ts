import type {
  Cache,
  Governor,
  GovernorDecision,
  GovernorScope,
  GovernorSnapshot,
  Logger,
} from '@mb/core';
import {
  ConnectorError,
  UpstreamError,
  isConnectorError,
  isUpstreamError,
  noopLogger,
} from '@mb/core';

/**
 * ZohoClient: the ONLY module in this package that issues upstream requests. GET only, allow-listed paths only,
 * every attempt inside governor.schedule(). Error messages never carry tokens, query strings or upstream bodies.
 */

export interface ZohoTokenSource {
  get(): Promise<string>;
  /** Single-flight refresh after a 401; returns the token to retry with. */
  refreshAfterUnauthorized(failedToken: string): Promise<string>;
}

export interface ZohoConnectionInfo {
  mode: 'demo' | 'live';
  dc: string;
  /** Scopes requested at connect. Zoho's token response does not list granted scopes, so this is not proof. */
  scopes: readonly string[];
  organizationName: string | null;
  plan: string | null;
}

export interface ZohoApiDeps {
  fetch: typeof fetch;
  /** e.g. the token response's `api_domain`; in demo mode, FakeZoho's origin. */
  apiDomain: string;
  organizationId: string;
  tokens: ZohoTokenSource;
  governor: Governor;
  scope: GovernorScope;
  cache?: Cache;
  /** Must include the tenant (and org), e.g. `zoho:${tenantId}:${orgId}:`; required non-empty with `cache`. */
  cacheKeyPrefix: string;
  note: (d: GovernorDecision) => void;
  /** Zoho Inventory web app origin for the org's DC, e.g. `https://inventory.zoho.in`. */
  webBaseUrl: string;
  connection: ZohoConnectionInfo;
  log?: Logger;
}

export type ZohoQuery = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface ZohoGetResult<T> {
  body: T;
  /** Request URL without its query string (safe to log). */
  url: string;
  cached: boolean;
}

export type ZohoWebKind =
  'item' | 'salesorder' | 'invoice' | 'contact' | 'payment' | 'package' | 'organization';

export interface ZohoApi {
  readonly organizationId: string;
  get<T = unknown>(
    path: string,
    query?: ZohoQuery,
    opts?: { cacheTtlMs?: number },
  ): Promise<ZohoGetResult<T>>;
  /**
   * Deep link into the Zoho Inventory web app, so a human can verify an agent's claim.
   * UNVERIFIED: the route format (`{web}/app/{org}#/{route}/{id}`, see WEB_ROUTES) was observed in the web app, is
   * not in Zoho's API docs, and stays unverified until the scripts/smoke.ts probe confirms it (ADR-0001).
   */
  webUrl(kind: ZohoWebKind, id?: string): string;
  info(): ZohoConnectionInfo;
  snapshot(): Promise<GovernorSnapshot>;
}

// ---------- allow-lists ----------

const ID = '[0-9A-Za-z_-]{1,64}';
const ALLOWED_PATHS: readonly RegExp[] = [
  'items',
  `items/${ID}`,
  'itemdetails',
  'salesorders',
  `salesorders/${ID}`,
  'invoices',
  `invoices/${ID}`,
  'contacts',
  `contacts/${ID}`,
  'customerpayments',
  `customerpayments/${ID}`,
  'packages',
  `packages/${ID}`,
  `shipmentorders/${ID}`,
  'organizations',
  `organizations/${ID}`,
  'locations',
].map((p) => new RegExp(`^${p}$`));

/** Only slow-changing catalogue/settings data may be cached; orders, invoices and payments never are. */
const CACHEABLE = new RegExp(
  `^(items|items/${ID}|itemdetails|organizations|organizations/${ID}|locations)$`,
);
/** organizations.yml: `organization_id` is a path param (or absent) on these endpoints. */
const WITHOUT_ORG_PARAM = /^organizations(\/|$)/;
const QUERY_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_QUERY_KEYS = new Set(['organization_id', 'authtoken', 'access_token']);

/** Official Zoho API hosts per DC (accounts/introduction.txt "Multiple Data Centers"). Live mode only. */
const LIVE_API_HOST = /^www\.zohoapis\.(com|eu|in|com\.au|jp|ca|com\.cn|sa)$/;

/** Web-app routes. UNVERIFIED: hash routes observed in the Zoho Inventory web app, not in the API docs. */
const WEB_ROUTES: Record<Exclude<ZohoWebKind, 'organization'>, string> = {
  item: 'inventory/items',
  salesorder: 'salesorders',
  invoice: 'invoices',
  contact: 'contacts',
  payment: 'paymentsreceived',
  package: 'packages',
};

// ---------- Zoho error codes ----------

const CODE_MINUTE_LIMIT = 44;
const CODE_DAILY_LIMIT = 45;
const CODE_CONCURRENCY = 1070;
/** accounts/errors.txt example: 1002 "Invoice does not exist." */
const NOT_FOUND_CODES = new Set([1002]);
/** UNVERIFIED: 57 "You are not authorized to perform this operation" (permission/scope) when not sent as a 401. */
const PERMISSION_CODES = new Set([57]);
/** UNVERIFIED: 14 "Invalid value passed for authtoken" treated as an invalid token whatever the HTTP status. */
const INVALID_TOKEN_CODES = new Set([14]);

const unsupported = (): ConnectorError =>
  new ConnectorError('UPSTREAM_ERROR', 'This request is not supported by the connector.', {
    retryable: false,
    hint: 'This is a connector bug; try a different tool or report it.',
  });

const unreadable = (): ConnectorError =>
  new ConnectorError('UPSTREAM_ERROR', 'Zoho Inventory returned an unreadable response.', {
    retryable: false,
    hint: 'Try again later; if it persists, report it.',
  });

const reconnectRequired = (): ConnectorError =>
  new ConnectorError(
    'RECONNECT_REQUIRED',
    'The Zoho Inventory connection has expired or was revoked.',
    {
      hint: 'Ask the merchant to reconnect Zoho Inventory in MerchantBridge; retrying will not help.',
    },
  );

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

function bodyCode(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return null;
}

function bodyMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const m = (body as { message?: unknown }).message;
  return typeof m === 'string' ? m : '';
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

type Attempt = { kind: 'ok'; body: unknown } | { kind: 'unauthorized' };

export function createZohoApi(deps: ZohoApiDeps): ZohoApi {
  const log = deps.log ?? noopLogger;
  const base = new URL(deps.apiDomain);
  if (
    base.protocol !== 'https:' ||
    base.pathname !== '/' ||
    base.search !== '' ||
    base.username !== ''
  ) {
    throw new Error('ZohoClient: apiDomain must be a bare https origin');
  }
  if (deps.connection.mode === 'live' && !LIVE_API_HOST.test(base.hostname)) {
    throw new Error('ZohoClient: apiDomain is not a Zoho API host');
  }
  if (!new RegExp(`^${ID}$`).test(deps.organizationId)) {
    throw new Error('ZohoClient: invalid organizationId');
  }
  // Cached bodies are per-user data (e.g. the organizations list); an unscoped key would share them.
  if (deps.cache && deps.cacheKeyPrefix.trim() === '') {
    throw new Error('ZohoClient: cacheKeyPrefix must scope cache keys to the tenant');
  }
  const origin = base.origin;
  const webBase = deps.webBaseUrl.replace(/\/+$/, '');
  /** A throwing trace callback must never fail the request it describes. */
  const note = (d: GovernorDecision): void => {
    try {
      deps.note(d);
    } catch {
      log.warn({ upstream: 'zoho', decision: d.type }, 'zoho client: note callback threw');
    }
  };

  function buildRequest(
    rawPath: string,
    query: ZohoQuery | undefined,
  ): { path: string; url: string; safeUrl: string } {
    const path = rawPath.replace(/^\/+/, '');
    if (!ALLOWED_PATHS.some((re) => re.test(path))) throw unsupported();
    const params = new URLSearchParams();
    const entries = Object.entries(query ?? {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of entries) {
      if (!QUERY_KEY.test(key) || RESERVED_QUERY_KEYS.has(key)) throw unsupported();
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    if (!WITHOUT_ORG_PARAM.test(path)) params.set('organization_id', deps.organizationId);
    const safeUrl = `${origin}/inventory/v1/${path}`;
    const qs = params.toString();
    return { path, url: qs === '' ? safeUrl : `${safeUrl}?${qs}`, safeUrl };
  }

  /** One HTTP attempt. Throws UpstreamError (retryable classes) or ConnectorError; 401 is returned, not thrown. */
  async function attempt(
    path: string,
    url: string,
    token: string,
    signal: AbortSignal,
  ): Promise<Attempt> {
    const started = Date.now();
    let res: Response;
    let text: string;
    try {
      res = await deps.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' },
        signal,
        redirect: 'error',
      });
      text = await res.text();
    } catch (e) {
      if (isAbort(e, signal))
        throw new UpstreamError({ kind: 'timeout' }, 'Zoho request timed out');
      throw new UpstreamError({ kind: 'network' }, 'Zoho request failed at the network level');
    }

    let body: unknown;
    let parsed = true;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      parsed = false;
    }
    const code = parsed ? bodyCode(body) : null;
    log.debug(
      { upstream: 'zoho', path, status: res.status, code, ms: Date.now() - started },
      'zoho request',
    );

    if (res.status === 401 || (code !== null && INVALID_TOKEN_CODES.has(code)))
      return { kind: 'unauthorized' };

    const rateCode =
      code === CODE_MINUTE_LIMIT || code === CODE_DAILY_LIMIT || code === CODE_CONCURRENCY;
    if (res.status === 429 || rateCode) {
      const retryAfter = parseRetryAfter(res);
      if (code === CODE_DAILY_LIMIT) {
        throw new UpstreamError(
          { kind: 'rate_limit_daily' },
          'Zoho daily API limit reached (code 45)',
          retryAfter,
        );
      }
      if (code === CODE_MINUTE_LIMIT) {
        throw new UpstreamError(
          { kind: 'rate_limit_minute' },
          'Zoho per-minute limit hit (code 44)',
          retryAfter,
        );
      }
      const label = code === CODE_CONCURRENCY ? 'code 1070' : 'unclassified 429';
      throw new UpstreamError(
        { kind: 'concurrency' },
        `Zoho concurrency limit (${label})`,
        retryAfter,
      );
    }
    if (res.status >= 500) {
      throw new UpstreamError(
        { kind: 'server', status: res.status },
        `Zoho server error (HTTP ${res.status})`,
      );
    }
    if (!parsed) throw unreadable();
    if (res.status >= 200 && res.status < 300 && code === 0) return { kind: 'ok', body };

    // Everything below is an error, including HTTP 200 with a non-zero body code.
    if (
      res.status === 404 ||
      (code !== null && NOT_FOUND_CODES.has(code)) ||
      /does not exist/i.test(bodyMessage(body))
    ) {
      throw new ConnectorError(
        'NOT_FOUND',
        'The requested record was not found in Zoho Inventory.',
        {
          hint: 'Check the id or number; pass ids exactly as returned by other tools.',
        },
      );
    }
    if (res.status === 403 || (code !== null && PERMISSION_CODES.has(code))) {
      throw new ConnectorError(
        'SCOPE_NOT_GRANTED',
        'The Zoho connection is not permitted to read this data.',
        {
          hint: 'Ask the merchant to reconnect Zoho Inventory and grant every requested read scope.',
        },
      );
    }
    if (res.status === 400) {
      throw new ConnectorError('INVALID_INPUT', 'Zoho Inventory rejected the request parameters.', {
        hint: 'Check filter values (dates as YYYY-MM-DD, ids exactly as returned by other tools).',
      });
    }
    if (res.status >= 200 && res.status < 300 && code === null) throw unreadable();
    throw new ConnectorError(
      'UPSTREAM_ERROR',
      'Zoho Inventory returned an error for this request.',
      {
        retryable: false,
        hint: 'Try a different query; if it persists, report it.',
      },
    );
  }

  async function governed(
    path: string,
    url: string,
    token: () => Promise<string>,
    used: { token: string },
  ): Promise<Attempt> {
    return deps.governor.schedule(
      deps.scope,
      async (_attempt, signal) => {
        used.token = await token();
        return attempt(path, url, used.token, signal);
      },
      deps.note,
    );
  }

  async function load(path: string, url: string): Promise<unknown> {
    const used = { token: '' };
    const first = await governed(path, url, () => deps.tokens.get(), used);
    if (first.kind === 'ok') return first.body;

    let fresh: string;
    try {
      fresh = await deps.tokens.refreshAfterUnauthorized(used.token);
    } catch (e) {
      if (isConnectorError(e) || isUpstreamError(e)) throw e;
      log.warn({ upstream: 'zoho', path }, 'zoho token refresh failed');
      throw reconnectRequired();
    }
    // Visible in the trace, and the retry counts towards usage.retries like any governor retry.
    note({ type: 'token_refreshed' });
    note({ type: 'retried', attempt: 2, reason: 'token_refreshed', backoff_ms: 0 });
    const second = await governed(path, url, () => Promise.resolve(fresh), used);
    if (second.kind === 'ok') return second.body;
    throw reconnectRequired();
  }

  return {
    organizationId: deps.organizationId,

    async get<T = unknown>(
      rawPath: string,
      query?: ZohoQuery,
      opts?: { cacheTtlMs?: number },
    ): Promise<ZohoGetResult<T>> {
      const { path, url, safeUrl } = buildRequest(rawPath, query);
      const ttl = opts?.cacheTtlMs;
      if (deps.cache && ttl !== undefined && ttl > 0 && CACHEABLE.test(path)) {
        const key = `${deps.cacheKeyPrefix}${url.slice(origin.length)}`;
        const { value, cached } = await deps.cache.wrap(key, ttl, () => load(path, url), deps.note);
        return { body: value as T, url: safeUrl, cached };
      }
      const body = await load(path, url);
      return { body: body as T, url: safeUrl, cached: false };
    },

    webUrl(kind: ZohoWebKind, id?: string): string {
      const root = `${webBase}/app/${encodeURIComponent(deps.organizationId)}`;
      if (kind === 'organization' || id === undefined) return root;
      return `${root}#/${WEB_ROUTES[kind]}/${encodeURIComponent(id)}`;
    },

    info: () => ({ ...deps.connection, scopes: [...deps.connection.scopes] }),

    snapshot: () => deps.governor.snapshot(deps.scope),
  };
}
