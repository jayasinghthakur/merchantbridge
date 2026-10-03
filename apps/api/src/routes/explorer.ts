import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiErrorResponse, ExplorerCallResponse, GovernorDecision } from '@mb/core';
import { API_ROUTES, DEMO_FAULTS } from '@mb/core';
import type { AppContext } from '../context';
import { SESSION_ID_RE } from '../demo';
import { clientIpKey, sendRateLimited } from '../http-util';
import { hitWindow } from '../infra/limits';
import type { FetchHandler, JsonRpcExchange } from '../inprocess';
import { connectInProcess } from '../inprocess';
import { TRACE_META_KEY } from '../mcp';

/** Strict: an unknown key (e.g. `arguments` for `args`) is a 400, never silently dropped. */
export const explorerRequestSchema = z.strictObject({
  tool: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  args: z.record(z.string(), z.unknown()).default({}),
  session_id: z.string().regex(SESSION_ID_RE),
  faults: z.array(z.enum(DEMO_FAULTS)).max(DEMO_FAULTS.length).default([]),
});

const BODY_FIELDS = Object.keys(explorerRequestSchema.shape);

function badRequestMessage(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return 'Invalid request.';
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40)));
    return (
      `Unknown field(s) ${keys.join(', ')}. The body takes only ${BODY_FIELDS.join(', ')}; ` +
      'tool arguments go in "args".'
    );
  }
  return `${issue.path.join('.') || 'body'}: ${issue.message}`;
}

function decisionsOf(response: unknown): GovernorDecision[] {
  const meta = (response as { result?: { _meta?: Record<string, unknown> } } | undefined)?.result
    ?._meta;
  const trace = meta?.[TRACE_META_KEY] as { decisions?: unknown } | undefined;
  return Array.isArray(trace?.decisions) ? (trace.decisions as GovernorDecision[]) : [];
}

/**
 * POST /api/explorer/call: one tools/call through a real in-process MCP client against the DEMO handler, returning
 * the raw JSON-RPC request and response so the Tools page can show exactly what goes over the wire.
 */
export function registerExplorerRoute(
  app: FastifyInstance,
  deps: { ctx: AppContext; demoHandler: FetchHandler },
): void {
  const { ctx } = deps;
  app.post(API_ROUTES.explorerCall, async (request: FastifyRequest, reply: FastifyReply) => {
    const lim = await hitWindow(
      ctx.kv,
      ctx.clock,
      `explorer:ip:${clientIpKey(request)}`,
      30,
      60_000,
    );
    if (!lim.allowed)
      return sendRateLimited(
        reply,
        lim.retryAfterS,
        'Explorer limit reached (30 calls per minute).',
      );

    const parsed = explorerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: badRequestMessage(parsed.error.issues[0]) },
      } satisfies ApiErrorResponse);
    }
    const body = parsed.data;

    let exchange: JsonRpcExchange | null = null;
    const headers: Record<string, string> = { 'x-mb-session': body.session_id };
    if (body.faults.length > 0) headers['x-mb-faults'] = body.faults.join(',');
    const client = await connectInProcess({
      handler: deps.demoHandler,
      headers,
      clientName: 'merchantbridge-explorer',
      clientVersion: ctx.version,
      onExchange: (x) => {
        const method = (x.request as { method?: unknown } | undefined)?.method;
        if (method === 'tools/call') exchange = x;
      },
    });
    const started = Date.now();
    try {
      await client.callTool({ name: body.tool, arguments: body.args });
    } catch {
      // Protocol errors (unknown tool) are part of the captured JSON-RPC response.
    } finally {
      await client.close().catch(() => undefined);
    }
    const captured = exchange as JsonRpcExchange | null;
    const response: ExplorerCallResponse = {
      request: captured?.request ?? null,
      response: captured?.response ?? null,
      duration_ms: Date.now() - started,
      decisions: decisionsOf(captured?.response),
    };
    return reply.send(response);
  });
}
