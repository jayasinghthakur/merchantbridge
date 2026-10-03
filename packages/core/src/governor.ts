/**
 * Contract between connector clients and the rate governor (implemented in @mb/governor). Clients wrap every
 * upstream request in `governor.schedule()`; the task throws `UpstreamError` for retryable classes and
 * `ConnectorError` for everything else.
 */
export interface RateProfile {
  /** Our own per-minute ceiling (below the upstream's hard limit). */
  perMinute: number;
  /** Concurrent in-flight requests per org. */
  concurrency: number;
  /** Upstream daily limit for the org's plan. */
  dailyLimit: number;
  /** Fraction of dailyLimit this connector may consume (shared with the merchant's other integrations). */
  dailyShare: number;
  /** Max time a request may wait for a token/slot before RATE_LIMITED. */
  queueTimeoutMs: number;
  /** Lease timeout so a crashed worker cannot hold a concurrency slot. */
  leaseMs: number;
  maxRetries429: number;
  maxRetries5xx: number;
  /** How long the circuit stays open after an upstream per-minute block (Zoho code 44). */
  minuteBlockOpenMs: number;
  /** Consecutive failures that open the circuit, and for how long. */
  breakerThreshold: number;
  breakerOpenMs: number;
  /** Per-attempt request timeout. */
  requestTimeoutMs: number;
}

export interface GovernorScope {
  /** e.g. `zoho:${tenantId}:${orgId}` or `demo:${sessionId}` */
  key: string;
  profile: RateProfile;
}

export type GovernorDecision =
  | { type: 'admitted'; waited_ms: number }
  | { type: 'queued'; reason: 'minute_bucket' | 'concurrency'; wait_ms: number }
  | { type: 'retried'; attempt: number; reason: string; backoff_ms: number }
  /** `until_ms` is an epoch timestamp (ms) at which the circuit may close. */
  | { type: 'circuit_open'; until_ms: number; reason: string }
  | { type: 'rejected'; code: 'RATE_LIMITED' | 'DAILY_QUOTA_EXHAUSTED'; retry_after_s?: number }
  | { type: 'cache_hit' }
  | { type: 'coalesced' };

export interface GovernorSnapshot {
  budget_remaining_today: number;
  daily_budget: number;
  used_this_minute: number;
  in_flight: number;
  circuit: 'closed' | 'open' | 'half_open';
  circuit_open_until?: string;
}

export interface Governor {
  /** Runs `task` under rate, concurrency, daily-budget and circuit control, retrying per policy. */
  schedule<T>(
    scope: GovernorScope,
    task: (attempt: number, signal: AbortSignal) => Promise<T>,
    onDecision?: (d: GovernorDecision) => void,
  ): Promise<T>;
  snapshot(scope: GovernorScope): Promise<GovernorSnapshot>;
}

/** Short-TTL read-through cache with request coalescing. Keys must include the tenant. */
export interface Cache {
  wrap<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    onDecision?: (d: GovernorDecision) => void,
  ): Promise<{ value: T; cached: boolean }>;
}

export const ZOHO_DAILY_LIMITS = {
  free: 1000,
  standard: 2000,
  professional: 5000,
  premium: 10000,
  enterprise: 10000,
} as const;

export type ZohoPlan = keyof typeof ZOHO_DAILY_LIMITS;

export function zohoRateProfile(plan: ZohoPlan = 'free', dailyShare = 0.5): RateProfile {
  return {
    perMinute: 80,
    concurrency: plan === 'free' ? 4 : 8,
    dailyLimit: ZOHO_DAILY_LIMITS[plan],
    dailyShare,
    queueTimeoutMs: 10_000,
    leaseMs: 30_000,
    maxRetries429: 3,
    maxRetries5xx: 2,
    minuteBlockOpenMs: 60_000,
    breakerThreshold: 5,
    breakerOpenMs: 30_000,
    requestTimeoutMs: 10_000,
  };
}
