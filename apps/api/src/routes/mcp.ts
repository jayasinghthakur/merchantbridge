import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { hashApiKey, looksLikeApiKey } from '@mb/auth';
import { API_ROUTES } from '@mb/core';
import type { AppContext } from '../context';
import { demoSessionFrom } from '../demo';
import { clientIp, clientIpKey, copyReplyHeadersToRaw, sendRateLimited } from '../http-util';
import { createEgressMatcher, hitWindow, peekWindow } from '../infra/limits';
import type { McpEndpoint } from '../mcp';
import { demoAuthInfo, liveAuthInfo } from '../mcp';

export const BODY_LIMIT_BYTES = 64 * 1024;
const DEMO_PER_IP_PER_MIN = 60;
const DEMO_EGRESS_PER_MIN = 300;
const LIVE_PER_KEY_PER_MIN = 600;
/** Well-formed but unknown/revoked keys per IP per minute before /mcp answers 429 without a DB lookup. */
export const AUTH_FAILURES_PER_IP_PER_MIN = 30;
const TOUCH_INTERVAL_MS = 60_000;

async function serve(
  node: NodeMcpRequestHandler,
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthInfo,
): Promise<void> {
  Object.assign(request.raw, { auth });
  copyReplyHeadersToRaw(reply);
  reply.hijack();
  await node(request.raw, reply.raw, request.body);
}

/** The `mb_live_…` key from `Authorization: Bearer …`, or null when missing or malformed (no lookup needed). */
export function bearerApiKey(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const token = m?.[1];
  return looksLikeApiKey(token) ? token : null;
}

/** Resolves `Authorization: Bearer mb_live_…` to the key's tenant; null for missing, malformed or revoked keys. */
export async function authenticateApiKey(
  ctx: AppContext,
  header: string | undefined,
): Promise<{ tenantId: string; keyId: string } | null> {
  const token = bearerApiKey(header);
  if (token === null) return null;
  const record = await ctx.stores.apiKeys.findActiveByHash(hashApiKey(token));
  if (!record || record.revokedAt !== null) return null;
  return { tenantId: record.tenantId, keyId: record.id };
}

export function registerMcpRoutes(
  app: FastifyInstance,
  deps: { ctx: AppContext; demo: McpEndpoint; live: McpEndpoint },
): void {
  const { ctx } = deps;
  const onerror = (err: Error) => ctx.log.warn({ err_name: err.name }, 'mcp adapter error');
  const demoNode = toNodeHandler(deps.demo.handler, {
    maxRequestBodySize: BODY_LIMIT_BYTES,
    onerror,
  });
  const liveNode = toNodeHandler(deps.live.handler, {
    maxRequestBodySize: BODY_LIMIT_BYTES,
    onerror,
  });
  const isTrustedEgress = createEgressMatcher(ctx.config.env.MB_TRUSTED_EGRESS_CIDRS);

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: API_ROUTES.mcpDemo,
    handler: async (request, reply) => {
      const ipKey = clientIpKey(request);
      const trusted = isTrustedEgress(clientIp(request));
      const lim = trusted
        ? await hitWindow(ctx.kv, ctx.clock, 'mcpdemo:egress', DEMO_EGRESS_PER_MIN, 60_000)
        : await hitWindow(ctx.kv, ctx.clock, `mcpdemo:ip:${ipKey}`, DEMO_PER_IP_PER_MIN, 60_000);
      if (!lim.allowed) {
        return sendRateLimited(reply, lim.retryAfterS, 'Demo MCP rate limit reached; slow down.');
      }
      const session = demoSessionFrom((name) => request.headers[name], ipKey);
      await serve(demoNode, request, reply, demoAuthInfo(session));
    },
  });

  const unauthorized = (reply: FastifyReply): FastifyReply =>
    reply.code(401).header('www-authenticate', 'Bearer realm="merchantbridge"').send({
      error: 'A valid MerchantBridge API key is required (Authorization: Bearer mb_live_...).',
    });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: API_ROUTES.mcp,
    handler: async (request, reply) => {
      // Malformed headers are rejected without any I/O. Well-formed keys cost a DB lookup, so repeated misses from
      // one IP are capped before the lookup (keys are 190-bit random: this is about load, not guessing). Trusted
      // egress ranges are exempt: every tenant's Messages API / Claude.ai connector traffic shares those few IPs,
      // so one bad key there must not lock all of them out.
      if (bearerApiKey(request.headers.authorization) === null) return unauthorized(reply);
      const failKey = isTrustedEgress(clientIp(request))
        ? null
        : `mcp:authfail:${clientIpKey(request)}`;
      if (failKey !== null) {
        const failures = await peekWindow(
          ctx.kv,
          ctx.clock,
          failKey,
          AUTH_FAILURES_PER_IP_PER_MIN,
          60_000,
        );
        if (!failures.allowed) {
          return sendRateLimited(
            reply,
            failures.retryAfterS,
            'Too many invalid API keys; slow down.',
          );
        }
      }
      const auth = await authenticateApiKey(ctx, request.headers.authorization);
      if (!auth) {
        if (failKey !== null) {
          await hitWindow(ctx.kv, ctx.clock, failKey, AUTH_FAILURES_PER_IP_PER_MIN, 60_000);
        }
        return unauthorized(reply);
      }
      const lim = await hitWindow(
        ctx.kv,
        ctx.clock,
        `mcp:key:${auth.keyId}`,
        LIVE_PER_KEY_PER_MIN,
        60_000,
      );
      if (!lim.allowed)
        return sendRateLimited(reply, lim.retryAfterS, 'API key rate limit reached.');

      // At most one last_used_at write per key per minute, across instances.
      void ctx.kv
        .set(`apikey:touch:${auth.keyId}`, '1', { nx: true, ttlMs: TOUCH_INTERVAL_MS })
        .then((first) => (first ? ctx.stores.apiKeys.touch(auth.keyId) : undefined))
        .catch(() => ctx.log.warn({ key_id: auth.keyId }, 'api key touch failed'));

      await serve(liveNode, request, reply, liveAuthInfo(auth.tenantId, auth.keyId));
    },
  });
}
