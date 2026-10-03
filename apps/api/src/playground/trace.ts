import type { CallToolResult, Client } from '@modelcontextprotocol/client';
import type { ErrorCode, GovernorDecision, TraceEvent } from '@mb/core';
import { ERROR_CODES } from '@mb/core';
import type { TraceMeta } from '../mcp';
import { TRACE_META_KEY } from '../mcp';

/**
 * The MCP call + trace path shared by both agent engines (Anthropic toolRunner and OpenAI-compatible loop): every
 * tool call emits `tool_call` then `tool_result` (with the governor decisions from the trace `_meta`), counts
 * against the per-question tool budget and is recorded as an AgentToolCall.
 */

export interface AgentToolCall {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  is_error: boolean;
  error_code: ErrorCode | null;
}

export interface ToolBudget {
  used: number;
  readonly max: number;
}

export const DEFAULT_MAX_TOOL_CALLS = 10;
export const DEFAULT_MAX_INPUT_TOKENS = 120_000;

const MAX_RESULT_PREVIEW_CHARS = 6_000;

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

export function traceOf(result: CallToolResult | undefined): Partial<TraceMeta> {
  const meta = result?._meta;
  const trace = meta?.[TRACE_META_KEY];
  return typeof trace === 'object' && trace !== null ? trace : {};
}

export function errorCodeOf(structured: unknown): ErrorCode | null {
  const code = (structured as { error?: { code?: unknown } } | undefined)?.error?.code;
  return isErrorCode(code) ? code : null;
}

export function cachedOf(structured: unknown, trace: Partial<TraceMeta>): boolean {
  const cached = (structured as { meta?: { cached?: unknown } } | undefined)?.meta?.cached;
  return cached === true || (trace.cache_hits ?? 0) > 0;
}

/** structuredContent for the trace pane, cut down when large. */
export function displayResult(structured: unknown): unknown {
  if (structured === undefined) return null;
  const text = JSON.stringify(structured);
  if (text.length <= MAX_RESULT_PREVIEW_CHARS) return structured;
  return { truncated: true, preview: text.slice(0, MAX_RESULT_PREVIEW_CHARS) };
}

export function budgetExhaustedMessage(max: number): string {
  return `The tool-call budget for this question is used up (${max} calls); answer with the results you already have.`;
}

/** A listener that throws must not break the run. */
export function safeEmitter(onEvent: (e: TraceEvent) => void): (e: TraceEvent) => void {
  return (e) => {
    try {
      onEvent(e);
    } catch {
      // a broken listener must not break the run
    }
  };
}

export interface TraceContext {
  mcp: Client;
  emit: (e: TraceEvent) => void;
  calls: AgentToolCall[];
  signal: AbortSignal | undefined;
  budget: ToolBudget;
}

export interface TracedCallInput {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export type TracedCallOutcome =
  /** MCP answered (possibly with an is_error tool result). */
  | { kind: 'result'; result: CallToolResult }
  /** Past the per-question cap: MCP was never called. */
  | { kind: 'budget_exhausted'; message: string }
  /** The MCP request itself failed (abort, JSON-RPC error, transport). */
  | { kind: 'failed'; error: unknown };

/**
 * Records a call that never reaches MCP (budget cap, unparsable arguments, unknown tool) as a `tool_call` +
 * is_error `tool_result` pair, so the trace and the eval record still show what the model attempted.
 */
export function rejectCall(
  ctx: Pick<TraceContext, 'emit' | 'calls'>,
  call: TracedCallInput,
  message: string,
  errorCode: ErrorCode | null = null,
): void {
  ctx.emit({ type: 'tool_call', call_id: call.callId, tool: call.tool, args: call.args });
  ctx.emit({
    type: 'tool_result',
    call_id: call.callId,
    tool: call.tool,
    is_error: true,
    error_code: errorCode,
    duration_ms: 0,
    cached: false,
    upstream_calls: 0,
    retries: 0,
    decisions: [],
    budget_remaining_today: null,
    result: { error: errorCode ? { code: errorCode, message } : { message } },
  });
  ctx.calls.push({
    call_id: call.callId,
    tool: call.tool,
    args: call.args,
    is_error: true,
    error_code: errorCode,
  });
}

/**
 * One traced MCP tool call. The budget is checked and counted synchronously (before the first await), so
 * parallel calls in one model turn cannot overshoot the cap. Never throws: failures come back as an outcome.
 */
export async function tracedCall(
  ctx: TraceContext,
  call: TracedCallInput,
): Promise<TracedCallOutcome> {
  if (ctx.budget.used >= ctx.budget.max) {
    const message = budgetExhaustedMessage(ctx.budget.max);
    rejectCall(ctx, call, message);
    return { kind: 'budget_exhausted', message };
  }
  ctx.emit({ type: 'tool_call', call_id: call.callId, tool: call.tool, args: call.args });
  ctx.budget.used += 1;
  const started = Date.now();
  let raw: CallToolResult | undefined;
  try {
    raw = await ctx.mcp.callTool(
      { name: call.tool, arguments: call.args },
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
    return { kind: 'result', result: raw };
  } catch (error) {
    return { kind: 'failed', error };
  } finally {
    const trace = traceOf(raw);
    const structured = raw?.structuredContent;
    const isError = raw === undefined || raw.isError === true;
    const errorCode = errorCodeOf(structured);
    const decisions: GovernorDecision[] = Array.isArray(trace.decisions) ? trace.decisions : [];
    const budgetFromMeta = (
      structured as { meta?: { budget_remaining_today?: unknown } } | undefined
    )?.meta?.budget_remaining_today;
    ctx.emit({
      type: 'tool_result',
      call_id: call.callId,
      tool: call.tool,
      is_error: isError,
      error_code: errorCode,
      duration_ms: Date.now() - started,
      cached: cachedOf(structured, trace),
      upstream_calls: trace.upstream_calls ?? 0,
      retries: trace.retries ?? 0,
      decisions,
      budget_remaining_today:
        trace.budget_remaining_today ??
        (typeof budgetFromMeta === 'number' ? budgetFromMeta : null),
      result: displayResult(structured),
    });
    ctx.calls.push({
      call_id: call.callId,
      tool: call.tool,
      args: call.args,
      is_error: isError,
      error_code: errorCode,
    });
  }
}

/** Connection headers for the in-process demo MCP client (session scope + fault toggles). */
export function demoMcpHeaders(session: string, faults: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = { 'x-mb-session': session };
  if (faults.length > 0) headers['x-mb-faults'] = [...faults].join(',');
  return headers;
}
