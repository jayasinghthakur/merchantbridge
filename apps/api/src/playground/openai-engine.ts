import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { connectInProcess } from '../inprocess';
import { API_VERSION } from '../version';
import type { AgentRunOptions, RunAgentResult } from './engine';
import {
  LlmProviderError,
  isQuotaExhausted,
  llmRetryAfterSeconds,
  scrubSecrets,
} from './llm-error';
import { SYSTEM_PROMPT } from './prompt';
import type { AgentToolCall, ToolBudget, TraceContext, TracedCallOutcome } from './trace';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_TOOL_CALLS,
  demoMcpHeaders,
  rejectCall,
  safeEmitter,
  tracedCall,
} from './trace';

/**
 * The playground/eval agent on any OpenAI-compatible Chat Completions API (Groq's free tier by default; also
 * Gemini's OpenAI endpoint, OpenRouter or a local Ollama). Same MCP path, trace events, budgets and result as
 * `runAgent`; only the model loop differs (non-streaming `POST {baseUrl}/chat/completions`, `tool_choice: auto`).
 */

export interface OpenAiCompatibleLlm {
  /** e.g. https://api.groq.com/openai/v1 (no trailing /chat/completions). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Tests inject a fake; defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Extra attempts after a 429 (not quota), 5xx, network error or Groq `tool_use_failed` (default 1). A retry only
   * happens when the wait the provider asks for is ≤ `maxRetryDelayMs` (default 3 s), so the playground surfaces
   * a long rate limit at once while evals (which raise both) ride out per-minute free-tier windows.
   */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number;
}

export interface RunAgentOpenAIOptions extends AgentRunOptions {
  llm: OpenAiCompatibleLlm;
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatResponse {
  content: string;
  toolCalls: OpenAiToolCall[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_RETRY_DELAY_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY_CHARS = 500;

/** MCP tools → OpenAI `tools` (JSON Schema without the `$schema` dialect marker; always an object schema). */
export function toOpenAiTools(
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>,
) {
  return tools.map((t) => {
    const { $schema: _dialect, ...schema } = t.inputSchema;
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        parameters: { ...schema, type: 'object', properties: schema.properties ?? {} },
      },
    };
  });
}

/** The text an MCP tool result shows the model (its text content; structuredContent JSON if there is none). */
export function mcpResultText(result: CallToolResult): string {
  const parts = result.content.map((c) =>
    c.type === 'text' ? c.text : `[${c.type} content omitted]`,
  );
  if (
    parts.length === 0 &&
    typeof result.structuredContent === 'object' &&
    result.structuredContent
  ) {
    return JSON.stringify(result.structuredContent);
  }
  return parts.join('\n') || '(empty result)';
}

function outcomeText(outcome: TracedCallOutcome, tool: string): string {
  switch (outcome.kind) {
    case 'result':
      return mcpResultText(outcome.result);
    case 'budget_exhausted':
      return `Error: ${outcome.message}`;
    case 'failed': {
      const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return `Error: the ${tool} call failed (${msg.slice(0, 200)}).`;
    }
  }
}

/** Chunks the final answer into a few assistant_text events (the request is not streamed). */
export function textChunks(text: string, size = 160): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf(' ', size);
    const at = cut > size / 2 ? cut + 1 : size;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest !== '') out.push(rest);
  return out;
}

/** finish_reason → the Anthropic-style stop reasons the trace, logs and evals already use. */
function stopReasonOf(finishReason: string | null, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_use';
  switch (finishReason) {
    case null:
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return finishReason;
  }
}

