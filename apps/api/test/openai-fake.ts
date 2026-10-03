import type { Json } from './helpers';

export const TEST_LLM_KEY = 'gsk_test_0123456789abcdefNOTREAL';
export const TEST_LLM_BASE_URL = 'http://llm.test/openai/v1';

export interface ScriptedOpenAiCall {
  id?: string;
  name: string;
  /** An object is JSON-encoded; a string is sent as-is (to test invalid JSON). */
  arguments: Record<string, unknown> | string;
}

/** One scripted Chat Completions response. */
export type OpenAiTurn =
  | { kind: 'tool_calls'; calls: ScriptedOpenAiCall[]; text?: string }
  | { kind: 'text'; text: string; finishReason?: string }
  | { kind: 'error'; status: number; body: unknown; headers?: Record<string, string> }
  /** fetch rejects (DNS / connection reset). */
  | { kind: 'network' }
  /** Never answers until the request is aborted. */
  | { kind: 'hang' };

export interface RecordedRequest {
  url: string;
  authorization: string | null;
  body: Json;
}

/**
 * A fake OpenAI-compatible `/chat/completions` endpoint (no network). Plays the script in order; past its end it
 * answers `fallback`. Requests are recorded with their parsed bodies.
 */
export function scriptedOpenAi(
  script: OpenAiTurn[],
  fallback: OpenAiTurn = { kind: 'text', text: 'ok' },
) {
  const requests: RecordedRequest[] = [];
  const aborted: boolean[] = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body: Json = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    requests.push({ url, authorization: headers.get('authorization'), body });
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
    if (turn.kind === 'network') throw new TypeError('fetch failed');
    if (turn.kind === 'error') {
      return new Response(JSON.stringify(turn.body), {
        status: turn.status,
        headers: { 'content-type': 'application/json', ...turn.headers },
      });
    }
    const message =
      turn.kind === 'tool_calls'
        ? {
            role: 'assistant',
            content: turn.text ?? null,
            tool_calls: turn.calls.map((c, i) => ({
              id: c.id ?? `call_${n}_${i}`,
              type: 'function',
              function: {
                name: c.name,
                arguments:
                  typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
              },
            })),
          }
        : { role: 'assistant', content: turn.text };
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${n}`,
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message,
            finish_reason:
              turn.kind === 'tool_calls' ? 'tool_calls' : (turn.finishReason ?? 'stop'),
          },
        ],
        usage: { prompt_tokens: 200 + n, completion_tokens: 30 + n, total_tokens: 230 + 2 * n },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch: fetchImpl, requests, aborted };
}

export const OPENAI_ENV: Record<string, string> = {
  MB_PLAYGROUND_ENABLED: 'true',
  MB_LLM_API_KEY: TEST_LLM_KEY,
  MB_LLM_BASE_URL: TEST_LLM_BASE_URL,
};
