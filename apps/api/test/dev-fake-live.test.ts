import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ZOHO_DATA_CENTERS } from '@mb/auth';
import { API_ROUTES, DEMO_IDS, MemoryKv, systemClock } from '@mb/core';
import { createMemoryStores } from '@mb/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createAppContext } from '../src/context';
import {
  FAKE_APPROVE_PATH,
  FAKE_CONSENT_PATH,
  FAKE_LIVE_TENANT_NAME,
  fakeConsentUrl,
  fakeLiveBanner,
  prepareFakeLive,
  registerFakeConsent,
  seedFakeLiveTenant,
} from '../src/dev/fake-live';
import { FakeUpstreamBlockedError, createFakeUpstream } from '../src/dev/fake-upstream';
import { assertFakeLiveAllowed, fakeLiveRequested } from '../src/dev/flag';
import { captureLogger, routeClient, structured } from './helpers';

const IN = ZOHO_DATA_CENTERS.in;
const CLIENT = {
  clientId: '1000.DEVTEST',
  clientSecret: 'dev-secret',
  redirectUri: 'http://localhost:8787/oauth/zoho/callback',
};

function form(params: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  };
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

describe('fake upstream (MB_DEV_FAKE_ZOHO)', () => {
  it('exchanges a one-time code, refreshes, serves the IN API and revokes', async () => {
    const up = createFakeUpstream(CLIENT);
    const tokenUrl = `${IN.accountsServer}/oauth/v2/token`;

    const code = up.issueAuthCode();
    const exchanged = await up.fetch(
      tokenUrl,
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLIENT.redirectUri,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    );
    const body = (await exchanged.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      api_domain: IN.apiDomain,
      token_type: 'Bearer',
      expires_in: 3600,
    });
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');

    // Codes are single use.
    const replay = await up.fetch(
      tokenUrl,
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLIENT.redirectUri,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    );
    expect(await replay.json()).toEqual({ error: 'invalid_code' });

    // Refresh with the issued refresh token.
    const refreshed = await up.fetch(
      tokenUrl,
      form({
        grant_type: 'refresh_token',
        refresh_token: String(body.refresh_token),
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    );
    const access = ((await refreshed.json()) as { access_token: string }).access_token;
    expect(access).not.toBe(body.access_token);

    // The IN API domain is a wire-compatible FakeZoho that accepts the issued token.
    const orgs = await up.fetch(`${IN.apiDomain}/inventory/v1/organizations`, {
      headers: { authorization: `Zoho-oauthtoken ${access}` },
    });
    expect(orgs.status).toBe(200);
    expect(await orgs.json()).toMatchObject({
      code: 0,
      organizations: [{ organization_id: up.organization.id }],
    });

    // Revoke kills the refresh token; a second revoke is invalid_token (HTTP 400, as Zoho answers).
    const revokeUrl = `${IN.accountsServer}/oauth/v2/revoke/token`;
    expect((await up.fetch(revokeUrl, form({ token: String(body.refresh_token) }))).status).toBe(
      200,
    );
    expect((await up.fetch(revokeUrl, form({ token: String(body.refresh_token) }))).status).toBe(
      400,
    );
    const dead = await up.fetch(
      tokenUrl,
      form({
        grant_type: 'refresh_token',
        refresh_token: String(body.refresh_token),
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    );
    expect(await dead.json()).toEqual({ error: 'invalid_code' });

    expect(up.calls.map((c) => `${c.path} ${c.status}`)).toEqual([
      '/oauth/v2/token 200',
      '/oauth/v2/token 200',
      '/oauth/v2/token 200',
      '/inventory/v1/organizations 200',
      '/oauth/v2/revoke/token 200',
      '/oauth/v2/revoke/token 400',
      '/oauth/v2/token 200',
    ]);
    expect(JSON.stringify(up.calls)).not.toContain(code);
  });

  it('rejects other clients, expired codes and a wrong redirect URI', async () => {
    let now = 1_000_000;
    const up = createFakeUpstream({ ...CLIENT, now: () => now });
    const tokenUrl = `${IN.accountsServer}/oauth/v2/token`;
    const grant = (code: string, extra: Record<string, string> = {}) =>
      up.fetch(
        tokenUrl,
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: CLIENT.redirectUri,
          client_id: CLIENT.clientId,
          client_secret: CLIENT.clientSecret,
          ...extra,
        }),
      );

    expect(await (await grant(up.issueAuthCode(), { client_id: '1000.OTHER' })).json()).toEqual({
      error: 'invalid_client',
    });
    expect(await (await grant(up.issueAuthCode(), { client_secret: 'nope' })).json()).toEqual({
      error: 'invalid_client',
    });
    expect(
      await (await grant(up.issueAuthCode(), { redirect_uri: 'https://evil.test/cb' })).json(),
    ).toEqual({ error: 'invalid_redirect_uri' });
    const late = up.issueAuthCode();
    now += 61_000;
    expect(await (await grant(late)).json()).toEqual({ error: 'invalid_code' });
    expect(await (await grant('1000.never-issued')).json()).toEqual({ error: 'invalid_code' });
  });

  it('throws for every host other than the IN accounts server and API domain', async () => {
    const up = createFakeUpstream(CLIENT);
    for (const url of [
      'https://example.com/',
      `${ZOHO_DATA_CENTERS.us.accountsServer}/oauth/v2/token`,
      `${ZOHO_DATA_CENTERS.us.apiDomain}/inventory/v1/items`,
      `${ZOHO_DATA_CENTERS.eu.apiDomain}/inventory/v1/items`,
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      // Same host over plain http is not the fake either.
      `${IN.apiDomain.replace('https:', 'http:')}/inventory/v1/items`,
    ]) {
      await expect(up.fetch(url)).rejects.toBeInstanceOf(FakeUpstreamBlockedError);
    }
    expect(up.calls).toEqual([]);
  });
});

describe('fake-live flag and environment', () => {
  it('parses the flag strictly', () => {
    expect(fakeLiveRequested({})).toBe(false);
    expect(fakeLiveRequested({ MB_DEV_FAKE_ZOHO: 'false' })).toBe(false);
    expect(fakeLiveRequested({ MB_DEV_FAKE_ZOHO: '0' })).toBe(false);
    expect(fakeLiveRequested({ MB_DEV_FAKE_ZOHO: 'true' })).toBe(true);
    expect(fakeLiveRequested({ MB_DEV_FAKE_ZOHO: '1' })).toBe(true);
    expect(() => fakeLiveRequested({ MB_DEV_FAKE_ZOHO: 'yes' })).toThrow(/must be true or false/);
  });

  it('is refused in production', () => {
    expect(() =>
      assertFakeLiveAllowed({ NODE_ENV: 'production', MB_DEV_FAKE_ZOHO: 'true' }),
    ).toThrow(
      /MB_DEV_FAKE_ZOHO=true is a local development mode and is refused when NODE_ENV=production/,
    );
    expect(() => assertFakeLiveAllowed({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertFakeLiveAllowed({ NODE_ENV: 'development', MB_DEV_FAKE_ZOHO: 'true' }),
    ).not.toThrow();
    expect(() => prepareFakeLive({ NODE_ENV: 'production', MB_DEV_FAKE_ZOHO: 'true' })).toThrow(
      /refused/,
    );
  });

  it('refuses a real database or Redis', () => {
    expect(() =>
      prepareFakeLive({ MB_DEV_FAKE_ZOHO: 'true', DATABASE_URL: 'postgres://x' }),
    ).toThrow(/in-memory stores only/);
    expect(() => prepareFakeLive({ MB_DEV_FAKE_ZOHO: 'true', REDIS_URL: 'redis://x' })).toThrow(
      /REDIS_URL/,
    );
  });

  it('fills only missing values, enabling connect, and reports names only', () => {
    const setup = prepareFakeLive({
      MB_DEV_FAKE_ZOHO: 'true',
      NODE_ENV: 'test',
      PORT: '9100',
      MB_STATE_SECRET: 'mine-state-secret-0123456789-abcdefghijkl',
    });
    expect(setup.filled).toEqual([
      'MB_ENCRYPTION_KEY',
      'ZOHO_CLIENT_ID',
      'ZOHO_CLIENT_SECRET',
      'ZOHO_REDIRECT_URI',
      'MB_CONNECT_INVITE_CODE',
    ]);
    expect(setup.env.MB_STATE_SECRET).toBe('mine-state-secret-0123456789-abcdefghijkl');
    expect(setup.env.ZOHO_REDIRECT_URI).toBe('http://localhost:9100/oauth/zoho/callback');
    expect(setup.env.MB_CONNECT_INVITE_CODE).toBe('local-dev');
    expect(setup.defaultInvite).toBe('local-dev');
    expect(Buffer.from(setup.env.MB_ENCRYPTION_KEY!, 'base64')).toHaveLength(32);
    expect(loadConfig(setup.env).connectEnabled).toBe(true);

    const own = prepareFakeLive({
      MB_DEV_FAKE_ZOHO: 'true',
      MB_CONNECT_INVITE_CODE: 'secret-invite',
    });
    expect(own.defaultInvite).toBeNull();
    expect(own.filled).not.toContain('MB_CONNECT_INVITE_CODE');
  });

  it('maps only Zoho Accounts authorize URLs to the fake consent page', () => {
    const base = 'http://localhost:8787';
    expect(fakeConsentUrl(`${IN.accountsServer}/oauth/v2/auth?client_id=a&state=s`, base)).toBe(
      `${base}${FAKE_CONSENT_PATH}?client_id=a&state=s&dc=in`,
    );
    expect(
      fakeConsentUrl(`${ZOHO_DATA_CENTERS.us.accountsServer}/oauth/v2/auth?state=s`, base),
    ).toContain('dc=us');
    expect(
      fakeConsentUrl('http://localhost:3000/connect/error?reason=invalid_invite', base),
    ).toBeNull();
    expect(fakeConsentUrl('https://accounts.zoho.in.evil.test/oauth/v2/auth', base)).toBeNull();
    expect(fakeConsentUrl(`${IN.accountsServer}/oauth/v2/token`, base)).toBeNull();
  });

  it('prints the key and paste-ready commands, and no other secret', () => {
    const setup = prepareFakeLive({ MB_DEV_FAKE_ZOHO: 'true' });
    const banner = fakeLiveBanner({
      apiBase: 'http://localhost:8787',
      webBase: 'http://localhost:3000',
      seeded: {
        tenantId: 't',
        key: 'mb_live_TESTKEY',
        organizationId: '1',
        organizationName: 'Org',
      },
      defaultInvite: setup.defaultInvite,
    });
    expect(banner).toContain(
      "curl -sS http://localhost:8787/mcp -H 'Authorization: Bearer mb_live_TESTKEY'",
    );
    expect(banner).toContain('"method":"tools/list"');
    expect(banner).toContain(`"sku":"${DEMO_IDS.sku}"`);
    expect(banner).toContain(
      `curl -sS -X POST http://localhost:8787${API_ROUTES.disconnect} -H 'Authorization: Bearer mb_live_TESTKEY'`,
    );
    expect(banner).toContain('invite code local-dev');
    for (const name of [
      'MB_ENCRYPTION_KEY',
      'MB_STATE_SECRET',
      'ZOHO_CLIENT_SECRET',
      'ZOHO_CLIENT_ID',
    ]) {
      expect(banner).not.toContain(setup.env[name]!);
    }
  });
});

async function fakeLiveApp() {
  const setup = prepareFakeLive({
    MB_DEV_FAKE_ZOHO: 'true',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  const { log, logs } = captureLogger('debug');
  const ctx = await createAppContext(loadConfig(setup.env), {
    fetch: setup.upstream.fetch,
    kv: new MemoryKv(systemClock),
    stores: createMemoryStores({ clock: systemClock }),
    log,
    governorRandom: () => 0,
    usageFlushMs: 60_000,
  });
  const app = await buildApp(ctx);
  registerFakeConsent(app, { ctx, setup });
  cleanup.push(
    () => ctx.close(),
    () => app.close(),
  );
  return { setup, ctx, app, logs };
}

function mcpList(app: FastifyInstance, key: string) {
  return app.inject({
    method: 'POST',
    url: API_ROUTES.mcp,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('fake-live mode end to end (no network)', () => {
  it('seeds a live tenant whose key works on /mcp until disconnect, then 401', async () => {
    const { setup, ctx, app, logs } = await fakeLiveApp();
    const seeded = await seedFakeLiveTenant(ctx, setup.upstream);
    expect((await ctx.stores.tenants.get(seeded.tenantId))?.name).toBe(FAKE_LIVE_TENANT_NAME);

    expect((await mcpList(app, seeded.key)).statusCode).toBe(200);
    const client = await routeClient(app, API_ROUTES.mcp, {
      headers: { authorization: `Bearer ${seeded.key}` },
    });
    cleanup.push(() => client.close());
    const res = await client.callTool({ name: 'zoho_get_item', arguments: { sku: DEMO_IDS.sku } });
    expect(res.isError).not.toBe(true);
    expect(structured(res).meta).toMatchObject({
      demo: false,
      organization_id: seeded.organizationId,
    });
    expect(structured(res).data).toMatchObject({ sku: DEMO_IDS.sku });

    const off = await app.inject({
      method: 'POST',
      url: API_ROUTES.disconnect,
      headers: { authorization: `Bearer ${seeded.key}` },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({
      revoked_locally: true,
      revoked_at_zoho: true,
      had_connection: true,
    });
    expect(
      setup.upstream.calls.some((c) => c.path === '/oauth/v2/revoke/token' && c.status === 200),
    ).toBe(true);
    expect((await mcpList(app, seeded.key)).statusCode).toBe(401);
    expect(logs.text()).not.toContain(seeded.key);
  });

  it('completes the OAuth connect flow through the fake consent page', async () => {
    const { setup, ctx, app } = await fakeLiveApp();
    const start = await app.inject({
      method: 'GET',
      url: `${API_ROUTES.oauthStart}?dc=in&invite=local-dev`,
    });
    expect(start.statusCode).toBe(302);
    const consent = new URL(String(start.headers.location));
    expect(`${consent.origin}${consent.pathname}`).toBe(`${setup.apiBase}${FAKE_CONSENT_PATH}`);
    expect(consent.searchParams.get('dc')).toBe('in');
    const cookie = String(start.headers['set-cookie']).split(';')[0]!;

    const pageRes = await app.inject({
      method: 'GET',
      url: `${consent.pathname}${consent.search}`,
    });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.body).toContain('FAKE ZOHO ACCOUNTS');
    expect(pageRes.body).toContain('ZohoInventory.items.READ');

    const approve = await app.inject({
      method: 'GET',
      url: `${FAKE_APPROVE_PATH}?state=${encodeURIComponent(consent.searchParams.get('state')!)}`,
    });
    expect(approve.statusCode).toBe(302);
    const callback = new URL(String(approve.headers.location));
    expect(`${callback.origin}${callback.pathname}`).toBe(ctx.auth!.redirectUri);
    expect(callback.searchParams.get('accounts-server')).toBe(IN.accountsServer);
    expect(callback.searchParams.get('location')).toBe('in');

    const done = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie },
    });
    expect(done.statusCode).toBe(302);
    const success = new URL(String(done.headers.location));
    expect(success.pathname).toBe('/connect/success');
    const key = new URLSearchParams(success.hash.slice(1)).get('key')!;
    expect(key).toMatch(/^mb_live_/);
    expect((await mcpList(app, key)).statusCode).toBe(200);
  });

  it('refuses consent requests for another client or redirect, and fakes only India', async () => {
    const { app, ctx } = await fakeLiveApp();
    const q = (p: Record<string, string>) =>
      `${FAKE_CONSENT_PATH}?${new URLSearchParams(p).toString()}`;
    const good = {
      client_id: ctx.auth!.clientId,
      redirect_uri: ctx.auth!.redirectUri,
      state: 's',
      dc: 'in',
    };
    expect(
      (await app.inject({ method: 'GET', url: q({ ...good, client_id: 'x' }) })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: q({ ...good, redirect_uri: 'https://evil.test/cb' }),
        })
      ).statusCode,
    ).toBe(400);
    const us = await app.inject({ method: 'GET', url: q({ ...good, dc: 'us' }) });
    expect(us.body).toContain('Only India is faked');
    expect(us.body).not.toContain(FAKE_APPROVE_PATH);
    expect((await app.inject({ method: 'GET', url: FAKE_APPROVE_PATH })).statusCode).toBe(400);
  });
});

describe('server.ts', () => {
  it('exits non-zero when MB_DEV_FAKE_ZOHO=true and NODE_ENV=production', () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        MB_DEV_FAKE_ZOHO: 'true',
        PORT: '0',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('MB_DEV_FAKE_ZOHO=true is a local development mode');
    expect(run.stdout).not.toContain('mb_live_');
  }, 70_000);
});