/** Waits `ms`; rejects (with an AbortError) as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(aborted());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseChatResponse(json: unknown): ChatResponse {
  const body = json as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: { content?: unknown; tool_calls?: unknown };
    }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;
  const choice = body?.choices?.[0];
  if (!choice?.message) {
    throw new LlmProviderError({
      kind: 'bad_response',
      status: 200,
      message: 'LLM provider returned no choices',
    });
  }
  const rawCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  const toolCalls: OpenAiToolCall[] = rawCalls
    .map((c: unknown) => c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } })
    .filter((c) => typeof c.function?.name === 'string')
    .map((c) => {
      const args = c.function?.arguments;
      return {
        id: typeof c.id === 'string' && c.id !== '' ? c.id : `call_${randomUUID()}`,
        type: 'function' as const,
        function: {
          name: String(c.function?.name),
          // Some servers send an object instead of a JSON string.
          arguments:
            typeof args === 'string' ? args : args === undefined ? '{}' : JSON.stringify(args),
        },
      };
    });
  const content = typeof choice.message.content === 'string' ? choice.message.content : '';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    content,
    toolCalls,
    finishReason: choice.finish_reason ?? null,
    promptTokens: num(body?.usage?.prompt_tokens),
    completionTokens: num(body?.usage?.completion_tokens),
  };
}

function isRetryable(e: LlmProviderError): boolean {
  if (e.kind === 'network') return true;
  if (e.kind !== 'http') return false;
  if (e.status === 429) return !isQuotaExhausted(e);
  if (e.status >= 500) return true;
  // Groq: the model emitted a malformed tool call; the same request usually succeeds on a second try.
  return e.status === 400 && /tool_use_failed/.test(e.body);
}

async function postOnce(
  llm: OpenAiCompatibleLlm,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ChatResponse> {
  const doFetch = llm.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeout = AbortSignal.timeout(llm.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new LlmProviderError({
      kind: 'network',
      message: `LLM provider unreachable (${e instanceof Error ? e.name : 'error'})`,
      cause: e,
    });
  }
  if (!res.ok) {
    const auth = res.status === 401 || res.status === 403;
    const text = await res.text().catch(() => '');
    // Auth failures keep no body: providers echo (part of) the rejected key there.
    const safe = auth ? '' : scrubSecrets(text, [llm.apiKey]).slice(0, MAX_ERROR_BODY_CHARS);
    throw new LlmProviderError({
      kind: 'http',
      status: res.status,
      headers: res.headers,
      body: auth && /quota|credits/i.test(text) ? 'insufficient_quota' : safe,
      message: `LLM provider HTTP ${res.status}${safe ? `: ${safe.slice(0, 200)}` : ''}`,
    });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new LlmProviderError({
      kind: 'bad_response',
      status: res.status,
      message: 'LLM provider returned a body that is not JSON',
    });
  }
  return parseChatResponse(json);
}

/** One chat completion with bounded retries (see OpenAiCompatibleLlm.maxRetries). */
export async function chatCompletion(
  llm: OpenAiCompatibleLlm,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const maxRetries = llm.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxDelayMs = llm.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(llm, body, signal);
    } catch (e) {
      if (!(e instanceof LlmProviderError) || attempt >= maxRetries || !isRetryable(e)) throw e;
      const asked = llmRetryAfterSeconds(e);
      const delayMs = asked === null ? 500 * 2 ** attempt : Math.ceil(asked * 1000) + 250;
      if (delayMs > maxDelayMs) throw e;
      await sleep(delayMs, signal);
    }
  }
}

function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw.trim() === '' ? '{}' : raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Same contract as `runAgent`: in-process MCP client on the DEMO handler, TraceEvents as it goes, a final `done`.
 * Throws LlmProviderError (HTTP/network) and aborts to the caller.
 */
export async function runAgentOpenAI(opts: RunAgentOpenAIOptions): Promise<RunAgentResult> {
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
    const known = new Set(tools.map((t) => t.name));
    const toolCalls: AgentToolCall[] = [];
    const trace: TraceContext = { mcp, emit, calls: toolCalls, signal: opts.signal, budget };
    const openAiTools = toOpenAiTools(tools);
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: opts.message },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';
    let finalText = '';
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      opts.signal?.throwIfAborted();
      const res = await chatCompletion(
        opts.llm,
        {
          model: opts.llm.model,
          messages,
          tools: openAiTools,
          tool_choice: 'auto',
          max_tokens: maxTokens,
          temperature: 0.2,
        },
        opts.signal,
      );
      inputTokens += res.promptTokens;
      outputTokens += res.completionTokens;
      finalText = res.content;
      stopReason = stopReasonOf(res.finishReason, res.toolCalls.length > 0);

      if (res.toolCalls.length === 0) {
        for (const chunk of textChunks(res.content)) emit({ type: 'assistant_text', text: chunk });
        break;
      }
      // Text the model wrote alongside its tool calls is shown too (the Anthropic engine streams it).
      if (res.content.trim() !== '') emit({ type: 'assistant_text', text: res.content });
      // Truncated tool-call arguments, or the cost bound: the pending calls never run, no further request.
      if (res.finishReason === 'length' || inputTokens >= maxInputTokens) break;

      messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls });
      const replies = await Promise.all(
        res.toolCalls.map(async (tc): Promise<string> => {
          const name = tc.function.name;
          const args = parseArguments(tc.function.arguments);
          if (args === null) {
            const message = `The arguments for ${name} were not valid JSON; call it again with a JSON object that matches its schema.`;
            rejectCall(trace, { callId: tc.id, tool: name, args: {} }, message, 'INVALID_INPUT');
            return `Error: ${message}`;
          }
          if (!known.has(name)) {
            const message = `There is no tool named "${name}". Use one of: ${[...known].join(', ')}.`;
            rejectCall(trace, { callId: tc.id, tool: name, args }, message, 'INVALID_INPUT');
            return `Error: ${message}`;
          }
          const outcome = await tracedCall(trace, { callId: tc.id, tool: name, args });
          return outcomeText(outcome, name);
        }),
      );
      opts.signal?.throwIfAborted();
      res.toolCalls.forEach((tc, i) => {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: replies[i] ?? '' });
      });
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
