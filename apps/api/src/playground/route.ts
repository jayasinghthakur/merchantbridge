import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiErrorResponse, TraceEvent } from '@mb/core';
import { API_ROUTES, DEMO_FAULTS, SCENARIOS } from '@mb/core';
import type { AppContext } from '../context';
import { SESSION_ID_RE, ipSessionId } from '../demo';
import { hitWindow } from '../infra/limits';
import { SseStream } from '../infra/sse';
import { verifyTurnstile } from '../infra/turnstile';
import type { FetchHandler } from '../inprocess';
import { clientIp, clientIpKey, copyReplyHeadersToRaw } from '../http-util';
import { runAgent } from './engine';

export const PLAYGROUND_DISABLED_MESSAGE =
  'The live agent is paused; use the Tools explorer, which needs no LLM.';

const SCENARIO_IDS = new Set(SCENARIOS.map((s) => s.id));

export const playgroundRequestSchema = z.object({
  scenario_id: z
    .string()
    .refine((id) => SCENARIO_IDS.has(id), 'Unknown scenario.')
    .optional(),
  message: z.string().trim().min(1).max(500),
  session_id: z.string().regex(SESSION_ID_RE),
  faults: z.array(z.enum(DEMO_FAULTS)).max(DEMO_FAULTS.length).default([]),
  turnstile_token: z.string().min(1).max(4096).optional(),
});

const PER_IP_LIMIT = 10;
const PER_IP_WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const VERIFIED_TTL_MS = 60 * 60_000;

type ErrorEvent = Extract<TraceEvent, { type: 'error' }>;

function apiError(
  reply: FastifyReply,
  status: number,
  body: ApiErrorResponse['error'],
): FastifyReply {
  if (body.retry_after_s !== undefined) reply.header('retry-after', String(body.retry_after_s));
  return reply.code(status).send({ error: body } satisfies ApiErrorResponse);
}

/** Anthropic failures → agent-safe SSE error events. Details stay in the logs. */
export function mapAgentError(e: unknown): Omit<ErrorEvent, 'type'> {
  if (e instanceof Anthropic.APIError) {
    if (e.status === 400 && /usage limit/i.test(e.message)) {
      return {
        code: 'BUDGET_EXHAUSTED',
        message:
          'The demo has used its AI budget for now; the Tools explorer still works without an LLM.',
      };
    }
    if (e.status === 429) {
      const headers: unknown = e.headers;
      const raw = headers instanceof Headers ? headers.get('retry-after') : null;
      const retry = raw ? Number(raw) : Number.NaN;
      return {
        code: 'RATE_LIMITED',
        message: 'The AI model is busy right now; try again shortly.',
        ...(Number.isFinite(retry) && retry > 0 ? { retry_after_s: Math.ceil(retry) } : {}),
      };
    }
  }
  return { code: 'INTERNAL', message: 'The agent hit an unexpected error. Please try again.' };
}

export interface PlaygroundRouteDeps {
  ctx: AppContext;
  demoHandler: FetchHandler;
}

