import type { Logger } from '@mb/core';
import { noopLogger } from '@mb/core';
import { z } from 'zod';
import type { ZohoDataCenter, ZohoDcKey } from './dc';
import { classifyAccountsServer, resolveApiDomain } from './dc';
import {
  accountsUnavailableError,
  oauthClientMisconfiguredError,
  reconnectRequiredError,
  tokenThrottledError,
  unknownAccountsServerError,
} from './errors';

/**
 * Zoho Accounts client for a confidential server-based OAuth client. Shapes come from
 * docs/vendor/zoho/accounts/acc_oauth_web-apps_*.txt and acc_oauth_revoke-refresh-token.txt.
 *
 * Secrets travel only in POST bodies / the Basic header, never in URLs, error messages or logs.
 */

/** The subset of `fetch` this client uses; the global `fetch` satisfies it. Tests inject a fake accounts server. */
export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface ZohoOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  /** Must match the redirect URI used in the authorization request. */
  redirectUri: string;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  log?: Logger;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
}

export interface ExchangeResult {
  dc: ZohoDcKey;
  accessToken: string;
  refreshToken: string;
  /** Validated Inventory API origin for this DC (never an arbitrary host from the response). */
  apiDomain: string;
  expiresInS: number;
}

export interface RefreshResult {
  accessToken: string;
  apiDomain: string;
  expiresInS: number;
}

/** `invalid_token`: Zoho answered 400 (already revoked, wrong type, or not ours); safe to treat as revoked. */
export type RevokeOutcome = 'revoked' | 'invalid_token';

export interface ZohoOAuthClient {
  /**
   * grant_type=authorization_code. Throws OAuthExchangeError when Zoho rejects the code, or ConnectorError
   * (UPSTREAM_ERROR) when throttled or unreachable.
   */
  exchangeCode(input: { code: string; accountsServer: string }): Promise<ExchangeResult>;
  /**
   * grant_type=refresh_token. Throws ConnectorError: RECONNECT_REQUIRED for a revoked/invalid refresh token,
   * UPSTREAM_ERROR (retryable, retry_after_s 60) when throttled, UPSTREAM_ERROR otherwise.
   */
  refresh(input: { refreshToken: string; accountsServer: string }): Promise<RefreshResult>;
  /** POST {accounts}/oauth/v2/revoke/token with Basic client auth. Throws ConnectorError when unreachable. */
  revoke(input: {
    token: string;
    accountsServer: string;
    tokenType?: 'refresh_token' | 'access_token';
  }): Promise<RevokeOutcome>;
}

/** Error labels we recognise; anything else is logged as `other` so no upstream text reaches logs. */
const KNOWN_ZOHO_ERRORS = [
  'invalid_code',
  'invalid_grant', // UNVERIFIED for Zoho (docs only show invalid_code); standard OAuth, handled defensively.
  'invalid_client',
  'invalid_client_secret',
  'invalid_redirect_uri',
  'Access Denied', // UNVERIFIED: observed throttle body, not in the vendored docs.
] as const;

export type ZohoErrorLabel = (typeof KNOWN_ZOHO_ERRORS)[number] | 'other';

function labelZohoError(raw: string): ZohoErrorLabel {
  return (KNOWN_ZOHO_ERRORS as readonly string[]).includes(raw) ? (raw as ZohoErrorLabel) : 'other';
}

/** Zoho rejected the authorization code exchange. Maps to ConnectErrorReason `exchange_failed`. */
export class OAuthExchangeError extends Error {
  readonly reason = 'exchange_failed' as const;
  readonly detail: ZohoErrorLabel | 'missing_refresh_token';

  constructor(detail: ZohoErrorLabel | 'missing_refresh_token') {
    super('Zoho did not accept the authorization code.');
    this.name = 'OAuthExchangeError';
    this.detail = detail;
  }
}

const tokenSuccessSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  api_domain: z.string().optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
});

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

type TokenSuccess = z.output<typeof tokenSuccessSchema>;

type TokenFailure =
  | { kind: 'invalid_grant'; label: ZohoErrorLabel }
  | { kind: 'client_config'; label: ZohoErrorLabel }
  | { kind: 'throttled'; label: ZohoErrorLabel }
  | { kind: 'rejected'; label: ZohoErrorLabel }
  | { kind: 'transient'; status: number | null };

