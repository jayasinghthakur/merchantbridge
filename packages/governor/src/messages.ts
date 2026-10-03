import type { UpstreamFailure } from '@mb/core';
import { ConnectorError } from '@mb/core';

/** Human-friendly "about N" duration for long waits (daily reset). */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.round(seconds / 360) / 10} h`;
}

const HINT_SLOW_DOWN =
  'Wait retry_after_s seconds before calling tools for this organization again, and make fewer calls in parallel.';
const HINT_PARALLEL = 'Make fewer tool calls in parallel, then retry after retry_after_s seconds.';
const HINT_DAILY =
  'Do not retry today. Answer from data already retrieved, or tell the user the limit resets at 00:00 UTC.';
const HINT_RETRY_SOON =
  'Retry in a few seconds; if it keeps failing, the upstream service may be having an outage.';
const HINT_PAUSED = 'Requests for this organization are paused; retry after retry_after_s seconds.';

/**
 * Agent-visible errors raised by the governor. Messages must be safe for an LLM: no upstream bodies, tokens or
 * internal keys; only counts, durations and HTTP status numbers.
 */
export function createMessages(upstream: string) {
  return {
    /** Zoho code 44: the upstream blocked the org; our circuit stays open meanwhile. */
    minuteBlocked(retryAfterS: number): ConnectorError {
      return new ConnectorError(
        'RATE_LIMITED',
        `${upstream} temporarily blocked this organization for exceeding its per-minute request limit; retry after ${retryAfterS} s.`,
        { retryAfterS, hint: HINT_SLOW_DOWN },
      );
    },

    /** Our own per-minute ceiling could not admit the call within the queue timeout. */
    minuteQueueTimeout(perMinute: number, retryAfterS: number): ConnectorError {
      return new ConnectorError(
        'RATE_LIMITED',
        `This organization reached its limit of ${perMinute} ${upstream} requests per minute; retry after ${retryAfterS} s.`,
        {
          retryAfterS,
          hint: 'Wait retry_after_s seconds, then retry. Prefer one call that returns many records over many single-record calls.',
        },
      );
    },

    /** No concurrency slot freed up within the queue timeout. */
    concurrencyQueueTimeout(retryAfterS: number): ConnectorError {
      return new ConnectorError(
        'RATE_LIMITED',
        `Too many ${upstream} requests for this organization are already in progress; retry after ${retryAfterS} s.`,
        { retryAfterS, hint: HINT_PARALLEL },
      );
    },

    /** Upstream 429 (code 1070 or unclassified) still failing after our retries, or a long Retry-After. */
    upstreamRateLimited(kind: 'concurrency' | 'other', retryAfterS: number): ConnectorError {
      const why =
        kind === 'concurrency'
          ? 'because too many requests for this organization were in progress'
          : 'because this organization is sending requests too fast';
      return new ConnectorError(
        'RATE_LIMITED',
        `${upstream} rejected the request ${why}; retry after ${retryAfterS} s.`,
        { retryAfterS, hint: kind === 'concurrency' ? HINT_PARALLEL : HINT_SLOW_DOWN },
      );
    },

    dailyExhausted(
      budget: number,
      retryAfterS: number,
      reportedByUpstream: boolean,
    ): ConnectorError {
      const message = reportedByUpstream
        ? `${upstream} reports this organization's daily API limit is used up; it is expected to reset at 00:00 UTC, in about ${describeWait(retryAfterS)}.`
        : `This connector has used today's budget of ${budget} ${upstream} API calls for this organization; it resets at 00:00 UTC, in about ${describeWait(retryAfterS)}.`;
      return new ConnectorError('DAILY_QUOTA_EXHAUSTED', message, {
        retryAfterS,
        hint: HINT_DAILY,
      });
    },

    /** Server/timeout/network failure after retries. `retryAfterS` is set when the breaker opened. */
    upstreamFailed(
      failure: UpstreamFailure,
      attempts: number,
      retryAfterS?: number,
    ): ConnectorError {
      const tries = `${attempts} attempt${attempts === 1 ? '' : 's'}`;
      let message: string;
      switch (failure.kind) {
        case 'server':
          message = `${upstream} returned a server error (HTTP ${failure.status}) on ${tries}.`;
          break;
        case 'timeout':
          message = `${upstream} did not respond in time on ${tries}.`;
          break;
        default:
          message = `Could not reach ${upstream} on ${tries} (network error).`;
      }
      if (retryAfterS !== undefined) {
        message += ` Requests for this organization are paused for ${retryAfterS} s to let it recover.`;
      }
      return new ConnectorError('UPSTREAM_ERROR', message, {
        retryable: true,
        ...(retryAfterS === undefined ? {} : { retryAfterS }),
        hint: retryAfterS === undefined ? HINT_RETRY_SOON : HINT_PAUSED,
      });
    },

    /** Breaker open: rejected instantly without an upstream call. */
    breakerOpen(retryAfterS: number): ConnectorError {
      return new ConnectorError(
        'UPSTREAM_ERROR',
        `${upstream} has been failing for this organization, so requests are paused; retry after ${retryAfterS} s.`,
        { retryable: true, retryAfterS, hint: HINT_PAUSED },
      );
    },

    /** Half-open: another call is the single probe. */
    probeInFlight(retryAfterS: number): ConnectorError {
      return new ConnectorError(
        'UPSTREAM_ERROR',
        `${upstream} is recovering from errors for this organization and a test request is in progress; retry after ${retryAfterS} s.`,
        { retryable: true, retryAfterS, hint: HINT_PAUSED },
      );
    },
  };
}

export type GovernorMessages = ReturnType<typeof createMessages>;
