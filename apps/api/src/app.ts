import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyCors from '@fastify/cors';
import type { FastifyCorsOptions } from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import type {
  ApiErrorResponse,
  PublicToolDescriptor,
  StatusResponse,
  ToolRuntime,
  ToolsResponse,
} from '@mb/core';
import { API_ROUTES, SCENARIOS } from '@mb/core';
import { originAllowed } from './config';
import type { AppContext } from './context';
import { resolveClientIp } from './http-util';
import { pathOnly } from './infra/logger';
import type { McpEndpoint } from './mcp';
import { createMcpEndpoint } from './mcp';
import { registerPlaygroundRoute } from './playground/route';
import { registerConnectionRoutes } from './routes/connection';
import { registerExplorerRoute } from './routes/explorer';
import { BODY_LIMIT_BYTES, registerMcpRoutes } from './routes/mcp';
import { registerOAuthRoutes } from './routes/oauth';
import { createAppRuntime } from './runtime';
import { SERVER_NAME } from './version';

export interface AppParts {
  runtime: ToolRuntime;
  demo: McpEndpoint;
  live: McpEndpoint;
}

/** The demo + live MCP endpoints over the one ToolRuntime. Exposed for evals, scripts and tests. */
export function createAppParts(ctx: AppContext): AppParts {
  const runtime = createAppRuntime(ctx);
  return {
    runtime,
    demo: createMcpEndpoint({ runtime, mode: 'demo', version: ctx.version, log: ctx.coreLog }),
    live: createMcpEndpoint({ runtime, mode: 'live', version: ctx.version, log: ctx.coreLog }),
  };
}

export function playgroundEnabled(ctx: AppContext): boolean {
  return ctx.config.env.MB_PLAYGROUND_ENABLED && ctx.anthropic !== null;
}

export function publicTools(runtime: ToolRuntime): PublicToolDescriptor[] {
  return runtime.listTools().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputJsonSchema: t.inputJsonSchema,
    outputJsonSchema: t.outputJsonSchema,
    annotations: t.annotations,
    scopes: t.scopes,
  }));
}

function routePath(request: FastifyRequest): string {
  return pathOnly(request.url);
}

const READY_TTL_MS = 2_000;

const NOT_FOUND_BODY = {
  error: { code: 'NOT_FOUND', message: 'Not found.' },
} satisfies ApiErrorResponse;

/**
 * Log fields for an unexpected server error. Drizzle's DrizzleQueryError (and any error carrying `query`/`params`)
 * embeds the SQL parameters in its message (key hashes, ciphertext, tenant ids), so only names and codes of the
 * error and its cause are logged for those; other messages are kept, truncated.
 */
function serverErrorSummary(err: FastifyError): Record<string, unknown> {
  const out: Record<string, unknown> = { err_name: err.name, err_code: err.code };
  if (!('params' in err) && !('query' in err)) out.msg = String(err.message).slice(0, 200);
  const cause: unknown = err.cause;
  if (cause instanceof Error) {
    out.cause_name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.cause_code = code;
  }
  return out;
}

