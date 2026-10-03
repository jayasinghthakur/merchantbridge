import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  MCPCallToolResultLike,
  MCPClientLike,
  MCPToolLike,
} from '@anthropic-ai/sdk/helpers/beta/mcp';
import { mcpTool } from '@anthropic-ai/sdk/helpers/beta/mcp';
import type { CallToolResult, Client } from '@modelcontextprotocol/client';
import type { DemoFault, ErrorCode, GovernorDecision, TraceEvent } from '@mb/core';
import { ERROR_CODES } from '@mb/core';
import type { FetchHandler } from '../inprocess';
import { connectInProcess } from '../inprocess';
import type { TraceMeta } from '../mcp';
import { TRACE_META_KEY } from '../mcp';
import { API_VERSION } from '../version';
import { SYSTEM_PROMPT } from './prompt';

type RunnableTool = ReturnType<typeof mcpTool>;

export interface AgentToolCall {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  is_error: boolean;
  error_code: ErrorCode | null;
}

export interface RunAgentOptions {
  message: string;
  /** Demo session id (`X-MB-Session`): scopes governor, cache and fault state. */
  session: string;
  faults: readonly DemoFault[];
  model: string;
  anthropic: Anthropic;
  /** The DEMO MCP handler; the agent never talks to the live endpoint. */
  mcpHandler: FetchHandler;
  onEvent: (event: TraceEvent) => void;
  signal?: AbortSignal;
  maxIterations?: number;
  maxTokens?: number;
  /**
   * Tool calls allowed per question (default 10). Calls past it never reach MCP; the model gets an is_error result
   * telling it to answer with what it has. Bounds parallel-call fan-out (each result can be ~10K tokens and is
   * re-sent on every later request).
   */
  maxToolCalls?: number;
  /**
   * Cumulative billed input tokens (cache reads/writes included) after which the loop stops instead of sending
   * another request (default 120K). The run ends with the last stop_reason (`tool_use` = partial answer).
   */
  maxInputTokens?: number;
}

export const DEFAULT_MAX_TOOL_CALLS = 10;
export const DEFAULT_MAX_INPUT_TOKENS = 120_000;

export interface RunAgentResult {
  stopReason: string;
  toolCalls: AgentToolCall[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  finalText: string;
}

const MAX_RESULT_PREVIEW_CHARS = 6_000;

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

function traceOf(result: CallToolResult | undefined): Partial<TraceMeta> {
  const meta = result?._meta;
  const trace = meta?.[TRACE_META_KEY];
  return typeof trace === 'object' && trace !== null ? trace : {};
}

function errorCodeOf(structured: unknown): ErrorCode | null {
  const code = (structured as { error?: { code?: unknown } } | undefined)?.error?.code;
  return isErrorCode(code) ? code : null;
}

function cachedOf(structured: unknown, trace: Partial<TraceMeta>): boolean {
  const cached = (structured as { meta?: { cached?: unknown } } | undefined)?.meta?.cached;
  return cached === true || (trace.cache_hits ?? 0) > 0;
}

/** structuredContent for the trace pane, cut down when large. */
function displayResult(structured: unknown): unknown {
  if (structured === undefined) return null;
  const text = JSON.stringify(structured);
  if (text.length <= MAX_RESULT_PREVIEW_CHARS) return structured;
  return { truncated: true, preview: text.slice(0, MAX_RESULT_PREVIEW_CHARS) };
}

/** MCP inputSchema → Anthropic input_schema without the `$schema` dialect marker. */
function toToolLike(tool: {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}): MCPToolLike {
  const { $schema: _dialect, ...schema } = tool.inputSchema;
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: { ...schema, type: 'object' },
  };
}

function toResultLike(r: CallToolResult): MCPCallToolResultLike {
  const sc = r.structuredContent;
  return {
    content: r.content,
    isError: r.isError,
    structuredContent: typeof sc === 'object' && sc !== null ? sc : undefined,
  };
}

const unusedClient: MCPClientLike = {
  callTool: () => Promise.reject(new Error('not used')),
};

interface ToolBudget {
  used: number;
  readonly max: number;
}

