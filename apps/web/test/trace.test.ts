import type { TraceEvent } from '@mb/core/telemetry';
import { describe, expect, it } from 'vitest';
import { parseTraceEvent } from '../lib/api';
import { circuitSeconds, decisionChip } from '../lib/decisions';
import { applyEvent, finishRun, newRun, toolSteps } from '../lib/trace';

const events: TraceEvent[] = [
  { type: 'session', session_id: 's', model: 'claude-haiku-4-5', replay: false, faults: [] },
  { type: 'assistant_text', text: 'Checking ' },
  { type: 'assistant_text', text: 'stock.' },
  { type: 'tool_call', call_id: 'c1', tool: 'zoho_get_item', args: { sku: 'CHAI-250' } },
  {
    type: 'tool_result',
    call_id: 'c1',
    tool: 'zoho_get_item',
    is_error: false,
    error_code: null,
    duration_ms: 42,
    cached: false,
    upstream_calls: 1,
    retries: 0,
    decisions: [{ type: 'admitted', waited_ms: 0 }],
    budget_remaining_today: 499,
    result: { data: {} },
  },
  { type: 'assistant_text', text: 'In stock.' },
  {
    type: 'done',
    stop_reason: 'end_turn',
    tool_calls: 1,
    input_tokens: 10,
    output_tokens: 5,
    duration_ms: 900,
  },
];

describe('trace reducer', () => {
  it('merges text deltas, pairs results with calls and finishes', () => {
    const run = events.reduce((r, e) => applyEvent(r, e, 1000), newRun('r', 'q', null));
    expect(run.status).toBe('done');
    expect(run.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text']);
    expect(run.items[0]).toEqual({ kind: 'text', text: 'Checking stock.' });
    const steps = toolSteps(run);
    expect(steps[0]?.result?.duration_ms).toBe(42);
    expect(steps[0]?.resultAt).toBe(1000);
  });

  it('marks a stream that ended without done as interrupted', () => {
    const first = events[0];
    if (!first) throw new Error('fixture');
    const run = finishRun(applyEvent(newRun('r', 'q', null), first, 0));
    expect(run.status).toBe('interrupted');
  });

  it('records error events', () => {
    const run = applyEvent(
      newRun('r', 'q', null),
      { type: 'error', code: 'RATE_LIMITED', message: 'slow down', retry_after_s: 30 },
      5,
    );
    expect(run.status).toBe('error');
    expect(run.errorAt).toBe(5);
  });
});

describe('parseTraceEvent', () => {
  it('accepts known events and rejects junk', () => {
    expect(parseTraceEvent('{"type":"assistant_text","text":"hi"}')).toEqual({
      type: 'assistant_text',
      text: 'hi',
    });
    expect(parseTraceEvent('{"type":"nope"}')).toBeNull();
    expect(parseTraceEvent('not json')).toBeNull();
  });
});

describe('decision chips', () => {
  it('formats the governor decisions shown in the trace', () => {
    expect(
      decisionChip({ type: 'retried', attempt: 1, reason: '1070', backoff_ms: 480 }, 0).label,
    ).toBe('retried 1070 · 480ms');
    expect(
      decisionChip({ type: 'circuit_open', until_ms: 60_000, reason: 'code 44' }, 0).label,
    ).toBe('circuit open 60s');
    expect(decisionChip({ type: 'cache_hit' }, 0).tone).toBe('brand');
  });

  it('labels an access-token refresh and the retry it caused', () => {
    expect(decisionChip({ type: 'token_refreshed' }, 0).label).toBe('token refreshed');
    expect(decisionChip({ type: 'token_refreshed' }, 0).detail).toMatch(/401/);
    expect(
      decisionChip({ type: 'retried', attempt: 2, reason: 'token_refreshed', backoff_ms: 0 }, 0)
        .label,
    ).toBe('retried after token refresh');
  });

  it('treats large until_ms as an epoch timestamp', () => {
    const now = Date.UTC(2026, 9, 3);
    expect(circuitSeconds(now + 45_000, now)).toBe('45s');
  });
});
