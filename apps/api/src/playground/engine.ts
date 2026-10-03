import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  MCPCallToolResultLike,
  MCPClientLike,
  MCPToolLike,
} from '@anthropic-ai/sdk/helpers/beta/mcp';
import { mcpTool } from '@anthropic-ai/sdk/helpers/beta/mcp';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { DemoFault, TraceEvent } from '@mb/core';
import type { FetchHandler } from '../inprocess';
import { connectInProcess } from '../inprocess';
import { API_VERSION } from '../version';
import { SYSTEM_PROMPT } from './prompt';
import type { AgentToolCall, ToolBudget, TraceContext } from './trace';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_TOOL_CALLS,
  demoMcpHeaders,
  safeEmitter,
  tracedCall,
} from './trace';

export type { AgentToolCall } from './trace';
export { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_TOOL_CALLS } from './trace';

type RunnableTool = ReturnType<typeof mcpTool>;

/** Options shared by every engine (Anthropic and OpenAI-compatible). */
export interface AgentRunOptions {
  message: string;
  /** Demo session id (`X-MB-Session`): scopes governor, cache and fault state. */
  session: string;
  faults: readonly DemoFault[];
  /** The DEMO MCP handler; the agent never talks to the live endpoint. */
  mcpHandler: FetchHandler;
  onEvent: (event: TraceEvent) => void;
  signal?: AbortSignal;
  /** Model requests per question (default 6). */
  maxIterations?: number;
  /** Output-token cap per model request (default 1024). */
  maxTokens?: number;
  /**
   * Tool calls allowed per question (default 10). Calls past it never reach MCP; the model gets an error result
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

export interface RunAgentOptions extends AgentRunOptions {
  model: string;
  anthropic: Anthropic;
}

export interface RunAgentResult {
  stopReason: string;
  toolCalls: AgentToolCall[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  finalText: string;
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

/**
 * Wraps one MCP tool so every call goes through the shared traced call path; the SDK's `mcpTool` then turns the
 * already-fetched MCP result into tool_result content (is_error results throw a ToolError, as before).
 */
function tracedTool(def: MCPToolLike, trace: TraceContext): RunnableTool {
  const base = mcpTool(def, unusedClient);
  return {
    ...base,
    run: async (args, context) => {
      const input = args ?? {};
      const outcome = await tracedCall(trace, {
        callId: context?.toolUse.id ?? randomUUID(),
        tool: def.name,
        args: input,
      });
      // The runner sends a thrown error back to the model as an is_error tool_result.
      if (outcome.kind === 'budget_exhausted') throw new Error(outcome.message);
      if (outcome.kind === 'failed') throw outcome.error;
      const replay: MCPClientLike = {
        callTool: () => Promise.resolve(toResultLike(outcome.result)),
      };
      return mcpTool(def, replay).run(input, context);
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
  const emit = safeEmitter(opts.onEvent);
  opts.signal?.throwIfAborted();

  const mcp = await connectInProcess({
    handler: opts.mcpHandler,
    headers: demoMcpHeaders(opts.session, opts.faults),
    clientName: 'merchantbridge-playground',
    clientVersion: API_VERSION,
  });

  try {
    const { tools } = await mcp.listTools();
    const toolCalls: AgentToolCall[] = [];
    const trace: TraceContext = { mcp, emit, calls: toolCalls, signal: opts.signal, budget };
    const runnable = tools.map((t) =>
      tracedTool(
        toToolLike(
          t as { name: string; description?: string; inputSchema: Record<string, unknown> },
        ),
        trace,
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
