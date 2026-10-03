export interface RpcSummary {
  /** True for a tool error result (`isError: true`) and for a JSON-RPC protocol error. */
  isError: boolean;
  /** Tool error code (e.g. RATE_LIMITED) or `JSON-RPC <code>` for protocol errors. */
  code: string | null;
  /**
   * `result.structuredContent`: the envelope (or error body) an agent works with. The raw response also carries
   * `_meta` and a text copy ahead of it, so the explorer shows this part on its own. Null when absent.
   */
  structured: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads a raw JSON-RPC `tools/call` response as captured by /api/explorer/call. */
export function summarizeRpc(response: unknown): RpcSummary {
  if (!isObject(response)) return { isError: false, code: null, structured: null };
  const error = response.error;
  if (isObject(error)) {
    return {
      isError: true,
      code: typeof error.code === 'number' ? `JSON-RPC ${error.code}` : 'JSON-RPC',
      structured: null,
    };
  }
  const result = isObject(response.result) ? response.result : null;
  const structured = result && 'structuredContent' in result ? result.structuredContent : null;
  const errBody = isObject(structured) && isObject(structured.error) ? structured.error : null;
  return {
    isError: result?.isError === true,
    code: typeof errBody?.code === 'string' ? errBody.code : null,
    structured: structured ?? null,
  };
}
