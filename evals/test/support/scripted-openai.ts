import type { Json, Script, ScriptedTurn } from './scripted-anthropic';

/**
 * The OpenAI-compatible twin of `scriptedAnthropic`: a fake `POST {base}/chat/completions` that replays the same
 * Script / ScriptedTurn values (so every reference path runs on both engines). Stateless: the turn to play is the
 * number of assistant messages already in the request. Past the end of the script it answers with a plain
 * `stop` text so a runaway loop still terminates. No network.
 */

export const SCRIPTED_OPENAI_KEY = 'gsk_scripted_0000_not_a_real_key';
export const SCRIPTED_OPENAI_BASE_URL = 'http://openai.scripted.invalid/v1';

/** Text of every `role: tool` message in the request, oldest first. */
export function openAiToolResultsOf(body: Json): string[] {
  const messages: Json[] = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((m) => m?.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

/** stop_reason (Anthropic vocabulary used by the scripts) → finish_reason. */
function finishReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case undefined:
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return stopReason;
  }
}

export function scriptedOpenAi(script: Script) {
  const requests: Json[] = [];
  const urls: string[] = [];
  const authorizations: Array<string | null> = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const body: Json = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    requests.push(body);
    urls.push(String(input instanceof Request ? input.url : input));
    authorizations.push(new Headers(init?.headers).get('authorization'));
    n += 1;
    const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
    const firstUser = messages.find((m) => m?.role === 'user');
    const turns =
      typeof script === 'function'
        ? script(
            typeof firstUser?.content === 'string' ? firstUser.content : '',
            String(body.model),
          )
        : script;
    const index = messages.filter((m) => m?.role === 'assistant').length;
    const turn: ScriptedTurn = turns[index] ?? { kind: 'text', text: '(script exhausted)' };
    if (turn.kind === 'error') {
      return new Response(JSON.stringify(turn.body), {
        status: turn.status,
        headers: { 'content-type': 'application/json', ...turn.headers },
      });
    }
    let message: Json;
    let finish: string;
    if (turn.kind === 'tools') {
      message = {
        role: 'assistant',
        content: turn.text ?? null,
        tool_calls: turn.calls.map((c, i) => ({
          id: `call_scripted_${n}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      };
      finish = 'tool_calls';
    } else {
      const results = openAiToolResultsOf(body);
      const text =
        typeof turn.text === 'function'
          ? turn.text({ toolResults: results, toolResultsText: results.join('\n') })
          : turn.text;
      message = { role: 'assistant', content: text };
      finish = finishReason(turn.stopReason);
    }
    return new Response(
      JSON.stringify({
        id: `chatcmpl-scripted-${n}`,
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 100 + n, completion_tokens: 20 + n },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return {
    fetch: fetchImpl,
    requests,
    urls,
    authorizations,
    llm: {
      provider: 'openai' as const,
      baseUrl: SCRIPTED_OPENAI_BASE_URL,
      apiKey: SCRIPTED_OPENAI_KEY,
      fetch: fetchImpl,
      maxRetries: 0,
    },
  };
}
