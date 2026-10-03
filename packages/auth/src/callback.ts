import type { ConnectErrorReason, Logger } from '@mb/core';
import { isConnectorError, noopLogger } from '@mb/core';
import type { ZohoDcKey } from './dc';
import { classifyAccountsServer } from './dc';
import type { ExchangeResult, ZohoOAuthClient } from './oauth-client';
import { OAuthExchangeError } from './oauth-client';
import type { StateSigner, StateVerification } from './state';
import type { TokenVault } from './vault';

/**
 * OAuth callback handling for GET /oauth/zoho/callback. Zoho redirects with
 * `?code&state&location&accounts-server` on consent, or `?error=access_denied` on deny
 * (acc_oauth_web-apps_authorization.txt, acc_oauth_multi-dc.txt).
 */

/** Fastify-style query object (repeated params arrive as arrays) or URLSearchParams. */
export type CallbackQuery = URLSearchParams | Readonly<Record<string, unknown>>;

/** Machine-readable cause for logs/metrics; the user-facing page only sees `reason`. */
export type ConnectFailureDetail =
  | 'zoho_access_denied'
  | 'zoho_error'
  | 'missing_param'
  | 'state_malformed'
  | 'state_bad_signature'
  | 'state_expired'
  | 'state_replayed'
  | 'unknown_accounts_server'
  | 'unsupported_dc'
  | 'dc_mismatch'
  | 'exchange_rejected'
  | 'throttled'
  | 'upstream_unavailable'
  | 'internal';

export interface ConnectFailure {
  ok: false;
  reason: ConnectErrorReason;
  detail: ConnectFailureDetail;
  retryAfterS?: number;
}

export interface ParsedCallback {
  ok: true;
  code: string;
  state: string;
  /** Raw, attacker-controllable value; validate with classifyAccountsServer before use. */
  accountsServer: string;
  location: string;
}

const MAX_PARAM_LENGTH = 2048;

/** Returns the single string value of a param; undefined when absent, repeated, empty or oversized. */
function param(query: CallbackQuery, name: string): string | undefined {
  let value: unknown;
  if (query instanceof URLSearchParams) {
    const all = query.getAll(name);
    value = all.length === 1 ? all[0] : undefined;
  } else {
    value = Object.hasOwn(query, name) ? query[name] : undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PARAM_LENGTH) {
    return undefined;
  }
  return value;
}

function has(query: CallbackQuery, name: string): boolean {
  return query instanceof URLSearchParams ? query.has(name) : Object.hasOwn(query, name);
}

/** Validates presence and shape only; does not verify state or contact Zoho. */
export function parseCallback(query: CallbackQuery): ParsedCallback | ConnectFailure {
  if (has(query, 'error')) {
    return param(query, 'error') === 'access_denied'
      ? { ok: false, reason: 'access_denied', detail: 'zoho_access_denied' }
      : { ok: false, reason: 'exchange_failed', detail: 'zoho_error' };
  }
  const code = param(query, 'code');
  const state = param(query, 'state');
  const accountsServer = param(query, 'accounts-server');
  const location = param(query, 'location');
  // A consent redirect always carries all four; anything less is a broken or forged callback.
  if (
    code === undefined ||
    state === undefined ||
    accountsServer === undefined ||
    location === undefined
  ) {
    return { ok: false, reason: 'invalid_state', detail: 'missing_param' };
  }
  return { ok: true, code, state, accountsServer, location };
}

export interface CompleteConnectInput {
  query: CallbackQuery;
  stateSigner: StateSigner;
  oauth: Pick<ZohoOAuthClient, 'exchangeCode'>;
  /** Encrypts the refresh token so its plaintext never leaves this package. */
  vault: TokenVault;
  log?: Logger;
}

export interface ConnectSuccess {
  ok: true;
  dc: ZohoDcKey;
  /** Our constant for the DC (not the callback's raw value). */
  accountsServer: string;
  apiDomain: string;
  location: string;
  /** From the signed state when re-connecting an existing tenant. */
  tenantId: string | null;
  /** Short-lived; use it for GET /organizations, then prime the token cache. Never log or persist it. */
  accessToken: string;
  expiresInS: number;
  /** Vault ciphertext, ready for ConnectionRecord.refreshTokenEnc. */
  refreshTokenEnc: string;
}

export type ConnectResult = ConnectSuccess | ConnectFailure;

/**
 * parse → verify + consume state → allow-list `accounts-server` and match it to the state's DC → exchange the
 * code at our constant accounts host. Every user-facing failure is a typed result; nothing here throws for them.
 */
export async function completeConnect(input: CompleteConnectInput): Promise<ConnectResult> {
  const log = input.log ?? noopLogger;
  const fail = (f: Omit<ConnectFailure, 'ok'>): ConnectFailure => {
    log.warn({ reason: f.reason, detail: f.detail }, 'zoho connect failed');
    return { ok: false, ...f };
  };

  const parsed = parseCallback(input.query);
  if (!parsed.ok) return fail(parsed);

  let verified: StateVerification;
  try {
    verified = await input.stateSigner.verifyAndConsume(parsed.state);
  } catch (e) {
    // Kv outage while consuming the nonce: still a typed result, so the app can show /connect/error.
    log.error(
      { err_name: e instanceof Error ? e.name : typeof e },
      'oauth state verification failed',
    );
    return fail({ reason: 'internal', detail: 'internal' });
  }
  if (!verified.ok) return fail({ reason: 'invalid_state', detail: `state_${verified.error}` });

  const match = classifyAccountsServer(parsed.accountsServer);
  if (match.kind === 'unknown') {
    return fail({ reason: 'invalid_state', detail: 'unknown_accounts_server' });
  }
  if (match.kind === 'unsupported')
    return fail({ reason: 'unsupported_dc', detail: 'unsupported_dc' });
  if (match.dc.key !== verified.payload.dc) {
    // The merchant's Zoho account lives in a different DC than the one picked at /connect.
    return fail({ reason: 'dc_mismatch', detail: 'dc_mismatch' });
  }

  let exchanged: ExchangeResult;
  try {
    exchanged = await input.oauth.exchangeCode({
      code: parsed.code,
      accountsServer: match.dc.accountsServer,
    });
  } catch (e) {
    if (e instanceof OAuthExchangeError) {
      return fail({ reason: 'exchange_failed', detail: 'exchange_rejected' });
    }
    if (isConnectorError(e)) {
      return fail({
        reason: 'exchange_failed',
        detail: e.retryAfterS === undefined ? 'upstream_unavailable' : 'throttled',
        ...(e.retryAfterS === undefined ? {} : { retryAfterS: e.retryAfterS }),
      });
    }
    log.error(
      { err_name: e instanceof Error ? e.name : typeof e },
      'unexpected error in zoho connect',
    );
    return fail({ reason: 'internal', detail: 'internal' });
  }

  return {
    ok: true,
    dc: exchanged.dc,
    accountsServer: match.dc.accountsServer,
    apiDomain: exchanged.apiDomain,
    location: parsed.location,
    tenantId: verified.payload.tenantId ?? null,
    accessToken: exchanged.accessToken,
    expiresInS: exchanged.expiresInS,
    refreshTokenEnc: input.vault.encrypt(exchanged.refreshToken),
  };
}
