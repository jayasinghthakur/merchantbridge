import { ConnectorError, ManualClock, MemoryKv } from '@mb/core';
import { describe, expect, it } from 'vitest';
import {
  ZOHO_DATA_CENTERS,
  completeConnect,
  createAccessTokenProvider,
  createStateSigner,
  createTokenVault,
  createZohoOAuthClient,
} from '../src/index';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  CapturingLogger,
  FakeAccounts,
  InMemoryConnectionStore,
  REDIRECT_URI,
  STATE_SECRET,
  VAULT_KEY,
} from './fakes';

describe('secrets never reach logs or errors', () => {
  it('runs connect, refresh, 401-refresh, throttle, invalid_grant, revoke and failures with a capturing logger', async () => {
    const clock = new ManualClock();
    const kv = new MemoryKv(clock);
    const log = new CapturingLogger();
    const fake = new FakeAccounts();
    fake.apiDomain = 'https://api.zoho.in'; // forces the api_domain fallback log line
    const vault = createTokenVault(VAULT_KEY);
    const connections = new InMemoryConnectionStore();
    const stateSigner = createStateSigner({ secret: STATE_SECRET, kv, clock });
    const oauth = createZohoOAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fake.fetch,
      log,
    });
    const provider = createAccessTokenProvider({ kv, clock, vault, connections, oauth, log });
    const errors: unknown[] = [];
    const states: string[] = [];
    const capture = async (p: Promise<unknown>) => {
      try {
        return await p;
      } catch (e) {
        errors.push(e);
        return undefined;
      }
    };
    const consentQuery = (overrides: Record<string, string> = {}) => {
      const state = stateSigner.sign({ dc: 'in', purpose: 'connect' });
      states.push(state);
      return {
        code: fake.issueCode(),
        state,
        location: 'in',
        'accounts-server': ZOHO_DATA_CENTERS.in.accountsServer,
        ...overrides,
      };
    };

    // Connect (success), then failure variants.
    const connected = await completeConnect({
      query: consentQuery(),
      stateSigner,
      oauth,
      vault,
      log,
    });
    if (!connected.ok) throw new Error('connect failed');
    await completeConnect({
      query: consentQuery({ code: '1000.unknown.CODESECRETX' }),
      stateSigner,
      oauth,
      vault,
      log,
    });
    await completeConnect({
      query: consentQuery({ 'accounts-server': 'https://evil.test' }),
      stateSigner,
      oauth,
      vault,
      log,
    });
    const replay = consentQuery();
    await completeConnect({ query: replay, stateSigner, oauth, vault, log });
    await completeConnect({ query: replay, stateSigner, oauth, vault, log });

    const conn = await connections.upsert({
      tenantId: 'tenant_a',
      provider: 'zoho_inventory',
      dc: connected.dc,
      accountsServer: connected.accountsServer,
      apiDomain: connected.apiDomain,
      organizationId: '60012345678',
      organizationName: null,
      plan: 'free',
      scopes: [],
      refreshTokenEnc: connected.refreshTokenEnc,
    });
    await provider.primeAccessToken(conn, connected.accessToken, connected.expiresInS);

    // Refresh paths.
    const t1 = await provider.getAccessToken(conn);
    const t2 = await provider.refreshAfterUnauthorized(conn, t1);
    await provider.refreshAfterUnauthorized(conn, t1);
    fake.mode = 'throttle';
    await capture(provider.refreshAfterUnauthorized(conn, t2));
    clock.advance(61_000);
    fake.mode = 'server_error';
    await capture(provider.refreshAfterUnauthorized(conn, t2));
    clock.advance(6_000);
    fake.mode = 'ok';
    await capture(
      oauth.revoke({
        token: fake.issuedRefreshTokens[0] ?? '',
        accountsServer: conn.accountsServer,
      }),
    );
    await capture(provider.refreshAfterUnauthorized(conn, t2)); // invalid_grant after revoke
    await capture(provider.getAccessToken(conn)); // cooldown path
    fake.mode = 'bad_client';
    await capture(
      oauth.exchangeCode({ code: fake.issueCode(), accountsServer: conn.accountsServer }),
    );

    const secrets = [
      CLIENT_SECRET,
      STATE_SECRET,
      VAULT_KEY,
      ...states,
      ...fake.issuedCodes,
      ...fake.issuedRefreshTokens,
      ...fake.issuedAccessTokens,
      '1000.unknown.CODESECRETX',
      Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    ];
    expect(fake.issuedAccessTokens.length).toBeGreaterThanOrEqual(3);
    expect(log.entries.length).toBeGreaterThan(5);
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.some((e) => e instanceof ConnectorError && e.code === 'RECONNECT_REQUIRED')).toBe(
      true,
    );

    const logged = log.dump();
    const errorText = JSON.stringify(
      errors.map((e) =>
        e instanceof ConnectorError ? { ...e.toBody(), stack: e.stack } : { message: String(e) },
      ),
    );
    for (const secret of secrets) {
      expect(logged).not.toContain(secret);
      expect(errorText).not.toContain(secret);
    }
  });
});
