import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Anything with the web-standard MCP handler face (`createMcpHandler(...).fetch`). */
export interface FetchHandler {
  fetch(request: Request): Promise<Response>;
}

export interface JsonRpcExchange {
  request: unknown;
  response: unknown;
}

export interface InProcessClientOptions {
  handler: FetchHandler;
  /** Sent on every request (e.g. X-MB-Session / X-MB-Faults). */
  headers?: Record<string, string>;
  clientName: string;
  clientVersion: string;
  /** 'auto' speaks the 2026-07-28 protocol; 'legacy' the 2025 initialize handshake. Default 'auto'. */
  negotiation?: 'auto' | 'legacy';
  /** Receives every raw JSON-RPC request/response pair (parsed bodies). */
  onExchange?: (exchange: JsonRpcExchange) => void;
  /** Base URL the transport believes it talks to; never resolved on the network. */
  url?: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses a JSON body, or the `data:` frames of an SSE body (returns the last message frame). */
export function parseMcpResponseBody(text: string, contentType: string | null): unknown {
  if (contentType?.includes('text/event-stream')) {
    let last: unknown;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data !== '') last = parseJson(data) ?? last;
    }
    return last;
  }
  return parseJson(text);
}

/**
 * Connects an MCP Client to a handler in the same process (no sockets): the transport's fetch calls
 * `handler.fetch` directly. Used by the playground, the explorer, evals and tests, so they exercise exactly what
 * external hosts see.
 */
export async function connectInProcess(opts: InProcessClientOptions): Promise<Client> {
  const fetchViaHandler = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    if (!opts.onExchange) return opts.handler.fetch(request);
    const reqText = typeof init?.body === 'string' ? init.body : '';
    const response = await opts.handler.fetch(request);
    if (reqText !== '') {
      const resText = await response.clone().text();
      opts.onExchange({
        request: parseJson(reqText),
        response: parseMcpResponseBody(resText, response.headers.get('content-type')),
      });
    }
    return response;
  };

  const transport = new StreamableHTTPClientTransport(
    new URL(opts.url ?? 'http://in-process.invalid/mcp'),
    {
      fetch: fetchViaHandler,
      ...(opts.headers ? { requestInit: { headers: opts.headers } } : {}),
    },
  );
  const client = new Client(
    { name: opts.clientName, version: opts.clientVersion },
    { versionNegotiation: { mode: opts.negotiation ?? 'auto' } },
  );
  await client.connect(transport);
  return client;
}
