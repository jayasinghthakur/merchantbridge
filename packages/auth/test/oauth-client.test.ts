import { ConnectorError } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { OAuthExchangeError, ZOHO_DATA_CENTERS, createZohoOAuthClient } from '../src/index';
import { CLIENT_ID, CLIENT_SECRET, FakeAccounts, REDIRECT_URI } from './fakes';

const IN = ZOHO_DATA_CENTERS.in.accountsServer;

function setup() {
  const fake = new FakeAccounts();
  const oauth = createZohoOAuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetch: fake.fetch,
  });
  return { fake, oauth };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('exchangeCode', () => {
  it('POSTs a form to {accounts}/oauth/v2/token and returns tokens', async () => {
    const { fake, oauth } = setup();
    const code = fake.issueCode();
    const out = await oauth.exchangeCode({ code, accountsServer: IN });

    expect(out).toEqual({
      dc: 'in',
      accessToken: fake.issuedAccessTokens[0],
      refreshToken: fake.issuedRefreshTokens[0],
      apiDomain: ZOHO_DATA_CENTERS.in.apiDomain,
      expiresInS: 3600,
    });
    const [req] = fake.requests;
    expect(req?.url).toBe(`${IN}/oauth/v2/token`); // secrets in the body, never the URL
    expect(req?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(req?.params ?? [])).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    });
  });

  it('replaces an undocumented api_domain with the DC map value', async () => {
    const { fake, oauth } = setup();
    fake.apiDomain = 'https://api.zoho.in';
    const out = await oauth.exchangeCode({ code: fake.issueCode(), accountsServer: IN });
    expect(out.apiDomain).toBe(ZOHO_DATA_CENTERS.in.apiDomain);
  });

  it('maps invalid_code to OAuthExchangeError (exchange_failed)', async () => {
    const { oauth } = setup();
    const e = await caught(oauth.exchangeCode({ code: '1000.bogus.code', accountsServer: IN }));
    expect(e).toBeInstanceOf(OAuthExchangeError);
    expect(e).toMatchObject({ reason: 'exchange_failed', detail: 'invalid_code' });
  });

  it('rejects a code that was already used', async () => {
    const { fake, oauth } = setup();
    const code = fake.issueCode();
    await oauth.exchangeCode({ code, accountsServer: IN });
    await expect(oauth.exchangeCode({ code, accountsServer: IN })).rejects.toBeInstanceOf(
      OAuthExchangeError,
    );
  });

  it('fails when Zoho omits the refresh token', async () => {
    const { fake, oauth } = setup();
    fake.omitRefreshToken = true;
    const e = await caught(oauth.exchangeCode({ code: fake.issueCode(), accountsServer: IN }));
    expect(e).toMatchObject({ reason: 'exchange_failed', detail: 'missing_refresh_token' });
  });

  it('maps throttling to a retryable UPSTREAM_ERROR with retry_after_s 60', async () => {
    for (const mode of ['throttle', 'throttle_429'] as const) {
      const { fake, oauth } = setup();
      fake.mode = mode;
      const e = await caught(oauth.exchangeCode({ code: fake.issueCode(), accountsServer: IN }));
      expect(e).toBeInstanceOf(ConnectorError);
      expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, retryAfterS: 60 });
    }
  });

  it('never contacts an unknown accounts server', async () => {
    const { fake, oauth } = setup();
    for (const accountsServer of [
      'https://evil.test',
      'https://accounts.zoho.uk',
      'http://accounts.zoho.in',
    ]) {
      await expect(oauth.exchangeCode({ code: 'c', accountsServer })).rejects.toBeInstanceOf(
        ConnectorError,
      );
      await expect(oauth.refresh({ refreshToken: 'r', accountsServer })).rejects.toBeInstanceOf(
        ConnectorError,
      );
      await expect(oauth.revoke({ token: 't', accountsServer })).rejects.toBeInstanceOf(
        ConnectorError,
      );
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('returns a new access token', async () => {
    const { fake, oauth } = setup();
    const refreshToken = fake.issueRefreshToken();
    const out = await oauth.refresh({ refreshToken, accountsServer: IN });
    expect(out).toEqual({
      accessToken: fake.issuedAccessTokens[0],
      apiDomain: ZOHO_DATA_CENTERS.in.apiDomain,
      expiresInS: 3600,
    });
    expect(Object.fromEntries(fake.requests[0]?.params ?? [])).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    });
  });

  it('maps a revoked refresh token (invalid_code) to RECONNECT_REQUIRED', async () => {
    const { fake, oauth } = setup();
    const refreshToken = fake.issueRefreshToken();
    fake.revokeRefreshToken(refreshToken);
    const e = await caught(oauth.refresh({ refreshToken, accountsServer: IN }));
    expect(e).toMatchObject({ code: 'RECONNECT_REQUIRED', retryable: false });
  });

  it('maps invalid_grant to RECONNECT_REQUIRED', async () => {
    const oauth = createZohoOAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: async () => ({ status: 400, text: async () => '{"error":"invalid_grant"}' }),
    });
    const e = await caught(oauth.refresh({ refreshToken: 'r', accountsServer: IN }));
    expect(e).toMatchObject({ code: 'RECONNECT_REQUIRED' });
  });

  it('maps throttling to a retryable UPSTREAM_ERROR with retry_after_s 60', async () => {
    const { fake, oauth } = setup();
    fake.mode = 'throttle';
    const e = await caught(
      oauth.refresh({ refreshToken: fake.issueRefreshToken(), accountsServer: IN }),
    );
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, retryAfterS: 60 });
  });

  it('maps 5xx and network failures to a retryable UPSTREAM_ERROR', async () => {
    for (const mode of ['server_error', 'network'] as const) {
      const { fake, oauth } = setup();
      fake.mode = mode;
      const e = await caught(
        oauth.refresh({ refreshToken: fake.issueRefreshToken(), accountsServer: IN }),
      );
      expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, retryAfterS: undefined });
    }
  });

  it.each([500, 502, 503])(
    'treats HTTP %i with a JSON error body as transient, not as client misconfiguration',
    async (status) => {
      const oauth = createZohoOAuthClient({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetch: async () => ({ status, text: async () => '{"error":"internal_error"}' }),
      });
      const e = await caught(oauth.refresh({ refreshToken: 'r', accountsServer: IN }));
      expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
      const x = await caught(oauth.exchangeCode({ code: 'c', accountsServer: IN }));
      expect(x).toBeInstanceOf(ConnectorError);
      expect(x).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    },
  );

  it('maps client misconfiguration to a non-retryable UPSTREAM_ERROR', async () => {
    const { fake, oauth } = setup();
    fake.mode = 'bad_client';
    const e = await caught(
      oauth.refresh({ refreshToken: fake.issueRefreshToken(), accountsServer: IN }),
    );
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
  });
});

