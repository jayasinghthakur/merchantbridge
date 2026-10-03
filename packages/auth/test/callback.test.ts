import { ManualClock, MemoryKv } from '@mb/core';
import { describe, expect, it } from 'vitest';
import {
  ZOHO_DATA_CENTERS,
  completeConnect,
  createStateSigner,
  createTokenVault,
  createZohoOAuthClient,
  parseCallback,
  type ZohoDcKey,
} from '../src/index';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  FakeAccounts,
  REDIRECT_URI,
  STATE_SECRET,
  VAULT_KEY,
  delegatingKv,
} from './fakes';

function setup() {
  const clock = new ManualClock();
  const kv = new MemoryKv(clock);
  const fake = new FakeAccounts();
  const stateSigner = createStateSigner({ secret: STATE_SECRET, kv, clock });
  const oauth = createZohoOAuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetch: fake.fetch,
  });
  const vault = createTokenVault(VAULT_KEY);
  /** The query Zoho would send back after consent for a merchant in `dc`. */
  const consent = (
    opts: { stateDc?: ZohoDcKey; accountsServer?: string; tenantId?: string } = {},
  ) => ({
    code: fake.issueCode(),
    state: stateSigner.sign({
      dc: opts.stateDc ?? 'in',
      purpose: 'connect',
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    }),
    location: 'in',
    'accounts-server': opts.accountsServer ?? ZOHO_DATA_CENTERS.in.accountsServer,
  });
  const run = (query: Record<string, unknown> | URLSearchParams) =>
    completeConnect({ query, stateSigner, oauth, vault });
  return { clock, fake, vault, consent, run };
}

describe('parseCallback', () => {
  it('maps error=access_denied', () => {
    expect(parseCallback({ error: 'access_denied', state: 'x' })).toEqual({
      ok: false,
      reason: 'access_denied',
      detail: 'zoho_access_denied',
    });
    expect(parseCallback({ error: 'Invalid Client' })).toMatchObject({ reason: 'exchange_failed' });
  });

  it('requires code, state, accounts-server and location', () => {
    const full = {
      code: 'c',
      state: 's',
      location: 'in',
      'accounts-server': 'https://accounts.zoho.in',
    };
    expect(parseCallback(full)).toEqual({
      ok: true,
      code: 'c',
      state: 's',
      location: 'in',
      accountsServer: 'https://accounts.zoho.in',
    });
    for (const key of Object.keys(full)) {
      const partial: Record<string, unknown> = { ...full };
      delete partial[key];
      expect(parseCallback(partial)).toMatchObject({
        ok: false,
        reason: 'invalid_state',
        detail: 'missing_param',
      });
    }
  });

  it('rejects repeated or non-string params', () => {
    const base = {
      code: 'c',
      state: 's',
      location: 'in',
      'accounts-server': 'https://accounts.zoho.in',
    };
    expect(parseCallback({ ...base, state: ['s1', 's2'] }).ok).toBe(false);
    expect(parseCallback({ ...base, code: 42 }).ok).toBe(false);
    const qs = new URLSearchParams(base);
    expect(parseCallback(qs).ok).toBe(true);
    qs.append('accounts-server', 'https://evil.test');
    expect(parseCallback(qs).ok).toBe(false);
  });
});

