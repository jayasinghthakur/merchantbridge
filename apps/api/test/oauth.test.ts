import { afterEach, describe, expect, it } from 'vitest';
import { ZOHO_DATA_CENTERS } from '@mb/auth';
import { DEMO_IDS } from '@mb/core';
import { ZOHO_SCOPES } from '@mb/zoho-inventory';
import { buildApp } from '../src/app';
import { OAUTH_COOKIE, sha256Hex } from '../src/routes/oauth';
import { GOOD_CODE, createLiveUpstream } from './fakes';
import { LIVE_ENV, TEST_INVITE, routeClient, structured, testContext } from './helpers';

const WEB = 'http://localhost:3000';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(env: Record<string, string> = LIVE_ENV) {
  const upstream = createLiveUpstream();
  const { ctx, logs } = await testContext({ env, fetch: upstream.fetch });
  const app = await buildApp(ctx);
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { ctx, app, upstream, logs };
}

async function start(
  app: Awaited<ReturnType<typeof setup>>['app'],
  dc = 'in',
  invite = TEST_INVITE,
) {
  const res = await app.inject({
    method: 'GET',
    url: `/oauth/zoho/start?dc=${encodeURIComponent(dc)}&invite=${encodeURIComponent(invite)}`,
  });
  return res;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (raw ?? '').split(';')[0] ?? '';
}

function callbackUrl(params: Record<string, string>): string {
  return `/oauth/zoho/callback?${new URLSearchParams(params).toString()}`;
}

