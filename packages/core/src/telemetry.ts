import type { ErrorCode } from './errors';
import type { GovernorDecision } from './governor';

/** Exactly one per tool call. Persisted to Postgres `usage_events`; the audit trail. No free text, no PII. */
export interface UsageEvent {
  ts: string;
  request_id: string;
  tenant_id: string;
  organization_id: string | null;
  connector: string;
  tool: string;
  /** From MCP `_meta` clientInfo; unauthenticated, telemetry label only. */
  client_name: string | null;
  demo: boolean;
  status: 'ok' | 'error';
  error_code: ErrorCode | null;
  duration_ms: number;
  upstream_calls: number;
  cache_hits: number;
  retries: number;
  result_tokens: number;
  args_masked: Record<string, unknown>;
}

const SAFE_TOKEN = /^[A-Za-z0-9_\-:.]{1,64}$/;

/** Keeps numbers, booleans and id-like strings (ids, SKUs, pay_ refs); masks anything that could be free text/PII. */
export function maskArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string') out[k] = SAFE_TOKEN.test(v) ? v : `<text:${v.length}>`;
    else if (Array.isArray(v)) out[k] = `<array:${v.length}>`;
    else out[k] = '<object>';
  }
  return out;
}

// ---------- demo faults (session-scoped toggles in the playground) ----------

export const DEMO_FAULTS = [
  'rate_limit_44',
  'expired_token',
  'daily_quota_45',
  'concurrency_1070',
  'server_5xx',
  'malformed',
] as const;

export type DemoFault = (typeof DEMO_FAULTS)[number];

// ---------- playground trace (SSE events from apps/api /api/playground to apps/web) ----------

export type TraceEvent =
  | { type: 'session'; session_id: string; model: string; replay: boolean; faults: DemoFault[] }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; call_id: string; tool: string; args: Record<string, unknown> }
  | {
      type: 'tool_result';
      call_id: string;
      tool: string;
      is_error: boolean;
      error_code: ErrorCode | null;
      duration_ms: number;
      cached: boolean;
      upstream_calls: number;
      retries: number;
      decisions: GovernorDecision[];
      budget_remaining_today: number | null;
      /** structuredContent, possibly truncated for display. */
      result: unknown;
    }
  | {
      type: 'done';
      stop_reason: string;
      tool_calls: number;
      input_tokens: number;
      output_tokens: number;
      duration_ms: number;
    }
  | {
      type: 'error';
      code: 'PLAYGROUND_DISABLED' | 'RATE_LIMITED' | 'BUDGET_EXHAUSTED' | 'BAD_REQUEST' | 'INTERNAL';
      message: string;
      retry_after_s?: number;
    };

export interface PlaygroundRequest {
  /** Scenario card id or omitted for free text. */
  scenario_id?: string;
  message: string;
  session_id: string;
  faults: DemoFault[];
  turnstile_token?: string;
}
