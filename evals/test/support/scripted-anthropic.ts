import Anthropic from '@anthropic-ai/sdk';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON access to recorded request bodies
export type Json = any;

/** What the fake saw in the request it is answering (the tool results the "model" has read so far). */
export interface ScriptContext {
  /** Text of every tool_result block in the request, oldest first. */
  toolResults: string[];
  /** `toolResults` joined; handy for regex extraction. */
  toolResultsText: string;
}

export interface ScriptedToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** One scripted Messages API response (streamed as SSE, since runAgent uses `stream: true`). */
export type ScriptedTurn =
  /** One assistant message with one or more tool_use blocks (several = parallel tool use). */
  | { kind: 'tools'; calls: ScriptedToolCall[]; text?: string }
  /** The final answer; may be computed from the tool results seen so far. */
  | { kind: 'text'; text: string | ((ctx: ScriptContext) => string); stopReason?: string }
  | { kind: 'error'; status: number; body: unknown };

/** A fixed script, or one chosen per conversation from its first user message and the requested model. */
export type Script =
  readonly ScriptedTurn[] | ((firstUserMessage: string, model: string) => readonly ScriptedTurn[]);

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export const SCRIPTED_API_KEY = 'sk-test-scripted-0000-not-a-real-key';

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function messageStream(n: number, model: string, blocks: Block[], stopReason: string): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: `msg_scripted_${n}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100 + n,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: b.text },
      });
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 + n },
  });
  events.push({ type: 'message_stop' });
  return sse(events);
}

function textOf(content: Json): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((x: Json) => x?.type === 'text')
    .map((x: Json) => String(x.text))
    .join('');
}

export function toolResultsOf(body: Json): string[] {
  const out: string[] = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block?.type === 'tool_result') out.push(textOf(block.content));
    }
  }
  return out;
}

/**
 * A real Anthropic SDK client whose HTTP layer replays a script (no network). The fake is stateless: the turn
 * to play is the number of assistant messages already in the request, so one client can serve many
 * conversations (sequentially or interleaved). Requests are recorded as parsed bodies. Past the end of the
 * script it answers with an `end_turn` text so a runaway loop still terminates.
 */
export function scriptedAnthropic(script: Script) {
  const requests: Json[] = [];
  let n = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body: Json = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    requests.push(body);
    n += 1;
    const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
    const turns =
      typeof script === 'function'
        ? script(textOf(messages[0]?.content), String(body.model))
        : script;
    const index = messages.filter((m) => m?.role === 'assistant').length;
    const turn: ScriptedTurn = turns[index] ?? { kind: 'text', text: '(script exhausted)' };
    if (turn.kind === 'error') {
      return new Response(JSON.stringify(turn.body), {
        status: turn.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    let blocks: Block[];
    let stopReason: string;
    if (turn.kind === 'tools') {
      blocks = [
        ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
        ...turn.calls.map((c, i) => ({
          type: 'tool_use' as const,
          id: `toolu_scripted_${n}_${i}`,
          name: c.name,
          input: c.input,
        })),
      ];
      stopReason = 'tool_use';
    } else {
      const results = toolResultsOf(body);
      const text =
        typeof turn.text === 'function'
          ? turn.text({ toolResults: results, toolResultsText: results.join('\n') })
          : turn.text;
      blocks = [{ type: 'text', text }];
      stopReason = turn.stopReason ?? 'end_turn';
    }
    return new Response(messageStream(n, String(body.model), blocks, stopReason), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const client = new Anthropic({
    apiKey: SCRIPTED_API_KEY,
    baseURL: 'http://anthropic.scripted.invalid',
    fetch: fetchImpl,
    maxRetries: 0,
  });
  return { client, requests };
}
