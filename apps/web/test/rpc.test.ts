import { describe, expect, it } from 'vitest';
import { summarizeRpc } from '../lib/rpc';

// Shapes captured from the real apps/api /api/explorer/call (memory mode, FakeZoho), trimmed.
const OK = {
  result: {
    _meta: {
      'dev.merchantbridge/trace': { decisions: [{ type: 'admitted', waited_ms: 0 }], upstream_calls: 1 },
      'io.modelcontextprotocol/serverInfo': { name: 'merchantbridge', version: '0.1.0' },
    },
    content: [{ type: 'text', text: '{"data":{"sku":"CHAI-250"}}' }],
    structuredContent: { data: { sku: 'CHAI-250' }, meta: { demo: true } },
    isError: false,
    resultType: 'complete',
  },
  jsonrpc: '2.0',
  id: 0,
};

const RATE_LIMITED = {
  result: {
    content: [{ type: 'text', text: '{"error":{"code":"RATE_LIMITED"}}' }],
    structuredContent: {
      error: { code: 'RATE_LIMITED', message: 'blocked', retryable: true, retry_after_s: 60 },
    },
    isError: true,
  },
  jsonrpc: '2.0',
  id: 0,
};

describe('summarizeRpc', () => {
  it('returns structuredContent of a successful call, skipping _meta and the text copy', () => {
    expect(summarizeRpc(OK)).toEqual({
      isError: false,
      code: null,
      structured: { data: { sku: 'CHAI-250' }, meta: { demo: true } },
    });
  });

  it('reads the tool error code from an isError result', () => {
    const s = summarizeRpc(RATE_LIMITED);
    expect(s.isError).toBe(true);
    expect(s.code).toBe('RATE_LIMITED');
    expect(s.structured).toMatchObject({ error: { retry_after_s: 60 } });
  });

  it('reports JSON-RPC protocol errors (unknown tool) with their numeric code', () => {
    expect(
      summarizeRpc({ jsonrpc: '2.0', id: 0, error: { code: -32602, message: 'Tool nope not found' } }),
    ).toEqual({ isError: true, code: 'JSON-RPC -32602', structured: null });
  });

  it('tolerates a missing or non-object response', () => {
    expect(summarizeRpc(null)).toEqual({ isError: false, code: null, structured: null });
    expect(summarizeRpc({ result: { content: [] } })).toEqual({ isError: false, code: null, structured: null });
  });
});