type TokenOutcome = { ok: true; body: TokenSuccess } | { ok: false; failure: TokenFailure };

/** acc_oauth_web-apps_access-token.txt: "The lifetime of an access token is 1 hour (3600 seconds)." */
const DEFAULT_EXPIRES_IN_S = 3600;
const MAX_INPUT_LENGTH = 2048;

function expiresInSeconds(raw: number | string | undefined): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_EXPIRES_IN_S;
}

// UNVERIFIED: the throttle response shape is not in the vendored docs; match the common forms defensively.
function isThrottle(
  label: ZohoErrorLabel,
  description: string | undefined,
  status: number,
): boolean {
  return (
    label === 'Access Denied' || status === 429 || /too many requests/i.test(description ?? '')
  );
}

function classify(status: number, error: string, description: string | undefined): TokenFailure {
  const label = labelZohoError(error);
  if (isThrottle(label, description, status)) return { kind: 'throttled', label };
  if (label === 'invalid_code' || label === 'invalid_grant')
    return { kind: 'invalid_grant', label };
  if (
    label === 'invalid_client' ||
    label === 'invalid_client_secret' ||
    label === 'invalid_redirect_uri'
  ) {
    return { kind: 'client_config', label };
  }
  return { kind: 'rejected', label };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function requireInput(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INPUT_LENGTH) {
    throw new Error(`${name} is missing or too long.`);
  }
}

