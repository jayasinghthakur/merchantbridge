import Anthropic from '@anthropic-ai/sdk';
import type { Json } from './helpers';

/** One scripted Messages API turn. */
export type ScriptedTurn =
  | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown>; text?: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; status: number; body: unknown; headers?: Record<string, string> }
  /** Never answers until the request is aborted. */
  | { kind: 'hang' };

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function messageStream(
  turn: Extract<ScriptedTurn, { kind: 'tool_use' | 'text' }>,
  n: number,
  model: string,
): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: `msg_${n}`,
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
  let index = 0;
  const text = turn.text;
  if (text !== undefined) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    const mid = Math.ceil(text.length / 2);
    for (const part of [text.slice(0, mid), text.slice(mid)]) {
      if (part)
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: part },
        });
    }
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }
  if (turn.kind === 'tool_use') {
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: turn.id, name: turn.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.input) },
    });
    events.push({ type: 'content_block_stop', index });
  }
  events.push({
    type: 'message_delta',
    delta: { stop_reason: turn.kind === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 + n },
  });
  events.push({ type: 'message_stop' });
  return sse(events);
}

/**
 * A real Anthropic client whose HTTP layer replays a script. Requests are recorded (parsed bodies) so tests can
 * assert what the runner sent. When the script runs out, `fallback` answers.
 */
export function scriptedAnthropic(
  script: ScriptedTurn[],
  fallback: ScriptedTurn = { kind: 'text', text: 'ok' },
) {
  const requests: Array<Record<string, Json>> = [];
  const aborted: boolean[] = [];
  let n = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      Json
    >;
    requests.push(body);
    const turn = script[n] ?? fallback;
    n += 1;
    if (turn.kind === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          aborted.push(true);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (turn.kind === 'error') {
      return new Response(JSON.stringify(turn.body), {
        status: turn.status,
        headers: { 'content-type': 'application/json', ...turn.headers },
      });
    }
    return new Response(messageStream(turn, n, String(body.model)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const client = new Anthropic({
    apiKey: 'test-anthropic-key',
    baseURL: 'http://anthropic.test',
    fetch: fetchImpl,
    maxRetries: 0,
  });
  return { client, requests, aborted, factory: () => client };
}