describe('OAuth start', () => {
  it('a wrong invite redirects to invalid_invite', async () => {
    const { app } = await setup();
    const res = await start(app, 'in', 'nope');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/connect/error?reason=invalid_invite`);
  });

  it('redirects to connect_disabled when connect is not configured', async () => {
    const { app } = await setup({});
    const res = await start(app);
    expect(res.headers.location).toBe(`${WEB}/connect/error?reason=connect_disabled`);
  });

  it('an unsupported dc redirects to unsupported_dc', async () => {
    const { app } = await setup();
    for (const dc of ['uk', 'cn', 'mars']) {
      const res = await start(app, dc);
      expect(res.headers.location).toBe(`${WEB}/connect/error?reason=unsupported_dc`);
    }
  });

  it('a good invite → 302 to the IN accounts host with state, all scopes and a bound cookie', async () => {
    const { app } = await setup();
    const res = await start(app);
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers.location));
    expect(loc.origin).toBe(ZOHO_DATA_CENTERS.in.accountsServer);
    expect(loc.pathname).toBe('/oauth/v2/auth');
    expect(loc.searchParams.get('scope')).toBe(ZOHO_SCOPES.join(','));
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('prompt')).toBe('consent');
    const state = loc.searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(20);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain(`${OAUTH_COOKIE}=${sha256Hex(state)}`);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/oauth\/zoho/);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('OAuth callback', () => {
  it('success: creates tenant + connection + key, redirects with #key=mb_live_…, and the key works on /mcp', async () => {
    const { app, upstream, logs } = await setup();
    const s = await start(app);
    const state = new URL(String(s.headers.location)).searchParams.get('state') ?? '';
    const res = await app.inject({
      method: 'GET',
      url: callbackUrl({
        code: GOOD_CODE,
        state,
        location: 'in',
        'accounts-server': ZOHO_DATA_CENTERS.in.accountsServer,
      }),
      headers: { cookie: cookieOf(s.headers['set-cookie']) },
    });
    expect(res.statusCode).toBe(302);
    const loc = String(res.headers.location);
    expect(loc.startsWith(`${WEB}/connect/success#`)).toBe(true);
    const frag = new URLSearchParams(loc.split('#')[1]);
    const key = frag.get('key') ?? '';
    expect(key).toMatch(/^mb_live_[0-9A-Za-z]{32}$/);
    expect(frag.get('org')).toBe(DEMO_IDS.orgName);
    expect(frag.get('dc')).toBe('in');
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect(upstream.tokenCalls('authorization_code')).toBe(1);

    // The connect flow primed the access token: the first tool call needs no refresh.
    const client = await routeClient(app, '/mcp', { headers: { authorization: `Bearer ${key}` } });
    cleanup.push(() => client.close());
    const item = await client.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
    expect(item.isError).not.toBe(true);
    expect(structured(item).data.sku).toBe(DEMO_IDS.sku);
    expect(upstream.tokenCalls('refresh_token')).toBe(0);

    const all = logs.text();
    expect(all).not.toContain(GOOD_CODE);
    expect(all).not.toContain(key);
    expect(all).not.toContain(state);
  });

  it('a tampered state or a missing cookie → invalid_state', async () => {
    const { app, upstream } = await setup();
    const s = await start(app);
    const state = new URL(String(s.headers.location)).searchParams.get('state') ?? '';
    const base = {
      code: GOOD_CODE,
      location: 'in',
      'accounts-server': ZOHO_DATA_CENTERS.in.accountsServer,
    };

    const noCookie = await app.inject({ method: 'GET', url: callbackUrl({ ...base, state }) });
    expect(noCookie.headers.location).toBe(`${WEB}/connect/error?reason=invalid_state`);

    const tampered = `${state.slice(0, -2)}${state.endsWith('AA') ? 'BB' : 'AA'}`;
    const res = await app.inject({
      method: 'GET',
      url: callbackUrl({ ...base, state: tampered }),
      headers: { cookie: cookieOf(s.headers['set-cookie']) },
    });
    expect(res.headers.location).toBe(`${WEB}/connect/error?reason=invalid_state`);

    // Cookie matches a tampered state, but the HMAC does not.
    const res2 = await app.inject({
      method: 'GET',
      url: callbackUrl({ ...base, state: tampered }),
      headers: { cookie: `${OAUTH_COOKIE}=${sha256Hex(tampered)}` },
    });
    expect(res2.headers.location).toBe(`${WEB}/connect/error?reason=invalid_state`);
    expect(upstream.calls).toHaveLength(0);
  });

  it('error=access_denied → access_denied', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: callbackUrl({ error: 'access_denied' }) });
    expect(res.headers.location).toBe(`${WEB}/connect/error?reason=access_denied`);
  });

  it('an unknown accounts-server → invalid_state and no outbound fetch', async () => {
    const { app, upstream } = await setup();
    const s = await start(app);
    const state = new URL(String(s.headers.location)).searchParams.get('state') ?? '';
    const res = await app.inject({
      method: 'GET',
      url: callbackUrl({
        code: GOOD_CODE,
        state,
        location: 'in',
        'accounts-server': 'https://accounts.zoho.in.evil.test',
      }),
      headers: { cookie: cookieOf(s.headers['set-cookie']) },
    });
    expect(res.headers.location).toBe(`${WEB}/connect/error?reason=invalid_state`);
    expect(upstream.calls).toHaveLength(0);
  });

  it('a rejected code → exchange_failed; a replayed state → invalid_state', async () => {
    const { app } = await setup();
    const s = await start(app);
    const state = new URL(String(s.headers.location)).searchParams.get('state') ?? '';
    const cookie = cookieOf(s.headers['set-cookie']);
    const params = {
      code: 'wrong-code',
      state,
      location: 'in',
      'accounts-server': ZOHO_DATA_CENTERS.in.accountsServer,
    };
    const first = await app.inject({
      method: 'GET',
      url: callbackUrl(params),
      headers: { cookie },
    });
    expect(first.headers.location).toBe(`${WEB}/connect/error?reason=exchange_failed`);
    const replay = await app.inject({
      method: 'GET',
      url: callbackUrl(params),
      headers: { cookie },
    });
    expect(replay.headers.location).toBe(`${WEB}/connect/error?reason=invalid_state`);
  });
});
