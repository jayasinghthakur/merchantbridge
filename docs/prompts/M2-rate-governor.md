# M2 — Rate governor, retries, circuit breaker, cache

Read SPEC "Rate limits, errors and resilience". Tests FIRST (fake timers + MSW returning 429s), then implementation.

Build in `packages/ratelimit`, all keyed by `connector:orgId` in Redis:
- Token bucket: 80/min (configurable per connector profile).
- Concurrency semaphore: 4 (free plan) / 8 (paid), with lease timeout so a crashed worker can't hold a slot.
- Daily budget: share (default 50%) of plan limit {free:1000, standard:2000, professional:5000, premium:10000, enterprise:10000};
  resets at org-local midnight; Zoho code 45 marks budget exhausted until reset.
- Queue up to 10 s for a token; beyond that return RATE_LIMITED with retry_after_s.
- 429 handling: honor Retry-After; else full-jitter backoff 0.5/1/2 s, max 3 tries; code 45 never retried; code 44 opens
  the circuit for 60 s (org is blocked upstream).
- 5xx/timeouts: 2 retries for GET; 10 s timeout.
- Circuit breaker: 5 consecutive failures → open 30 s → half-open probe.
- Cache (`packages/ratelimit/cache` or separate): Redis, keys include tenant + org; TTL item/stock 60 s, orgs 300 s,
  orders/invoices 0. Request coalescing for identical in-flight calls.
- Every decision emits a structured event (queued, cache_hit, retried, rejected) for telemetry.

Wire it into the Zoho client so NO request bypasses it (add a lint rule or test that greps for raw fetch to zohoapis).
Done when: tests prove codes 44, 45, 1070, 5xx, and concurrency are handled exactly as specified.
