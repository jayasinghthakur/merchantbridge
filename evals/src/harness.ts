import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentToolCall, FetchHandler, LlmConnection } from '@mb/api';
import {
  LlmProviderError,
  createAgentRunner,
  createAppContext,
  createAppParts,
  loadConfig,
} from '@mb/api';
import type { TraceEvent } from '@mb/core';
import type { CaseRun, CaseRunError, ObservedToolCall } from './assertions';
import type { EvalCase } from './case';

/**
 * Engine settings. Same loops as the playground (`runAgent` on Anthropic, `runAgentOpenAI` on an OpenAI-compatible
 * provider); max_tokens is raised so Sonnet's adaptive thinking fits.
 */
export const ENGINE_DEFAULTS = { maxTokens: 4096, maxIterations: 6 } as const;

export interface DemoEndpoint {
  /** The in-process /mcp/demo handler (demo tenant + FakeZoho only). */
  handler: FetchHandler;
  /** Tool names served by the endpoint, in tools/list order. */
  toolNames: string[];
  close(): Promise<void>;
}

/** Any outbound request from the app side is a bug: the demo path talks to FakeZoho in-process only. */
const blockedFetch: typeof fetch = (input) =>
  Promise.reject(
    new Error(
      `evals: unexpected outbound fetch (${input instanceof Request ? input.url : String(input)})`,
    ),
  );

/**
 * Builds the demo MCP endpoint exactly as apps/api serves it, from an explicit minimal config: no database, no
 * Redis, no Zoho credentials, no LLM key (the agent's model connection is passed to `runCase` separately).
 * Nothing is read from process.env here, so a live tenant can never be reached (golden rule 6).
 */
export async function createDemoEndpoint(): Promise<DemoEndpoint> {
  const ctx = await createAppContext(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    fetch: blockedFetch,
  });
  const parts = createAppParts(ctx);
  return {
    handler: parts.demo.handler,
    toolNames: parts.runtime.listTools().map((t) => t.name),
    async close() {
      await Promise.allSettled([parts.demo.close(), parts.live.close()]);
      await ctx.close();
    },
  };
}

/** Demo session ids must match /^[A-Za-z0-9_-]{8,64}$/ (apps/api demo.ts) or the endpoint ignores them. */
export function sessionIdFor(
  model: string,
  caseId: string,
  suffix = randomBytes(3).toString('hex'),
): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
  const id =
    `ev-${slug(model.split('/').pop() ?? model).replace(/^claude-/, '')}-${slug(caseId)}`.slice(
      0,
      64 - suffix.length - 1,
    );
  return `${id}-${suffix}`;
}

/** Error summary safe to print and store: class, HTTP status, message with any secret removed. */
export function describeError(e: unknown, secrets: readonly string[] = []): CaseRunError {
  let message = e instanceof Error ? e.message : String(e);
  for (const s of secrets) if (s.length >= 8) message = message.split(s).join('[redacted]');
  return {
    name: e instanceof Error ? e.constructor.name : typeof e,
    status:
      e instanceof Anthropic.APIError && typeof e.status === 'number'
        ? e.status
        : e instanceof LlmProviderError && e.status > 0
          ? e.status
          : null,
    message: message.slice(0, 500),
  };
}

function observed(c: AgentToolCall): ObservedToolCall {
  return { tool: c.tool, args: c.args, is_error: c.is_error, error_code: c.error_code };
}

/** Tool calls reconstructed from the trace, for runs that threw before `runAgent` returned. */
function callsFromTrace(events: readonly TraceEvent[]): ObservedToolCall[] {
  const byId = new Map<string, ObservedToolCall>();
  for (const e of events) {
    if (e.type === 'tool_call') {
      byId.set(e.call_id, { tool: e.tool, args: e.args, is_error: false, error_code: null });
    } else if (e.type === 'tool_result') {
      const call = byId.get(e.call_id);
      if (call) {
        call.is_error = e.is_error;
        call.error_code = e.error_code;
      }
    }
  }
  return [...byId.values()];
}

export interface RunCaseOptions {
  model: string;
  /** Anthropic client or OpenAI-compatible endpoint + key (see `createAgentRunner` in @mb/api). */
  llm: LlmConnection;
  endpoint: Pick<DemoEndpoint, 'handler'>;
  maxTokens?: number;
  maxIterations?: number;
  /** Strings to scrub from error messages (the API key). */
  secrets?: readonly string[];
  session?: string;
  signal?: AbortSignal;
  /** Receives every playground trace event (tool_call, tool_result, assistant_text, done). */
  onEvent?: (e: TraceEvent) => void;
}

/** Runs one case through the playground engine. Never throws for API/agent failures: they land in `error`. */
export async function runCase(c: EvalCase, opts: RunCaseOptions): Promise<CaseRun> {
  const session = opts.session ?? sessionIdFor(opts.model, c.id);
  const events: TraceEvent[] = [];
  const started = Date.now();
  const base = { caseId: c.id, model: opts.model, session };
  try {
    const runAgent = createAgentRunner({ ...opts.llm, model: opts.model });
    const r = await runAgent({
      message: c.prompt,
      session,
      faults: [],
      mcpHandler: opts.endpoint.handler,
      onEvent: (e) => {
        events.push(e);
        opts.onEvent?.(e);
      },
      maxTokens: opts.maxTokens ?? ENGINE_DEFAULTS.maxTokens,
      maxIterations: opts.maxIterations ?? ENGINE_DEFAULTS.maxIterations,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return {
      ...base,
      toolCalls: r.toolCalls.map(observed),
      finalText: r.finalText,
      stopReason: r.stopReason,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      durationMs: r.durationMs,
      error: null,
    };
  } catch (e) {
    return {
      ...base,
      toolCalls: callsFromTrace(events),
      finalText: '',
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - started,
      error: describeError(e, opts.secrets),
    };
  }
}