export function registerPlaygroundRoute(app: FastifyInstance, deps: PlaygroundRouteDeps): void {
  const { ctx } = deps;
  const env = ctx.config.env;

  app.post(API_ROUTES.playground, async (request: FastifyRequest, reply: FastifyReply) => {
    // Watch for a disconnect from the very first line: a browser that leaves while the limits/Turnstile checks
    // are awaited must not start a model run nobody reads ('close' also fires after a normal reply; harmless).
    const controller = new AbortController();
    let finished = false;
    reply.raw.on('close', () => {
      if (!finished) controller.abort();
    });

    const anthropicFactory = ctx.anthropic;
    const enabled = env.MB_PLAYGROUND_ENABLED && anthropicFactory !== null;
    if (!enabled || !anthropicFactory) {
      return apiError(reply, 503, {
        code: 'PLAYGROUND_DISABLED',
        message: PLAYGROUND_DISABLED_MESSAGE,
      });
    }

    const parsed = playgroundRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return apiError(reply, 400, {
        code: 'BAD_REQUEST',
        message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request.',
      });
    }
    const body = parsed.data;
    const ip = clientIp(request);
    const ipKey = clientIpKey(request);

    // Order matters for cost: the cheap per-IP window first, then the bot check, and only requests that passed
    // both count against the global daily cap (otherwise unverified bots could burn it for everyone).
    const perIp = await hitWindow(
      ctx.kv,
      ctx.clock,
      `pg:ip:${ipKey}`,
      PER_IP_LIMIT,
      PER_IP_WINDOW_MS,
    );
    if (!perIp.allowed) {
      return apiError(reply, 429, {
        code: 'RATE_LIMITED',
        message: `Playground limit reached (${PER_IP_LIMIT} questions per 10 minutes).`,
        retry_after_s: perIp.retryAfterS,
      });
    }

    if (env.TURNSTILE_SECRET_KEY) {
      // A pass is remembered per session AND client IP: a solved challenge cannot be replayed by sharing the
      // session id across many hosts.
      const verifiedKey = `pg:verified:${body.session_id}:${ipSessionId(ipKey)}`;
      if ((await ctx.kv.get(verifiedKey)) === null) {
        const ok = await verifyTurnstile({
          secret: env.TURNSTILE_SECRET_KEY,
          token: body.turnstile_token,
          ip,
          fetch: ctx.fetch,
        });
        if (!ok) {
          return apiError(reply, 403, {
            code: 'BAD_REQUEST',
            message: 'Human verification failed; reload the page and try again.',
          });
        }
        await ctx.kv.set(verifiedKey, '1', { ttlMs: VERIFIED_TTL_MS });
      }
    }

    // Checked before the global slot is taken (runAgent re-checks right before the first model request).
    if (controller.signal.aborted) {
      request.log.info({ playground: true }, 'playground client went away before the run started');
      reply.hijack();
      reply.raw.destroy();
      return;
    }

    const global = await hitWindow(
      ctx.kv,
      ctx.clock,
      'pg:global',
      env.MB_PLAYGROUND_DAILY_CAP,
      DAY_MS,
    );
    if (!global.allowed) {
      return apiError(reply, 429, {
        code: 'RATE_LIMITED',
        message: "Today's playground budget is used up; the Tools explorer still works.",
        retry_after_s: global.retryAfterS,
      });
    }

    const model = env.MB_PLAYGROUND_MODEL;
    copyReplyHeadersToRaw(reply);
    reply.hijack();
    const sse = new SseStream(reply.raw);

    sse.send({
      type: 'session',
      session_id: body.session_id,
      model,
      replay: false,
      faults: body.faults,
    });
    try {
      const result = await runAgent({
        message: body.message,
        session: body.session_id,
        faults: body.faults,
        model,
        anthropic: anthropicFactory(),
        mcpHandler: deps.demoHandler,
        onEvent: (e) => sse.send(e),
        signal: controller.signal,
      });
      request.log.info(
        {
          playground: true,
          stop_reason: result.stopReason,
          tool_calls: result.toolCalls.length,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          duration_ms: result.durationMs,
        },
        'playground run finished',
      );
    } catch (e) {
      if (controller.signal.aborted) {
        request.log.info({ playground: true }, 'playground run aborted (client disconnected)');
      } else {
        const mapped = mapAgentError(e);
        request.log.error(
          {
            playground: true,
            code: mapped.code,
            err_name: e instanceof Error ? e.name : typeof e,
            status: e instanceof Anthropic.APIError ? e.status : undefined,
            msg: e instanceof Error ? e.message.slice(0, 300) : undefined,
          },
          'playground run failed',
        );
        sse.send({ type: 'error', ...mapped });
      }
    } finally {
      finished = true;
      sse.close();
    }
  });
}
