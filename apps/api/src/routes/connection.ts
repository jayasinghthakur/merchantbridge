import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse } from '@mb/core';
import { API_ROUTES } from '@mb/core';
import type { AppContext } from '../context';
import { sendRateLimited } from '../http-util';
import { hitWindow } from '../infra/limits';
import { createApiKeyGuard } from './mcp';

const DISCONNECTS_PER_KEY_PER_MIN = 5;

export interface DisconnectResponse {
  revoked_locally: true;
  /** False when Zoho could not be reached or the stored token could not be decrypted; local state is still revoked. */
  revoked_at_zoho: boolean;
  /** Whether the tenant had an active Zoho connection to disconnect. */
  had_connection: boolean;
}

/**
 * POST /api/connection/disconnect (bearer mb_live_ key): the merchant-initiated off switch. Revokes the refresh token
 * at Zoho, drops the cached access token, marks the connection revoked and revokes the calling key, in that order.
 * Local revocation never depends on Zoho being reachable.
 */
export function registerConnectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireApiKey = createApiKeyGuard(ctx);

  app.post(API_ROUTES.disconnect, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const auth = await requireApiKey(request, reply);
    if (!auth) return reply;

    const lim = await hitWindow(
      ctx.kv,
      ctx.clock,
      `disconnect:${auth.keyId}`,
      DISCONNECTS_PER_KEY_PER_MIN,
      60_000,
    );
    if (!lim.allowed)
      return sendRateLimited(reply, lim.retryAfterS, 'Too many disconnect requests.');

    const conn = await ctx.stores.connections.getActiveForTenant(auth.tenantId);
    let revokedAtZoho = false;

    if (conn) {
      if (ctx.auth) {
        try {
          const refreshToken = ctx.auth.vault.decrypt(conn.refreshTokenEnc);
          const outcome = await ctx.auth.oauth.revoke({
            token: refreshToken,
            accountsServer: conn.accountsServer,
          });
          // `invalid_token` means Zoho no longer knows the token (already revoked): the goal is met either way.
          revokedAtZoho = outcome === 'revoked' || outcome === 'invalid_token';
        } catch (err) {
          request.log.warn(
            { tenant_id: auth.tenantId, connection_id: conn.id, err_type: (err as Error).name },
            'zoho revoke failed; revoking locally only',
          );
        }
        await ctx.auth.tokens.invalidate(conn);
      }
      await ctx.stores.connections.markRevoked(auth.tenantId, conn.id);
    }
    await ctx.stores.apiKeys.revoke(auth.tenantId, auth.keyId);

    request.log.info(
      { tenant_id: auth.tenantId, had_connection: conn !== null, revoked_at_zoho: revokedAtZoho },
      'tenant disconnected',
    );
    return reply.send({
      revoked_locally: true,
      revoked_at_zoho: revokedAtZoho,
      had_connection: conn !== null,
    } satisfies DisconnectResponse);
  });

  // Only POST is meaningful; answer other methods explicitly rather than with the generic 404.
  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE'],
    url: API_ROUTES.disconnect,
    handler: (_request, reply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send({
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' },
        } satisfies ApiErrorResponse),
  });
}
