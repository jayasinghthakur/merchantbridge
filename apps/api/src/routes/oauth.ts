import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  buildAuthorizeUrl,
  completeConnect,
  generateApiKey,
  getDataCenter,
  isSupportedDc,
  parseCallback,
  verifyInviteCode,
} from '@mb/auth';
import type { ConnectErrorReason, ZohoPlan } from '@mb/core';
import { API_ROUTES, ZOHO_DAILY_LIMITS, isConnectorError, zohoRateProfile } from '@mb/core';
import { ZOHO_SCOPES, createZohoApi } from '@mb/zoho-inventory';
import type { AppContext } from '../context';
import { clientIpKey, sendRateLimited } from '../http-util';
import { hitWindow } from '../infra/limits';

export const OAUTH_COOKIE = 'mb_oauth';
const COOKIE_PATH = '/oauth/zoho';
const COOKIE_MAX_AGE_S = 600;
/** Connect attempts per IP per 10 minutes: caps invite-code guessing (the code is a shared, human-chosen secret). */
export const OAUTH_START_PER_IP = 10;
const OAUTH_START_WINDOW_MS = 10 * 60_000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * GET /organizations (organizations.yml #list_organizations). Only the fields we use; plan mapping from
 * `plan_name` is UNVERIFIED (docs/notes/zoho.md P-7), so unknown names map to null (governor treats it as free).
 */
const organizationsSchema = z.object({
  organizations: z
    .array(
      z.object({
        organization_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
        name: z.string().nullish(),
        is_default_org: z.boolean().nullish(),
        plan_name: z.string().nullish(),
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
});

function planFrom(planName: string | null | undefined): ZohoPlan | null {
  const key = planName?.trim().toLowerCase();
  return key && Object.hasOwn(ZOHO_DAILY_LIMITS, key) ? (key as ZohoPlan) : null;
}

export function registerOAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const config = ctx.config;
  const web = config.env.MB_PUBLIC_WEB_URL.replace(/\/+$/, '');

  const cookieAttrs = (maxAge: number): string =>
    [
      `Path=${COOKIE_PATH}`,
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
      ...(config.isProd ? ['Secure'] : []),
    ].join('; ');
  const clearCookie = (reply: FastifyReply): void => {
    reply.header('set-cookie', `${OAUTH_COOKIE}=; ${cookieAttrs(0)}`);
  };
  const fail = (reply: FastifyReply, reason: ConnectErrorReason): FastifyReply => {
    clearCookie(reply);
    return reply.redirect(`${web}/connect/error?reason=${encodeURIComponent(reason)}`, 302);
  };

  app.get(API_ROUTES.oauthStart, async (request: FastifyRequest, reply: FastifyReply) => {
    const lim = await hitWindow(
      ctx.kv,
      ctx.clock,
      `oauth:start:ip:${clientIpKey(request)}`,
      OAUTH_START_PER_IP,
      OAUTH_START_WINDOW_MS,
    );
    if (!lim.allowed) {
      request.log.warn({ oauth: 'start', reason: 'rate_limited' }, 'zoho connect throttled');
      return sendRateLimited(reply, lim.retryAfterS, 'Too many connect attempts; try again later.');
    }
    const q = (request.query ?? {}) as Record<string, unknown>;
    const invite = typeof q.invite === 'string' ? q.invite : undefined;
    const signer = ctx.auth?.stateSigner ?? null;
    if (
      !config.connectEnabled ||
      !ctx.auth ||
      !signer ||
      !verifyInviteCode(invite, config.env.MB_CONNECT_INVITE_CODE)
    ) {
      return fail(reply, 'invalid_invite');
    }
    const dc = q.dc;
    if (!isSupportedDc(dc)) return fail(reply, 'unsupported_dc');

    const state = signer.sign({ dc, purpose: 'connect' });
    const url = buildAuthorizeUrl({
      dc,
      clientId: ctx.auth.clientId,
      redirectUri: ctx.auth.redirectUri,
      scopes: ZOHO_SCOPES,
      state,
    });
    // Binds the flow to this browser: the callback only accepts a state whose hash matches this cookie.
    reply.header(
      'set-cookie',
      `${OAUTH_COOKIE}=${sha256Hex(state)}; ${cookieAttrs(COOKIE_MAX_AGE_S)}`,
    );
    request.log.info({ oauth: 'start', dc }, 'zoho connect started');
    return reply.redirect(url, 302);
  });

  app.get(API_ROUTES.oauthCallback, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const auth = ctx.auth;
    const signer = auth?.stateSigner ?? null;
    if (!config.connectEnabled || !auth || !signer) return fail(reply, 'invalid_invite');

    // Zoho's deny redirect (`?error=access_denied`) is reported as such, whatever the cookie says.
    if (Object.hasOwn(query, 'error')) {
      const parsed = parseCallback(query);
      return fail(reply, parsed.ok ? 'exchange_failed' : parsed.reason);
    }

    const state = typeof query.state === 'string' ? query.state : '';
    const cookie = readCookie(request.headers.cookie, OAUTH_COOKIE);
    if (state === '' || cookie === null || !sameHex(cookie, sha256Hex(state))) {
      request.log.warn(
        { oauth: 'callback', reason: 'invalid_state', detail: 'cookie_mismatch' },
        'zoho connect failed',
      );
      return fail(reply, 'invalid_state');
    }

    try {
      const result = await completeConnect({
        query,
        stateSigner: signer,
        oauth: auth.oauth,
        vault: auth.vault,
        log: ctx.coreLog,
      });
      if (!result.ok) return fail(reply, result.reason);

      // ALL Zoho reads go through ZohoClient + governor, including this one-off organizations lookup.
      const dc = getDataCenter(result.dc);
      const api = createZohoApi({
        fetch: ctx.fetch,
        apiDomain: result.apiDomain,
        organizationId: 'pending',
        tokens: {
          get: () => Promise.resolve(result.accessToken),
          refreshAfterUnauthorized: () => Promise.reject(new Error('fresh token rejected')),
        },
        governor: ctx.governor,
        scope: { key: `zoho:connect:${randomUUID()}`, profile: zohoRateProfile('free') },
        cacheKeyPrefix: 'connect:',
        note: () => undefined,
        webBaseUrl: dc.inventoryWebHost,
        connection: {
          mode: 'live',
          dc: result.dc,
          scopes: [...ZOHO_SCOPES],
          organizationName: null,
          plan: null,
        },
        log: ctx.coreLog,
      });
      const res = await api.get('organizations');
      const parsedOrgs = organizationsSchema.safeParse(res.body);
      if (!parsedOrgs.success) return fail(reply, 'exchange_failed');
      const orgs = parsedOrgs.data.organizations;
      const org = orgs.find((o) => o.is_default_org === true) ?? orgs[0];
      if (!org) return fail(reply, 'no_organization');
      const orgName = org.name ?? null;

      const tenant = await ctx.stores.tenants.create({
        name: orgName ?? `Zoho org ${org.organization_id}`,
        kind: 'live',
      });
      const conn = await ctx.stores.connections.upsert({
        tenantId: tenant.id,
        provider: 'zoho_inventory',
        dc: result.dc,
        accountsServer: result.accountsServer,
        apiDomain: result.apiDomain,
        organizationId: org.organization_id,
        organizationName: orgName,
        plan: planFrom(org.plan_name),
        scopes: [...ZOHO_SCOPES],
        refreshTokenEnc: result.refreshTokenEnc,
      });
      await auth.tokens.primeAccessToken(conn, result.accessToken, result.expiresInS);
      const key = generateApiKey();
      await ctx.stores.apiKeys.create({ tenantId: tenant.id, prefix: key.prefix, hash: key.hash });

      request.log.info(
        {
          oauth: 'callback',
          tenant_id: tenant.id,
          organization_id: org.organization_id,
          dc: result.dc,
        },
        'zoho connected',
      );
      clearCookie(reply);
      const fragment = `key=${key.key}&org=${encodeURIComponent(orgName ?? org.organization_id)}&dc=${encodeURIComponent(result.dc)}`;
      return reply.redirect(`${web}/connect/success#${fragment}`, 302);
    } catch (e) {
      request.log.error(
        {
          oauth: 'callback',
          err_name: e instanceof Error ? e.name : typeof e,
          error_code: isConnectorError(e) ? e.code : undefined,
        },
        'zoho connect failed',
      );
      if (isConnectorError(e)) {
        return fail(
          reply,
          e.code === 'RECONNECT_REQUIRED' || e.code === 'SCOPE_NOT_GRANTED'
            ? 'exchange_failed'
            : 'internal',
        );
      }
      return fail(reply, 'internal');
    }
  });
}