describe('revoke', () => {
  it('POSTs to /oauth/v2/revoke/token with Basic client auth', async () => {
    const { fake, oauth } = setup();
    const token = fake.issueRefreshToken();
    expect(await oauth.revoke({ token, accountsServer: IN })).toBe('revoked');
    const [req] = fake.requests;
    expect(req?.url).toBe(`${IN}/oauth/v2/revoke/token`);
    expect(req?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(Object.fromEntries(req?.params ?? [])).toEqual({ token, token_type: 'refresh_token' });
  });

  it('treats 400 as an already-invalid token', async () => {
    const { fake, oauth } = setup();
    fake.revokeStatus = 400;
    expect(await oauth.revoke({ token: 't', accountsServer: IN, tokenType: 'access_token' })).toBe(
      'invalid_token',
    );
    expect(fake.requests[0]?.params.get('token_type')).toBe('access_token');
  });

  it('falls back to the legacy endpoint when the current one is missing', async () => {
    const { fake, oauth } = setup();
    fake.revokeStatus = 404;
    expect(await oauth.revoke({ token: 't', accountsServer: IN })).toBe('revoked');
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/oauth/v2/revoke/token',
      '/oauth/v2/token/revoke',
    ]);
    expect(fake.requests[1]?.url).toBe(`${IN}/oauth/v2/token/revoke`);
  });

  it('throws a retryable UPSTREAM_ERROR when Zoho is unavailable', async () => {
    const { fake, oauth } = setup();
    fake.mode = 'server_error';
    const e = await caught(oauth.revoke({ token: 't', accountsServer: IN }));
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });

  it('reports rejected client credentials as a non-retryable UPSTREAM_ERROR', async () => {
    const fake = new FakeAccounts();
    const oauth = createZohoOAuthClient({
      clientId: CLIENT_ID,
      clientSecret: 'cs_WRONG_SECRET',
      redirectUri: REDIRECT_URI,
      fetch: fake.fetch,
    });
    const e = await caught(oauth.revoke({ token: 't', accountsServer: IN }));
    expect(e).toBeInstanceOf(ConnectorError);
    expect(e).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
    expect(fake.requests.map((r) => r.path)).toEqual(['/oauth/v2/revoke/token']);
  });
});
