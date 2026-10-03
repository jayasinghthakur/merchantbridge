import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { pino } from 'pino';
import { ZOHO_DATA_CENTERS, generateApiKey } from '@mb/auth';
import type { ZohoDcKey } from '@mb/auth';
import { API_ROUTES, DEMO_IDS } from '@mb/core';
import { ZOHO_SCOPES } from '@mb/zoho-inventory';
import type { AppContext } from '../context';
import type { AppLogger } from '../infra/logger';
import { pathOnly } from '../infra/logger';
import { assertFakeLiveAllowed, fakeLiveRequested, FAKE_LIVE_ENV } from './flag';
import type { FakeUpstream } from './fake-upstream';
import { FAKE_DC, createFakeUpstream } from './fake-upstream';

/**
 * Local "fake live" mode (MB_DEV_FAKE_ZOHO=true, development only): the authenticated `/mcp` leg, the OAuth connect
 * flow and disconnect all run for real against an in-process fake Zoho, with zero credentials.
 *
 * - Missing Zoho client, vault, state and invite variables are filled with ephemeral dev-only values.
 * - All outbound Zoho traffic goes to ./fake-upstream.ts; any other outbound host throws.
 * - A live tenant "Local dev merchant" with an active IN connection and an `mb_live_` key is seeded at startup.
 * - `/oauth/zoho/start` redirects to a local fake consent page instead of Zoho Accounts, which hands a one-time code
 *   to the real `/oauth/zoho/callback`.
 *
 * Refused in production (./flag.ts) and with DATABASE_URL / REDIS_URL set (fake tenants and keys never land in a
 * real store).
 */

export const FAKE_LIVE_TENANT_NAME = 'Local dev merchant';
export const FAKE_LIVE_DEFAULT_INVITE = 'local-dev';
export const FAKE_CONSENT_PATH = '/dev/fake-zoho/oauth/v2/auth';
export const FAKE_APPROVE_PATH = '/dev/fake-zoho/oauth/v2/approve';
const MAX_STATE_LENGTH = 2048;

export interface FakeLiveSetup {
  /** process.env plus the filled values; pass it to loadConfig. */
  env: NodeJS.ProcessEnv;
  /** Names (never values) of the variables filled with ephemeral dev-only values. */
  filled: string[];
  /** The invite code when it was defaulted (then it is not a secret and may be printed); null when set by the user. */
  defaultInvite: string | null;
  /** Origin the browser and curl use for this API (MB_PUBLIC_API_URL, else http://localhost:PORT). */
  apiBase: string;
  upstream: FakeUpstream;
}

