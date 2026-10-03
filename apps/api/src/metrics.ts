import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { UsageEvent } from '@mb/core';

/** Prometheus metrics. Labels are bounded (tool names, statuses, error codes): never tenant or session ids. */
export interface Metrics {
  registry: Registry;
  observeToolCall(event: UsageEvent): void;
}

export function createMetrics(opts: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (opts.defaultMetrics) collectDefaultMetrics({ register: registry, prefix: 'mb_' });

  const calls = new Counter({
    name: 'mb_tool_calls_total',
    help: 'MCP tool calls by tool, status and error code.',
    labelNames: ['tool', 'status', 'error_code', 'demo'] as const,
    registers: [registry],
  });
  const latency = new Histogram({
    name: 'mb_tool_call_duration_seconds',
    help: 'MCP tool call latency (ToolRuntime, including upstream calls and retries).',
    labelNames: ['tool', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20],
    registers: [registry],
  });
  const upstream = new Counter({
    name: 'mb_upstream_calls_total',
    help: 'Upstream (Zoho) attempts admitted by the governor, by tool.',
    labelNames: ['tool'] as const,
    registers: [registry],
  });

  return {
    registry,
    observeToolCall(e) {
      calls.inc({
        tool: e.tool,
        status: e.status,
        error_code: e.error_code ?? 'none',
        demo: e.demo ? 'true' : 'false',
      });
      latency.observe({ tool: e.tool, status: e.status }, e.duration_ms / 1000);
      if (e.upstream_calls > 0) upstream.inc({ tool: e.tool }, e.upstream_calls);
    },
  };
}