/** Timing-safe `Authorization: Bearer <expected>` check (fixed-length digests, so no length leak). */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m?.[1]) return false;
  const a = createHash('sha256').update(m[1], 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Builds the single Fastify deployable. Fastify is constructed directly (not createMcpFastifyApp, which accepts
 * no logger/trustProxy options) and the SDK's `hostHeaderValidation` hook is added for every route except
 * /health/* (platform health checks may use an internal Host).
 */
export async function buildApp(
  ctx: AppContext,
  parts: AppParts = createAppParts(ctx),
): Promise<FastifyInstance> {
  const config = ctx.config;
  const app = Fastify({
    loggerInstance: ctx.log,
    // No X-Forwarded-* trust: the caller IP comes from resolveClientIp (config.clientIpSource), and nothing else
    // here reads request.ip / protocol / host.
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
  }) as unknown as FastifyInstance;

  app.decorateRequest('mbClientIp', '');

  // Error bodies: client errors keep Fastify's (safe) code and message; server errors never echo internals
  // (driver messages carry hosts, ports, SQL). Fastify does not log when a custom handler is set, so log here.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 500;
    if (status >= 500) {
      request.log.error(serverErrorSummary(err), 'request failed');
      return reply.code(status).send({
        error: { code: 'INTERNAL', message: 'Internal server error.' },
      } satisfies ApiErrorResponse);
    }
    request.log.info({ err_code: err.code, status }, 'request rejected');
    return reply.code(status).send({
      error: { code: err.code || 'BAD_REQUEST', message: err.message },
    } satisfies ApiErrorResponse);
  });
  // The default 404 echoes the full URL (query string included, e.g. an OAuth `code`).
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND_BODY));

  const hostCheck = hostHeaderValidation(config.allowedHosts);
  app.addHook('onRequest', async (request, reply) => {
    request.mbClientIp = resolveClientIp(request, config.clientIpSource);
    const path = routePath(request);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (path.startsWith('/oauth/') || path === API_ROUTES.playground) {
      reply.header('cache-control', 'no-store');
    }
    if (path.startsWith('/health/')) return;
    await hostCheck(request, reply);
  });

  // CORS: /api/* for the web app's origins; /mcp/demo for any origin (no credentials); /mcp and the rest: none.
  await app.register(fastifyCors, {
    delegator: (
      request: FastifyRequest,
      cb: (error: Error | null, options?: FastifyCorsOptions) => void,
    ) => {
      const path = routePath(request);
      if (path.startsWith('/api/')) {
        cb(null, {
          origin: (origin, done) =>
            done(null, origin === undefined ? false : originAllowed(origin, config.corsOrigins)),
          methods: ['GET', 'POST', 'OPTIONS'],
          maxAge: 600,
        });
        return;
      }
      if (path === API_ROUTES.mcpDemo) {
        cb(null, {
          origin: '*',
          credentials: false,
          methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
          exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
          maxAge: 600,
        });
        return;
      }
      cb(null, { origin: false });
    },
  });

  // ---- health ----
  app.get(API_ROUTES.healthLive, () => ({ ok: true }));
  // /health/ready is public and unauthenticated: coalesce probes so a flood costs at most one Redis PING and one
  // Postgres query per READY_TTL_MS (both pings resolve false on failure; they never reject).
  let readyProbe: { at: number; result: Promise<[boolean, boolean]> } | null = null;
  const readiness = (): Promise<[boolean, boolean]> => {
    const now = ctx.clock.now();
    if (readyProbe === null || now - readyProbe.at >= READY_TTL_MS) {
      readyProbe = { at: now, result: Promise.all([ctx.pingKv(), ctx.pingStore()]) };
    }
    return readyProbe.result;
  };
  app.get(API_ROUTES.healthReady, async (_request, reply) => {
    const [kvOk, storeOk] = await readiness();
    const ok = kvOk && storeOk;
    return reply.code(ok ? 200 : 503).send({
      ok,
      storage: ctx.storageMode,
      kv: ctx.kvMode,
      checks: { kv: kvOk, store: storeOk },
      version: ctx.version,
    });
  });

  // ---- public read-only API ----
  app.get(API_ROUTES.status, (): StatusResponse => ({
    version: ctx.version,
    playground_enabled: playgroundEnabled(ctx),
    model: config.env.MB_PLAYGROUND_MODEL,
    demo_mcp_url: `${config.env.MB_PUBLIC_API_URL.replace(/\/+$/, '')}${API_ROUTES.mcpDemo}`,
    tool_count: parts.runtime.listTools().length,
    turnstile_site_key: config.env.TURNSTILE_SITE_KEY ?? null,
    connect_enabled: config.connectEnabled,
  }));
  app.get(API_ROUTES.tools, (): ToolsResponse => ({
    server: { name: SERVER_NAME, version: ctx.version },
    tools: publicTools(parts.runtime),
  }));
  app.get(API_ROUTES.scenarios, () => SCENARIOS);
  // Prometheus scrape: bearer-protected when MB_METRICS_TOKEN is set; without it, open in dev/test only.
  const metricsToken = config.env.MB_METRICS_TOKEN;
  app.get('/metrics', async (request, reply) => {
    if (metricsToken) {
      if (!bearerMatches(request.headers.authorization, metricsToken)) {
        return reply
          .code(401)
          .header('www-authenticate', 'Bearer realm="merchantbridge-metrics"')
          .send({
            error: { code: 'UNAUTHORIZED', message: 'Metrics require a bearer token.' },
          } satisfies ApiErrorResponse);
      }
    } else if (config.isProd) {
      return reply.code(404).send(NOT_FOUND_BODY);
    }
    const body = await ctx.metrics.registry.metrics();
    return reply.header('content-type', ctx.metrics.registry.contentType).send(body);
  });

  registerExplorerRoute(app, { ctx, demoHandler: parts.demo.handler });
  registerPlaygroundRoute(app, { ctx, demoHandler: parts.demo.handler });
  registerMcpRoutes(app, { ctx, demo: parts.demo, live: parts.live });
  registerOAuthRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);

  app.addHook('onClose', async () => {
    await Promise.allSettled([parts.demo.close(), parts.live.close()]);
  });
  return app;
}
