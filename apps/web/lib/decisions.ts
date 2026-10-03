import type { GovernorDecision } from '@mb/core/governor';

export type ChipTone = 'neutral' | 'brand' | 'warn' | 'danger';

export interface DecisionChip {
  label: string;
  tone: ChipTone;
  /** Longer explanation for title / screen readers. */
  detail: string;
}

/** Values this large are epoch timestamps; smaller ones are treated as a duration in ms. */
const EPOCH_THRESHOLD_MS = 1e12;

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/**
 * `circuit_open.until_ms` is documented only as "until"; we accept either an epoch timestamp (relative to
 * `nowMs`, normally the time the event arrived) or a plain duration.
 */
export function circuitSeconds(untilMs: number, nowMs: number): string {
  return seconds(untilMs >= EPOCH_THRESHOLD_MS ? untilMs - nowMs : untilMs);
}

export function decisionChip(d: GovernorDecision, nowMs: number): DecisionChip {
  switch (d.type) {
    case 'admitted':
      return d.waited_ms > 0
        ? {
            label: `admitted · waited ${d.waited_ms}ms`,
            tone: 'neutral',
            detail: `Admitted by the governor after waiting ${d.waited_ms} ms.`,
          }
        : { label: 'admitted', tone: 'neutral', detail: 'Admitted by the governor immediately.' };
    case 'queued': {
      const reason = d.reason === 'minute_bucket' ? 'per-minute budget' : 'concurrency';
      return {
        label: `queued ${reason} · ${d.wait_ms}ms`,
        tone: 'warn',
        detail: `Queued for ${d.wait_ms} ms waiting on the ${reason} limit.`,
      };
    }
    case 'retried':
      return {
        label: `retried ${d.reason} · ${d.backoff_ms}ms`,
        tone: 'warn',
        detail: `Attempt ${d.attempt} retried after ${d.reason} with ${d.backoff_ms} ms backoff.`,
      };
    case 'circuit_open':
      return {
        label: `circuit open ${circuitSeconds(d.until_ms, nowMs)}`,
        tone: 'danger',
        detail: `Circuit opened (${d.reason}); upstream calls are paused.`,
      };
    case 'rejected':
      return {
        label:
          d.retry_after_s === undefined
            ? `rejected ${d.code}`
            : `rejected ${d.code} · retry ${d.retry_after_s}s`,
        tone: 'danger',
        detail: `Rejected by the governor with ${d.code}.`,
      };
    case 'cache_hit':
      return { label: 'cache hit', tone: 'brand', detail: 'Served from the short-TTL cache.' };
    case 'coalesced':
      return {
        label: 'coalesced',
        tone: 'brand',
        detail: 'Shared an identical in-flight upstream request.',
      };
  }
}
