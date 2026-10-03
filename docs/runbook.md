# Runbook

Symptom -> diagnosis -> action for the failures we expect. Placeholders: `API` (API origin), `$APP` (Fly app name).
Never paste tokens, refresh tokens or customer PII into tickets or chats; usage events are already masked.

Useful queries (Postgres, `usage_events`, one row per tool call):

```sql
-- error mix in the last hour for one tenant
select error_code, count(*) from usage_events
where tenant_id = $1 and ts > now() - interval '1 hour' group by 1 order by 2 desc;
-- slowest tools today
select tool, percentile_cont(0.95) within group (order by duration_ms) p95, sum(retries) retries
from usage_events where ts > date_trunc('day', now()) group by 1 order by 2 desc;
```

Governor keys in Redis (`packages/governor/src/keys.ts`): `gov:zoho:{tenant}:{org}:circuit` (open circuit record),
`:exhausted` (daily-quota flag), `:day:YYYY-MM-DD` (admitted calls today), `:minute`, `:leases`.

## Zoho code 44: organization blocked (per-minute limit)

- **Symptoms:** agents get `RATE_LIMITED` with `retry_after_s` up to 60; trace shows `circuit_open` with reason 44;
  merchant may see "your account has been blocked" in the Zoho UI.
- **Diagnosis:** Zoho allows 100 requests/min per org, shared with the merchant's UI users and every other integration
  (including Zoho's own MCP if they run it). Our governor caps us at 80/min, so a 44 usually means **someone else** is
  also calling. Check our rate: `zcard gov:zoho:{tenant}:{org}:minute`; if it is well under 80, the excess is
  external. Block duration is undocumented (ADR-0005 assumes 60 s).
- **Action:** do nothing for 60 s; the circuit half-opens with one probe. If 44 recurs, lower the tenant's
  `perMinute` (e.g. 50) and ask the merchant which other integrations poll Zoho. Never clear the circuit key by hand
  during a live block; it extends the block.

## Zoho code 45: daily quota exhausted

- **Symptoms:** `DAILY_QUOTA_EXHAUSTED` on every call; `budget_remaining_today` 0; `gov:…:exhausted` present.
- **Diagnosis:** either our 50% daily share is used (our counter `gov:…:day:<UTC date>`), or Zoho itself returned 45
  because the org's whole plan quota (free 1000/day) is gone, shared with other integrations.
- **Action:** nothing resets it before midnight (we assume UTC; Zoho's reset time is undocumented). Tell the merchant
  the time it clears. If our share ran out, find the hungry tool with the error-mix query (sales-order scans cost 3
  calls each) and consider raising the share for paid plans. If Zoho returned 45 while our counter was low, the merchant's
  other integrations are consuming the quota.

## Zoho code 1070: too many concurrent requests

- **Symptoms:** `retried` decisions with reason 1070, occasional `RATE_LIMITED`, higher p95.
- **Diagnosis:** Zoho allows 5 concurrent calls (free) / 10 (paid, soft). We lease 4 / 8. Persistent 1070s mean
  external concurrency, or our lease count is wrong for the plan (`connections.plan` null maps to free).
- **Action:** confirm the plan via `zoho_get_connection_status`; check `zcard gov:…:leases`; stale leases expire after
  30 s. If external load is the cause, lower the tenant's concurrency.

## RECONNECT_REQUIRED (`invalid_code` / `invalid_grant`) and the 20-refresh-token trap

- **Symptoms:** every live call returns `RECONNECT_REQUIRED`; `connections.status = 'needs_reconnect'`,
  `last_error_code` set.
- **Diagnosis:** the refresh token stopped working. Causes, most likely first:
  1. **Eviction:** Zoho keeps 20 refresh tokens per user (per client, per our research) and silently deletes the
     oldest when a 21st consent happens. Repeated local testing or reconnects with the **same** client evict
     production. This is why PROD and DEV use separate Zoho clients.
  2. The merchant revoked access (Zoho Accounts -> Sessions -> Connected Apps) or the Zoho user lost access.
  3. Wrong DC accounts server for refresh (would show `invalid_client` instead).
- **Action:** the merchant reconnects at `WEB/connect` (same tenant, keys keep working). Then check who else consented
  with the PROD client recently; never use the PROD client locally.

## Zoho token-request throttle

- **Symptoms:** refresh fails with throttling errors, many tenants at once, after a deploy or Redis flush.
- **Diagnosis:** Zoho allows 10 access tokens per refresh token per 10 min (vendored) and, per our research, 10 token
  requests per client per 10 min. A cold Redis (cached access tokens lost) makes every tenant refresh at once; a broken
  single-flight lock multiplies refreshes.
- **Action:** confirm single-flight: only one `refresh` log line per tenant per hour. If Redis was flushed, refreshes
  will queue behind the lock; let them drain (they are retried lazily on the next call). Do not restart in a loop:
  each restart does not lose tokens if Redis is intact, but a Redis flush does.

## LLM workspace budget exhausted (playground)

- **Symptoms:** playground shows the "replay" badge; trace shows `error` `BUDGET_EXHAUSTED` or `RATE_LIMITED`;
  `/mcp/demo` still works.
- **Diagnosis:** the dedicated Anthropic workspace hit its spend cap ($15) or rate limit, or the daily global cap
  (`MB_PLAYGROUND_DAILY_CAP`, 300) was reached.
- **Action:** replay is the designed fallback; reviewers still see a full recorded trace and can use
  `claude mcp add … /mcp/demo` with their own Claude. To restore live answers, raise the cap in the Anthropic console
  or wait for the window. Emergency stop: set `MB_PLAYGROUND_ENABLED=false` (`fly secrets set`, human only).

## Upstash command budget

- **Symptoms:** Redis errors in logs, governor falls back to rejecting, `/health/ready` reports redis degraded or the
  command count near the free tier's 500K/month.
- **Diagnosis:** each governed call costs several commands (window ZSET, lease ZSET, day INCR, cache GET/SET). Demo
  traffic and uptime pings add up.
- **Action:** check the command count exposed by `/health/ready`; reduce uptime ping frequency, extend item cache TTL,
  or upgrade the plan. Last resort (documented cut, PLAN §6): in-memory Kv on a single machine.

## Neon cold start

- **Symptoms:** first request after idle takes seconds; `/health/ready` slow or `db: timeout`; first usage-event
  insert fails then succeeds.
- **Diagnosis:** Neon free tier suspends compute when idle.
- **Action:** usage events are batched and must not fail tool calls (emit errors are logged, not surfaced). Keep the
  uptime monitor on `/health/ready` so compute stays warm during demo hours; raise the DB connect timeout if needed.

## Fly machine down

- **Symptoms:** site loads but playground, explorer and `/mcp/demo` fail; uptime monitor alerts.
- **Diagnosis:** `fly status -a $APP`, `fly machine list -a $APP`, `fly logs -a $APP`. Look for crash loops on env
  validation ("Invalid environment configuration", "Production requires: DATABASE_URL, REDIS_URL") and for health
  checks failing with `Invalid Host` 403s (the MCP Host allow-list applies to every route; the Host header Fly's checks
  send is unverified).
- **Action:** fix config and redeploy via CI; `fly machine start <id> -a $APP` for a stopped machine; keep
  `min_machines_running = 1`. If the Host check rejects health checks, add that host to `MB_ALLOWED_HOSTS`.
