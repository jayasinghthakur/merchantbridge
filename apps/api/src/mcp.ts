import { randomUUID } from 'node:crypto';
import type {
  AuthInfo,
  CallToolResult,
  McpHttpHandler,
  McpRequestContext,
  ServerContext,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { CLIENT_INFO_META_KEY, McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { GovernorDecision, Logger, ToolDescriptor, ToolRuntime } from '@mb/core';
import { noopLogger } from '@mb/core';
import { DEMO_TENANT_ID } from '@mb/db';
import type { DemoSession } from './demo';
import { demoSessionFrom } from './demo';
import { API_VERSION, SERVER_NAME } from './version';

/** Custom result `_meta` key carrying the governor trace on demo responses (never sent on /mcp). */
export const TRACE_META_KEY = 'dev.merchantbridge/trace';

export interface TraceMeta {
  decisions: GovernorDecision[];
  upstream_calls: number;
  retries: number;
  cache_hits: number;
  duration_ms: number;
  budget_remaining_today: number | null;
}

/** What the Fastify routes put into `AuthInfo.extra` (never the API key itself). */
export interface McpAuthExtra extends Record<string, unknown> {
  tenantId?: string;
  keyId?: string;
  demoSession?: DemoSession;
}

export function liveAuthInfo(tenantId: string, keyId: string): AuthInfo {
  return {
    token: '[redacted]',
    clientId: tenantId,
    scopes: [],
    extra: { tenantId, keyId } satisfies McpAuthExtra,
  };
}

export function demoAuthInfo(session: DemoSession): AuthInfo {
  return {
    token: '[demo]',
    clientId: DEMO_TENANT_ID,
    scopes: [],
    extra: { demoSession: session } satisfies McpAuthExtra,
  };
}

/**
 * Advertises the tool's real JSON Schema in tools/list but accepts every argument: ToolRuntime is the single
 * validator, so bad arguments become our INVALID_INPUT result (with a usage event) instead of the SDK's own
 * "Input validation error" text.
 */
export function passthroughSchema(
  json: Record<string, unknown>,
): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'merchantbridge-passthrough',
      validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
      jsonSchema: {
        input: () => json,
        output: () => json,
      },
    },
  };
}

/** `RequestMetaEnvelope` is typed `{}` in the published .d.mts, so narrow by hand. */
export function clientNameOf(ctx: ServerContext): string | null {
  const env = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = env?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined;
  if (typeof info?.name === 'string' && info.name !== '') return info.name;
  // 2025-era stateless requests carry no clientInfo on tools/call; fall back to the User-Agent (telemetry only).
  const ua = ctx.http?.req?.headers.get('user-agent');
  return ua ? `ua:${ua}` : null;
}

export interface McpEndpointOptions {
  runtime: ToolRuntime;
  mode: 'live' | 'demo';
  version?: string;
  log?: Logger;
}

export interface McpEndpoint {
  mode: 'live' | 'demo';
  handler: McpHttpHandler;
  close(): Promise<void>;
}

function registerTools(
  server: McpServer,
  runtime: ToolRuntime,
  tools: readonly ToolDescriptor[],
  bind: { mode: 'live' | 'demo'; tenantId: string; demoSession?: DemoSession },
): void {
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: passthroughSchema(t.inputJsonSchema),
        outputSchema: t.output,
        annotations: { ...t.annotations },
      },
      async (args, sctx): Promise<CallToolResult> => {
        const demo = bind.mode === 'demo';
        const r = await runtime.callTool(t.name, args, {
          tenantId: bind.tenantId,
          requestId: randomUUID(),
          demo,
          clientName: clientNameOf(sctx),
          ...(demo && bind.demoSession ? { demoSession: bind.demoSession } : {}),
        });
        const result: CallToolResult = {
          content: [{ type: 'text', text: r.text }],
          structuredContent: r.structuredContent,
          isError: r.isError,
        };
        if (demo) {
          const env = r.structuredContent as { meta?: { budget_remaining_today?: number | null } };
          const trace: TraceMeta = {
            decisions: r.decisions,
            upstream_calls: r.usage.upstream_calls,
            retries: r.usage.retries,
            cache_hits: r.usage.cache_hits,
            duration_ms: r.usage.duration_ms,
            budget_remaining_today: env.meta?.budget_remaining_today ?? null,
          };
          result._meta = { [TRACE_META_KEY]: trace };
        }
        return result;
      },
    );
  }
}

/**
 * One MCP endpoint (stateless, JSON responses for 2026-era requests, 2025-era clients served statelessly).
 * The factory runs per HTTP request and binds the server to the caller: the authenticated tenant on /mcp, or the
 * demo tenant + the caller's demo session on /mcp/demo.
 */
export function createMcpEndpoint(opts: McpEndpointOptions): McpEndpoint {
  const log = opts.log ?? noopLogger;
  const version = opts.version ?? API_VERSION;
  const tools = opts.runtime.listTools();

  const factory = (rctx: McpRequestContext): McpServer => {
    const extra = (rctx.authInfo?.extra ?? {}) as McpAuthExtra;
    const server = new McpServer({ name: SERVER_NAME, version });
    if (opts.mode === 'demo') {
      const req = rctx.requestInfo;
      const session =
        extra.demoSession ??
        (req ? demoSessionFrom((n) => req.headers.get(n), 'in-process') : undefined);
      registerTools(server, opts.runtime, tools, {
        mode: 'demo',
        tenantId: DEMO_TENANT_ID,
        ...(session ? { demoSession: session } : {}),
      });
    } else {
      const tenantId = extra.tenantId;
      if (typeof tenantId !== 'string' || tenantId === '') {
        throw new Error('The live MCP endpoint requires an authenticated tenant.');
      }
      registerTools(server, opts.runtime, tools, { mode: 'live', tenantId });
    }
    log.debug({ mcp: opts.mode, era: rctx.era }, 'mcp request');
    return server;
  };

  const handler = createMcpHandler(factory, {
    responseMode: 'json',
    onerror: (err) =>
      log.warn({ mcp: opts.mode, err_name: err.name, msg: err.message.slice(0, 200) }, 'mcp error'),
  });
  return { mode: opts.mode, handler, close: () => handler.close() };
}