export function createZohoOAuthClient(opts: ZohoOAuthClientOptions): ZohoOAuthClient {
  const fetchImpl: FetchLike = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? noopLogger;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  requireInput(opts.clientId, 'clientId');
  requireInput(opts.clientSecret, 'clientSecret');
  requireInput(opts.redirectUri, 'redirectUri');

  /** Resolves to our constant DC record; a stored or callback-supplied host is never used for requests. */
  function dcFor(accountsServer: string): Readonly<ZohoDataCenter> {
    const match = classifyAccountsServer(accountsServer);
    if (match.kind !== 'supported') throw unknownAccountsServerError();
    return match.dc;
  }

  async function post(
    url: string,
    params: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; text: string } | null> {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          ...headers,
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    } catch {
      // Network error or timeout. The error itself is dropped: it is not agent-safe and adds nothing to logs.
      return null;
    }
  }

  async function requestToken(
    op: 'exchange' | 'refresh',
    dc: Readonly<ZohoDataCenter>,
    params: Record<string, string>,
  ): Promise<TokenOutcome> {
    const res = await post(`${dc.accountsServer}/oauth/v2/token`, params);
    let failure: TokenFailure;
    if (res === null) {
      failure = { kind: 'transient', status: null };
    } else {
      const json = parseJson(res.text);
      const ok = tokenSuccessSchema.safeParse(json);
      if (res.status >= 200 && res.status < 300 && ok.success) return { ok: true, body: ok.data };
      const err = tokenErrorSchema.safeParse(json);
      if (err.success) failure = classify(res.status, err.data.error, err.data.error_description);
      else if (res.status === 429) failure = { kind: 'throttled', label: 'other' };
      else if (res.status >= 400 && res.status < 500)
        failure = { kind: 'rejected', label: 'other' };
      else failure = { kind: 'transient', status: res.status };
      // A 5xx is a server-side failure whatever its body says; only a throttle outranks it.
      if (res.status >= 500 && failure.kind !== 'throttled') {
        failure = { kind: 'transient', status: res.status };
      }
    }
    log.warn(
      {
        op,
        dc: dc.key,
        failure: failure.kind,
        ...(failure.kind === 'transient'
          ? { status: failure.status }
          : { zoho_error: failure.label }),
      },
      'zoho token request failed',
    );
    return { ok: false, failure };
  }

  function apiDomainFor(dc: Readonly<ZohoDataCenter>, returned: unknown): string {
    const { apiDomain, fromResponse } = resolveApiDomain(dc.key, returned);
    if (!fromResponse) {
      log.info(
        { dc: dc.key },
        'token response api_domain is not the documented Inventory host; using DC map',
      );
    }
    return apiDomain;
  }

  async function exchangeCode(input: {
    code: string;
    accountsServer: string;
  }): Promise<ExchangeResult> {
    const dc = dcFor(input.accountsServer);
    requireInput(input.code, 'code');
    const out = await requestToken('exchange', dc, {
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      code: input.code,
    });
    if (!out.ok) {
      const f = out.failure;
      if (f.kind === 'throttled') throw tokenThrottledError();
      if (f.kind === 'transient') throw accountsUnavailableError();
      throw new OAuthExchangeError(f.label);
    }
    // Only issued with access_type=offline; buildAuthorizeUrl always sends it with prompt=consent.
    if (out.body.refresh_token === undefined) throw new OAuthExchangeError('missing_refresh_token');
    return {
      dc: dc.key,
      accessToken: out.body.access_token,
      refreshToken: out.body.refresh_token,
      apiDomain: apiDomainFor(dc, out.body.api_domain),
      expiresInS: expiresInSeconds(out.body.expires_in),
    };
  }

  async function refresh(input: {
    refreshToken: string;
    accountsServer: string;
  }): Promise<RefreshResult> {
    const dc = dcFor(input.accountsServer);
    requireInput(input.refreshToken, 'refreshToken');
    const out = await requestToken('refresh', dc, {
      grant_type: 'refresh_token',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: input.refreshToken,
    });
    if (!out.ok) {
      switch (out.failure.kind) {
        case 'invalid_grant':
          throw reconnectRequiredError();
        case 'throttled':
          throw tokenThrottledError();
        case 'transient':
          throw accountsUnavailableError();
        case 'client_config':
        case 'rejected':
          throw oauthClientMisconfiguredError();
      }
    }
    return {
      accessToken: out.body.access_token,
      apiDomain: apiDomainFor(dc, out.body.api_domain),
      expiresInS: expiresInSeconds(out.body.expires_in),
    };
  }

  async function revoke(input: {
    token: string;
    accountsServer: string;
    tokenType?: 'refresh_token' | 'access_token';
  }): Promise<RevokeOutcome> {
    // UNVERIFIED: the revoke doc says {accounts} is where the *app* is registered; we use the merchant's DC
    // accounts server (probe P-5 in docs/notes/zoho.md).
    const dc = dcFor(input.accountsServer);
    requireInput(input.token, 'token');
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`, 'utf8').toString('base64');
    const res = await post(
      `${dc.accountsServer}/oauth/v2/revoke/token`,
      { token: input.token, token_type: input.tokenType ?? 'refresh_token' },
      { authorization: `Basic ${basic}` },
    );
    if (res?.status === 200) return 'revoked';
    if (res?.status === 400) return 'invalid_token';

    let legacyStatus: number | null = null;
    let finalStatus = res?.status ?? null;
    if (finalStatus === 404 || finalStatus === 405) {
      // Older endpoint from the Inventory OAuth page (docs/vendor/zoho/accounts/oauth.txt, Step 5), which shows
      // `token` as a query param. UNVERIFIED: sent in the form body instead, to keep the token out of URLs.
      const legacy = await post(`${dc.accountsServer}/oauth/v2/token/revoke`, {
        token: input.token,
      });
      if (legacy?.status === 200) return 'revoked';
      if (legacy?.status === 400) return 'invalid_token';
      legacyStatus = legacy?.status ?? null;
      finalStatus = legacyStatus;
    }
    log.warn(
      { op: 'revoke', dc: dc.key, status: res?.status ?? null, legacy_status: legacyStatus },
      'zoho token revoke failed',
    );
    // The revoke doc lists only 200 and 400. Other statuses: 429 is a throttle, any other 4xx (e.g. 401 for
    // rejected Basic credentials) will not succeed on retry, and network errors / 5xx are transient.
    if (finalStatus === 429) throw tokenThrottledError();
    if (finalStatus !== null && finalStatus >= 400 && finalStatus < 500) {
      throw oauthClientMisconfiguredError();
    }
    throw accountsUnavailableError();
  }

  return { exchangeCode, refresh, revoke };
}