/** Wraps one MCP tool so every call emits tool_call / tool_result trace events with the governor decisions. */
function tracedTool(
  def: MCPToolLike,
  mcp: Client,
  emit: (e: TraceEvent) => void,
  calls: AgentToolCall[],
  signal: AbortSignal | undefined,
  budget: ToolBudget,
): RunnableTool {
  const base = mcpTool(def, unusedClient);
  return {
    ...base,
    run: async (args, context) => {
      const callId = context?.toolUse.id ?? randomUUID();
      const input = args ?? {};
      emit({ type: 'tool_call', call_id: callId, tool: def.name, args: input });
      if (budget.used >= budget.max) {
        // Counted synchronously, so parallel tool_use blocks in one turn cannot overshoot the cap.
        const message = `The tool-call budget for this question is used up (${budget.max} calls); answer with the results you already have.`;
        emit({
          type: 'tool_result',
          call_id: callId,
          tool: def.name,
          is_error: true,
          error_code: null,
          duration_ms: 0,
          cached: false,
          upstream_calls: 0,
          retries: 0,
          decisions: [],
          budget_remaining_today: null,
          result: { error: { message } },
        });
        calls.push({
          call_id: callId,
          tool: def.name,
          args: input,
          is_error: true,
          error_code: null,
        });
        throw new Error(message); // the runner sends it back as an is_error tool_result
      }
      budget.used += 1;
      const started = Date.now();
      let raw: CallToolResult | undefined;
      const capture: MCPClientLike = {
        callTool: async (params) => {
          raw = await mcp.callTool(params, signal ? { signal } : undefined);
          return toResultLike(raw);
        },
      };
      try {
        return await mcpTool(def, capture).run(input, context);
      } finally {
        const trace = traceOf(raw);
        const structured = raw?.structuredContent;
        const isError = raw === undefined || raw.isError === true;
        const errorCode = errorCodeOf(structured);
        const decisions: GovernorDecision[] = Array.isArray(trace.decisions) ? trace.decisions : [];
        const budgetFromMeta = (
          structured as { meta?: { budget_remaining_today?: unknown } } | undefined
        )?.meta?.budget_remaining_today;
        emit({
          type: 'tool_result',
          call_id: callId,
          tool: def.name,
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
        calls.push({
          call_id: callId,
          tool: def.name,
          args: input,
          is_error: isError,
          error_code: errorCode,
        });
      }
    },
  };
}

/**
 * The playground/eval agent: an in-process MCP client on the DEMO handler → Anthropic `mcpTool` adapters →
 * `beta.messages.toolRunner` (streaming, `tool_choice: auto`, cached system prompt). Emits TraceEvents as it goes
 * and finally a `done` event. Throws Anthropic API errors and aborts to the caller.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const started = Date.now();
  const maxIterations = opts.maxIterations ?? 6;
  const maxTokens = opts.maxTokens ?? 1024;
  const maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const budget: ToolBudget = { used: 0, max: opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS };
  const emit = (e: TraceEvent): void => {
    try {
      opts.onEvent(e);
    } catch {
      // a broken listener must not break the run
    }
  };
  opts.signal?.throwIfAborted();

  const headers: Record<string, string> = { 'x-mb-session': opts.session };
  if (opts.faults.length > 0) headers['x-mb-faults'] = [...opts.faults].join(',');
  const mcp = await connectInProcess({
    handler: opts.mcpHandler,
    headers,
    clientName: 'merchantbridge-playground',
    clientVersion: API_VERSION,
  });

  try {
    const { tools } = await mcp.listTools();
    const toolCalls: AgentToolCall[] = [];
    const runnable = tools.map((t) =>
      tracedTool(
        toToolLike(
          t as { name: string; description?: string; inputSchema: Record<string, unknown> },
        ),
        mcp,
        emit,
        toolCalls,
        opts.signal,
        budget,
      ),
    );

    const runner = opts.anthropic.beta.messages.toolRunner(
      {
        model: opts.model,
        max_tokens: maxTokens,
        max_iterations: maxIterations,
        tool_choice: { type: 'auto' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: runnable,
        messages: [{ role: 'user', content: opts.message }],
        stream: true,
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';
    let finalText = '';
    for await (const stream of runner) {
      stream.on('text', (delta) => {
        if (delta !== '') emit({ type: 'assistant_text', text: delta });
      });
      const msg = await stream.finalMessage();
      const u = msg.usage;
      inputTokens +=
        u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      outputTokens += u.output_tokens;
      stopReason = msg.stop_reason ?? 'end_turn';
      finalText = msg.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      // The runner does not apply these stop rules itself.
      if (stopReason === 'refusal') break;
      if (stopReason === 'max_tokens' && msg.content.some((b) => b.type === 'tool_use')) break;
      // Cost bound: leaving the loop here means the pending tool calls never run and no further request is sent.
      if (inputTokens >= maxInputTokens) break;
      opts.signal?.throwIfAborted();
    }

    const durationMs = Date.now() - started;
    emit({
      type: 'done',
      stop_reason: stopReason,
      tool_calls: toolCalls.length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
    });
    return { stopReason, toolCalls, inputTokens, outputTokens, durationMs, finalText };
  } finally {
    await mcp.close().catch(() => undefined);
  }
}
