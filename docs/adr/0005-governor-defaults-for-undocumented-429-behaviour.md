# ADR-0005: Governor defaults for undocumented 429 behaviour

## Context

Zoho documents per-organization limits: 100 requests/min (HTTP 429, code 44, "organization has been blocked"), a
daily quota by plan (free 1000, standard 2000, professional 5000, premium/enterprise 10000; code 45) and concurrency
(free 5, paid 10 soft; code 1070) [`docs/vendor/zoho/accounts/introduction.txt`]. It does **not** document: a
`Retry-After` header, how long a code-44 block lasts, when or in which timezone the daily counter resets, or whether
rejected calls count. The limits are shared by every agent and integration the merchant runs, and by humans in the
Zoho UI (the account-level code-44 message).

## Decision

One governor per Zoho organization, `zoho:{dc}:{org}` (shared by every tenant of that org since the ADR-0008
amendment; originally `zoho:{tenant}:{org}`), or `demo:{session}`, backed by Redis, defaults from
`zohoRateProfile()` in `packages/core/src/governor.ts`:

| Setting       | Default                                                                   | Reasoning                                                                  |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| per-minute    | 80                                                                        | 20% headroom under 100 for UI users and other integrations                 |
| concurrency   | 4 free / 8 paid, 30 s leases                                              | 1-2 below Zoho's 5/10; leases expire if a worker dies                      |
| daily share   | 50% of plan limit                                                         | quota is shared; we must not starve the merchant's other tools             |
| daily reset   | UTC midnight                                                              | unknown upstream; conservative counter, corrected by a code-45 observation |
| queue wait    | max 10 s, then `RATE_LIMITED` + `retry_after_s`                           | agents get an answer, not a hang                                           |
| code 44       | open circuit 60 s, no retries                                             | retrying during a block may extend it                                      |
| code 45       | `DAILY_QUOTA_EXHAUSTED`, never retried; mark budget exhausted until reset |                                                                            |
| code 1070     | up to 3 retries, full jitter                                              | transient by nature                                                        |
| 5xx / timeout | 2 retries, 10 s per attempt                                               | GETs are idempotent                                                        |
| breaker       | 5 consecutive failures -> open 30 s -> half-open probe                    |                                                                            |
| `Retry-After` | honoured if present, else the defaults above                              |                                                                            |

Plan comes from `GET /organizations` `plan_name`; unknown maps to `free` (smallest budget). Cache (items/stock 60 s,
organization 300 s) and request coalescing sit in front of the governor.

## Consequences

- Several agents on one merchant stay under 80/min combined (tested with two parallel agents and fake timers).
- A merchant on a paid plan runs below their true capacity until smoke/real traffic justifies raising the share; the
  share is a per-tenant setting.
- If Zoho's real reset is org-local midnight, our counter is wrong by the timezone offset; a code 45 response
  overrides the counter, so the error is bounded to one wasted call.
- Every decision (admitted, queued, retried, circuit_open, rejected, cache_hit, coalesced) is emitted to the usage
  event and the playground trace.

## Status

Accepted (assumptions). Revisit after ADR-0001 P-23 and the first week of real traffic.