describe('completeConnect', () => {
  it('exchanges the code and returns an encrypted refresh token', async () => {
    const { fake, vault, consent, run } = setup();
    const out = await run(consent({ tenantId: 'tenant_a' }));
    expect(out).toMatchObject({
      ok: true,
      dc: 'in',
      accountsServer: ZOHO_DATA_CENTERS.in.accountsServer,
      apiDomain: ZOHO_DATA_CENTERS.in.apiDomain,
      location: 'in',
      tenantId: 'tenant_a',
      accessToken: fake.issuedAccessTokens[0],
      expiresInS: 3600,
    });
    if (!out.ok) throw new Error('unreachable');
    expect(out.refreshTokenEnc.startsWith('v1.')).toBe(true);
    expect(vault.decrypt(out.refreshTokenEnc)).toBe(fake.issuedRefreshTokens[0]);
    expect(fake.tokenRequests()).toHaveLength(1);
  });

  it('accepts URLSearchParams and returns tenantId null for a new tenant', async () => {
    const { consent, run } = setup();
    const out = await run(new URLSearchParams(consent()));
    expect(out).toMatchObject({ ok: true, tenantId: null });
  });

  it('maps access_denied without contacting Zoho', async () => {
    const { fake, run } = setup();
    expect(await run({ error: 'access_denied' })).toMatchObject({
      ok: false,
      reason: 'access_denied',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    'https://evil.test',
    'https://accounts.zoho.in.evil.test',
    'https://accounts.zoho.in@evil.test',
    'http://accounts.zoho.in',
  ])('rejects unknown accounts-server %s with no fetch', async (accountsServer) => {
    const { fake, consent, run } = setup();
    const out = await run(consent({ accountsServer }));
    expect(out).toEqual({ ok: false, reason: 'invalid_state', detail: 'unknown_accounts_server' });
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects an accounts-server that does not match the DC in the state, with no fetch', async () => {
    const { fake, consent, run } = setup();
    const out = await run(
      consent({ stateDc: 'in', accountsServer: ZOHO_DATA_CENTERS.eu.accountsServer }),
    );
    expect(out).toEqual({ ok: false, reason: 'dc_mismatch', detail: 'dc_mismatch' });
    expect(fake.requests).toHaveLength(0);
  });

  it('answers unsupported_dc for a known Zoho DC without an Inventory API', async () => {
    const { fake, consent, run } = setup();
    const out = await run(consent({ accountsServer: 'https://accounts.zoho.uk' }));
    expect(out).toMatchObject({ ok: false, reason: 'unsupported_dc' });
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects a replayed callback', async () => {
    const { fake, consent, run } = setup();
    const query = consent();
    expect((await run(query)).ok).toBe(true);
    expect(await run(query)).toEqual({
      ok: false,
      reason: 'invalid_state',
      detail: 'state_replayed',
    });
    expect(fake.tokenRequests()).toHaveLength(1);
  });

  it('rejects an expired state', async () => {
    const { clock, fake, consent, run } = setup();
    const query = consent();
    clock.advance(11 * 60_000);
    expect(await run(query)).toEqual({
      ok: false,
      reason: 'invalid_state',
      detail: 'state_expired',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects a tampered state', async () => {
    const { fake, consent, run } = setup();
    const query = consent();
    // Flip a character inside the body (the MAC's last char only carries padding bits).
    const c = query.state[5] === 'A' ? 'B' : 'A';
    const out = await run({
      ...query,
      state: `${query.state.slice(0, 5)}${c}${query.state.slice(6)}`,
    });
    expect(out).toMatchObject({ ok: false, reason: 'invalid_state' });
    expect(fake.requests).toHaveLength(0);
  });

  it('maps a rejected code to exchange_failed', async () => {
    const { consent, run } = setup();
    const out = await run({ ...consent(), code: '1000.not.issued' });
    expect(out).toEqual({ ok: false, reason: 'exchange_failed', detail: 'exchange_rejected' });
  });

  it('maps throttling to exchange_failed with retryAfterS', async () => {
    const { fake, consent, run } = setup();
    fake.mode = 'throttle';
    expect(await run(consent())).toEqual({
      ok: false,
      reason: 'exchange_failed',
      detail: 'throttled',
      retryAfterS: 60,
    });
  });

  it('returns internal (does not throw) when state storage is down, and never contacts Zoho', async () => {
    const clock = new ManualClock();
    const kv = delegatingKv(new MemoryKv(clock), {
      set: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:6379')),
    });
    const fake = new FakeAccounts();
    const stateSigner = createStateSigner({ secret: STATE_SECRET, kv, clock });
    const oauth = createZohoOAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fake.fetch,
    });
    const query = {
      code: fake.issueCode(),
      state: stateSigner.sign({ dc: 'in', purpose: 'connect' }),
      location: 'in',
      'accounts-server': ZOHO_DATA_CENTERS.in.accountsServer,
    };
    await expect(
      completeConnect({ query, stateSigner, oauth, vault: createTokenVault(VAULT_KEY) }),
    ).resolves.toEqual({ ok: false, reason: 'internal', detail: 'internal' });
    expect(fake.requests).toHaveLength(0);
  });

  it('maps an unreachable Zoho to exchange_failed', async () => {
    const { fake, consent, run } = setup();
    fake.mode = 'network';
    expect(await run(consent())).toMatchObject({
      ok: false,
      reason: 'exchange_failed',
      detail: 'upstream_unavailable',
    });
  });
});