export interface SeededTenant {
  tenantId: string;
  key: string;
  organizationId: string;
  organizationName: string;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/** Validates the mode and builds the environment and fake upstream. Throws on any refused combination. */
export function prepareFakeLive(source: NodeJS.ProcessEnv): FakeLiveSetup {
  if (!fakeLiveRequested(source)) throw new Error(`${FAKE_LIVE_ENV} is not set.`);
  assertFakeLiveAllowed(source);
  const external = (['DATABASE_URL', 'REDIS_URL'] as const).filter((k) => source[k]?.trim());
  if (external.length > 0) {
    throw new Error(
      `${FAKE_LIVE_ENV}=true runs on in-memory stores only; unset ${external.join(' and ')} (fake tenants and keys must never reach a real database).`,
    );
  }

  const env: NodeJS.ProcessEnv = { ...source };
  const apiBase = trimSlash(
    source.MB_PUBLIC_API_URL?.trim() || `http://localhost:${source.PORT?.trim() || '8787'}`,
  );
  const filled: string[] = [];
  const fill = (name: string, value: () => string): void => {
    if (env[name]?.trim()) return;
    env[name] = value();
    filled.push(name);
  };
  fill('MB_ENCRYPTION_KEY', () => randomBytes(32).toString('base64'));
  fill('MB_STATE_SECRET', () => randomBytes(48).toString('base64url'));
  fill('ZOHO_CLIENT_ID', () => `1000.LOCALDEVFAKE${randomBytes(6).toString('hex').toUpperCase()}`);
  fill('ZOHO_CLIENT_SECRET', () => randomBytes(24).toString('hex'));
  fill('ZOHO_REDIRECT_URI', () => `${apiBase}${API_ROUTES.oauthCallback}`);
  fill('MB_CONNECT_INVITE_CODE', () => FAKE_LIVE_DEFAULT_INVITE);

  const upstream = createFakeUpstream({
    clientId: env.ZOHO_CLIENT_ID!.trim(),
    clientSecret: env.ZOHO_CLIENT_SECRET!.trim(),
    redirectUri: env.ZOHO_REDIRECT_URI!.trim(),
  });
  return {
    env,
    filled,
    defaultInvite: filled.includes('MB_CONNECT_INVITE_CODE') ? FAKE_LIVE_DEFAULT_INVITE : null,
    apiBase,
    upstream,
  };
}

/** Creates the live tenant, its active IN connection (FakeZoho organization) and one API key. */
export async function seedFakeLiveTenant(
  ctx: AppContext,
  upstream: FakeUpstream,
): Promise<SeededTenant> {
  const auth = ctx.auth;
  if (!auth) throw new Error('fake-live: the Zoho client and vault are not configured.');
  const tenant = await ctx.stores.tenants.create({ name: FAKE_LIVE_TENANT_NAME, kind: 'live' });
  await ctx.stores.connections.upsert({
    tenantId: tenant.id,
    provider: 'zoho_inventory',
    dc: FAKE_DC.key,
    accountsServer: FAKE_DC.accountsServer,
    apiDomain: FAKE_DC.apiDomain,
    organizationId: upstream.organization.id,
    organizationName: upstream.organization.name,
    plan: null,
    scopes: [...ZOHO_SCOPES],
    refreshTokenEnc: auth.vault.encrypt(upstream.mintRefreshToken()),
  });
  const key = generateApiKey();
  await ctx.stores.apiKeys.create({ tenantId: tenant.id, prefix: key.prefix, hash: key.hash });
  return {
    tenantId: tenant.id,
    key: key.key,
    organizationId: upstream.organization.id,
    organizationName: upstream.organization.name,
  };
}

/** Maps a Zoho Accounts authorize URL to the local fake consent page (null for anything else). */
export function fakeConsentUrl(location: string, apiBase: string): string | null {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.pathname !== '/oauth/v2/auth') return null;
  const dc = Object.values(ZOHO_DATA_CENTERS).find((d) => d.accountsServer === url.origin);
  if (!dc) return null;
  const query = new URLSearchParams(url.search);
  query.set('dc', dc.key);
  return `${trimSlash(apiBase)}${FAKE_CONSENT_PATH}?${query.toString()}`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function page(reply: FastifyReply, status: number, title: string, body: string): FastifyReply {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#0F1A17;background:#F7F6F2}
.badge{display:inline-block;padding:.1rem .5rem;border:1px solid #E8912A;border-radius:6px;color:#8a4b00;font-weight:600;font-size:.8rem}
a.btn{display:inline-block;margin:.5rem .5rem 0 0;padding:.5rem 1rem;border-radius:6px;border:1px solid #0B6E58;text-decoration:none}
a.primary{background:#0B6E58;color:#fff}code{font-family:ui-monospace,monospace;font-size:.9em}</style></head>
<body><p class="badge">FAKE ZOHO ACCOUNTS (local dev only, ${FAKE_LIVE_ENV}=true)</p><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(html);
}

function singleString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STATE_LENGTH
    ? value
    : null;
}

/**
 * Makes the OAuth connect flow completable locally: rewrites the `/oauth/zoho/start` redirect from Zoho Accounts to a
 * fake consent page on this API, whose Accept button mints a one-time code and redirects to the real callback with
 * the parameters Zoho sends (`code`, `state`, `location`, `accounts-server`). Only the IN data center is faked.
 */
export function registerFakeConsent(
  app: FastifyInstance,
  opts: { ctx: AppContext; setup: FakeLiveSetup },
): void {
  const { ctx, setup } = opts;
  const auth = ctx.auth;
  if (!auth) throw new Error('fake-live: the Zoho client and vault are not configured.');
  const web = trimSlash(ctx.config.env.MB_PUBLIC_WEB_URL);

  app.addHook('onSend', async (request, reply, payload) => {
    if (pathOnly(request.url) !== API_ROUTES.oauthStart) return payload;
    const location = reply.getHeader('location');
    if (typeof location !== 'string') return payload;
    const target = fakeConsentUrl(location, setup.apiBase);
    if (target) reply.header('location', target);
    return payload;
  });

  app.get(FAKE_CONSENT_PATH, (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const state = singleString(q.state);
    if (q.client_id !== auth.clientId || q.redirect_uri !== auth.redirectUri || state === null) {
      return page(
        reply,
        400,
        'Invalid authorization request',
        '<p>Unknown client, redirect URI or missing state. Start again from the connect page.</p>',
      );
    }
    const dc = q.dc as ZohoDcKey | undefined;
    if (dc !== FAKE_DC.key) {
      return page(
        reply,
        200,
        'Only India is faked',
        `<p>Fake-live mode serves only the India (IN) data center. Go back and pick India.</p>
<p><a class="btn primary" href="${escapeHtml(`${web}/connect`)}">Back to connect</a></p>`,
      );
    }
    const scopes = typeof q.scope === 'string' ? q.scope.split(',') : [];
    const approve = `${FAKE_APPROVE_PATH}?${new URLSearchParams({ state }).toString()}`;
    const deny = `${auth.redirectUri}?${new URLSearchParams({ error: 'access_denied', state }).toString()}`;
    return page(
      reply,
      200,
      'MerchantBridge would like to access your Zoho Inventory',
      `<p>Organization: <strong>${escapeHtml(setup.upstream.organization.name)}</strong> (FakeZoho, demo data, dc in).</p>
<p>Requested scopes (read-only):</p><ul>${scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul>
<p><a class="btn primary" href="${escapeHtml(approve)}">Accept</a><a class="btn" href="${escapeHtml(deny)}">Deny</a></p>
<p>No Zoho account is involved: Accept mints a one-time code that the real callback exchanges with the in-process
fake accounts server.</p>`,
    );
  });

  app.get(FAKE_APPROVE_PATH, (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const state = singleString(q.state);
    if (state === null) {
      return page(reply, 400, 'Missing state', '<p>Start again from the connect page.</p>');
    }
    const params = new URLSearchParams({
      state,
      code: setup.upstream.issueAuthCode(),
      location: FAKE_DC.key,
      'accounts-server': FAKE_DC.accountsServer,
    });
    reply.header('cache-control', 'no-store');
    return reply.redirect(`${auth.redirectUri}?${params.toString()}`, 302);
  });
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The one startup message of fake-live mode: the seeded key and ready-to-paste commands. Printed to stdout on purpose
 * (not through the redacting JSON logger): the key belongs to a fake tenant in an in-memory store and dies with the
 * process. No other secret is ever printed; the invite code only when it is the default.
 */
export function fakeLiveBanner(input: {
  apiBase: string;
  webBase: string;
  seeded: SeededTenant;
  defaultInvite: string | null;
}): string {
  const api = trimSlash(input.apiBase);
  const auth = shellQuote(`Authorization: Bearer ${input.seeded.key}`);
  const mcp = (body: string): string =>
    `curl -sS ${api}${API_ROUTES.mcp} -H ${auth} -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d ${shellQuote(body)}`;
  const invite = input.defaultInvite === null ? 'your MB_CONNECT_INVITE_CODE' : input.defaultInvite;
  return [
    `[fake-live] ${FAKE_LIVE_ENV}=true (local dev only): tenant "${FAKE_LIVE_TENANT_NAME}" is connected to an in-process FakeZoho organization (${input.seeded.organizationName}, ${input.seeded.organizationId}, dc in). No real Zoho is called; the key, secrets and data reset on every restart.`,
    `  key:        ${input.seeded.key}`,
    `  tools/list: ${mcp('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')}`,
    `  tools/call: ${mcp(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zoho_get_item","arguments":{"sku":"${DEMO_IDS.sku}"}}}`)}`,
    `  disconnect: curl -sS -X POST ${api}${API_ROUTES.disconnect} -H ${auth}`,
    `  connect:    ${trimSlash(input.webBase)}/connect with invite code ${invite} and data center India (fake consent page; a new tenant and key)`,
    '',
  ].join('\n');
}

/**
 * Writes plain text through the logger's own destination, so it lands after the (asynchronously written) startup log
 * lines instead of in the middle of them; falls back to stdout.
 */
export function printAfterLogs(log: AppLogger, text: string): void {
  const dest = (log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym];
  if (dest && typeof (dest as { write?: unknown }).write === 'function') {
    (dest as { write(chunk: string): unknown }).write(text);
    return;
  }
  process.stdout.write(text);
}
