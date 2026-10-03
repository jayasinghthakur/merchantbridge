import { randomBytes } from 'node:crypto';
import { ZOHO_DATA_CENTERS } from '@mb/auth';
import type { DemoDataset, FakeZoho } from '@mb/zoho-inventory';
import { createDemoDataset, createFakeZoho } from '@mb/zoho-inventory';

/**
 * In-process stand-in for Zoho in local "fake live" mode (MB_DEV_FAKE_ZOHO=true, never production). It is passed to
 * createAppContext as the outbound `fetch`, so the real OAuth client, token provider, ZohoClient, governor and
 * ToolRuntime all run unchanged; only the network is replaced:
 *
 * - IN accounts server, `POST /oauth/v2/token`: `authorization_code` (one-time codes from the fake consent page) and
 *   `refresh_token` grants, answered in Zoho's token-response shape;
 * - IN accounts server, `POST /oauth/v2/revoke/token`: revokes a refresh token this fake issued;
 * - IN Inventory API domain: a wire-compatible FakeZoho over the demo dataset.
 *
 * Every other host (other data centers, Turnstile, anything) is refused with FakeUpstreamBlockedError: no real
 * network traffic leaves the process in this mode.
 */

export const FAKE_DC = ZOHO_DATA_CENTERS.in;
/** Zoho documents a 60 s lifetime for authorization codes (docs/notes/zoho.md). */
const AUTH_CODE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_S = 3600;
/** The call log is for tests and debugging; a long-running dev server keeps only the most recent entries. */
const MAX_CALLS = 500;

export class FakeUpstreamBlockedError extends Error {
  constructor(origin: string) {
    super(
      `MB_DEV_FAKE_ZOHO: outbound request to ${origin} blocked; fake-live mode serves only the fake Zoho IN accounts and API hosts.`,
    );
    this.name = 'FakeUpstreamBlockedError';
  }
}

/** What the fake saw; never secrets (no codes, tokens or client secrets). */
export interface FakeUpstreamCall {
  host: string;
  path: string;
  grantType?: string;
  status: number;
}

export interface FakeUpstreamOptions {
  /** The Zoho client the server is configured with; token grants from any other client get `invalid_client`. */
  clientId: string;
  clientSecret: string;
  /** Must match the `redirect_uri` sent with an authorization-code grant, as at Zoho. */
  redirectUri: string;
  now?: () => number;
  dataset?: DemoDataset;
}

export interface FakeUpstream {
  fetch: typeof fetch;
  fake: FakeZoho;
  organization: { id: string; name: string };
  /** Mints a refresh token the fake accounts server accepts (used to seed the local tenant). */
  mintRefreshToken(): string;
  /** A one-time authorization code, valid for 60 s (used by the fake consent page). */
  issueAuthCode(): string;
  readonly calls: readonly FakeUpstreamCall[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  });
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(24).toString('hex')}`;
}

async function formBody(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<URLSearchParams> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') return new URLSearchParams(init.body);
    if (init.body instanceof URLSearchParams) return init.body;
  }
  if (input instanceof Request) return new URLSearchParams(await input.clone().text());
  return new URLSearchParams();
}

export function createFakeUpstream(opts: FakeUpstreamOptions): FakeUpstream {
  const now = opts.now ?? Date.now;
  const dataset = opts.dataset ?? createDemoDataset({ now: now() });
  const fake = createFakeZoho({ dataset });
  const accountsHost = new URL(FAKE_DC.accountsServer).host;
  const apiHost = new URL(FAKE_DC.apiDomain).host;

  const refreshTokens = new Set<string>();
  const authCodes = new Map<string, number>(); // code -> expiry (epoch ms)
  const calls: FakeUpstreamCall[] = [];

  const mintRefreshToken = (): string => {
    const token = opaque('1000.devfake.');
    refreshTokens.add(token);
    return token;
  };

  const record = (url: URL, status: number, grantType?: string): void => {
    calls.push({ host: url.host, path: url.pathname, status, ...(grantType ? { grantType } : {}) });
    if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
  };

  async function token(url: URL, params: URLSearchParams): Promise<Response> {
    const grantType = params.get('grant_type') ?? '';
    const answer = (status: number, body: unknown): Response => {
      record(url, status, grantType);
      return json(status, body);
    };
    // Zoho answers token errors with HTTP 200 and an `error` field.
    if (
      params.get('client_id') !== opts.clientId ||
      params.get('client_secret') !== opts.clientSecret
    ) {
      return answer(200, { error: 'invalid_client' });
    }
    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const expires = authCodes.get(code);
      authCodes.delete(code); // single use, whatever the outcome
      if (expires === undefined || expires < now()) return answer(200, { error: 'invalid_code' });
      if (params.get('redirect_uri') !== opts.redirectUri) {
        return answer(200, { error: 'invalid_redirect_uri' });
      }
      return answer(200, {
        access_token: await fake.tokens.get(),
        refresh_token: mintRefreshToken(),
        api_domain: FAKE_DC.apiDomain,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_S,
      });
    }
    if (grantType === 'refresh_token') {
      if (!refreshTokens.has(params.get('refresh_token') ?? '')) {
        return answer(200, { error: 'invalid_code' });
      }
      const next = await fake.tokens.refreshAfterUnauthorized(await fake.tokens.get());
      return answer(200, {
        access_token: next,
        api_domain: FAKE_DC.apiDomain,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_S,
      });
    }
    return answer(400, { error: 'unsupported_grant_type' });
  }

  function revoke(url: URL, params: URLSearchParams): Response {
    const known = refreshTokens.delete(params.get('token') ?? '');
    record(url, known ? 200 : 400);
    return known ? json(200, { status: 'success' }) : json(400, { error: 'invalid_token' });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === 'https:' && url.host === accountsHost) {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (method === 'POST' && url.pathname === '/oauth/v2/token') {
        return token(url, await formBody(input, init));
      }
      if (method === 'POST' && url.pathname === '/oauth/v2/revoke/token') {
        return revoke(url, await formBody(input, init));
      }
      record(url, 404);
      return json(404, { error: 'not_found' });
    }
    if (url.protocol === 'https:' && url.host === apiHost) {
      const res = await fake.fetch(input, init);
      record(url, res.status);
      return res;
    }
    throw new FakeUpstreamBlockedError(url.origin);
  };

  return {
    fetch: fetchImpl,
    fake,
    organization: {
      id: dataset.organization.organization_id,
      name: dataset.organization.name,
    },
    mintRefreshToken,
    issueAuthCode() {
      const at = now();
      for (const [c, expires] of authCodes) if (expires < at) authCodes.delete(c);
      const code = opaque('1000.devcode.');
      authCodes.set(code, at + AUTH_CODE_TTL_MS);
      return code;
    },
    get calls() {
      return calls;
    },
  };
}
