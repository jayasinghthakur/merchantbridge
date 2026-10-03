# Runbook

Symptom -> diagnosis -> action for the failures we expect. Placeholders: `API` (API origin, the Hugging Face Space's
app URL), `SPACE` (the Space id `<owner>/<space>`). Hosting is the $0 stack of [ADR-0009](adr/0009-free-tier-stack.md)
([deploy.md](deploy.md)); Space variables and secrets are changed by the human in the Space settings.
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

```sql
-- organizations connected more than once (extra tenants, keys, refresh tokens; one governor budget)
select organization_id, count(*) from connections where status = 'active' group by 1 having count(*) > 1;
```

Governor keys in Redis (`packages/governor/src/keys.ts`) are per Zoho organization, shared by every tenant of it:
`gov:zoho:{dc}:{org}:circuit` (open circuit record), `:exhausted` (daily-quota flag), `:day:YYYY-MM-DD` (admitted
calls today), `:minute`, `:leases`, `:fails`, `:probe`. Demo sessions use `gov:demo:{session}:…`. Cache keys stay per
tenant (`zoho:{tenant}:{org}:…`). The governor numbers are fixed in `zohoRateProfile`
(`packages/core/src/governor.ts`); there is no per-tenant override, so "lower the limit" below means a code change
and a deploy.

## Zoho code 44: organization blocked (per-minute limit)

- **Symptoms:** agents get `RATE_LIMITED` with `retry_after_s` up to 60; trace shows `circuit_open` with reason 44;
  merchant may see "your account has been blocked" in the Zoho UI.
- **Diagnosis:** Zoho allows 100 requests/min per org, shared with the merchant's UI users and every other integration
  (including Zoho's own MCP if they run it). Our governor caps us at 80/min, so a 44 usually means **someone else** is
  also calling. Check our rate: `zcard gov:zoho:{dc}:{org}:minute` (all of our tenants of that org together); if it
  is well under 80, the excess is external. Block duration is undocumented (ADR-0005 assumes 60 s).
- **Action:** do nothing for 60 s; the circuit half-opens with one probe (it pauses every tenant of that
  organization, as Zoho's block does). Several tenants of one organization share the 80/min budget, so duplicate
  connects are not the cause; ask which other integrations poll Zoho, and if needed lower `perMinute` in
  `zohoRateProfile` (code change). Never clear the circuit key by hand during a live block; it extends the block.

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
  30 s; leases are shared by every tenant of the org. If external load is the cause, lower `concurrency` in
  `zohoRateProfile` (code change).

## RECONNECT_REQUIRED (`invalid_code` / `invalid_grant`) and the 20-refresh-token trap

- **Symptoms:** every live call returns `RECONNECT_REQUIRED`; `connections.status = 'needs_reconnect'`,
  `last_error_code` set.
- **Diagnosis:** the refresh token stopped working. Causes, most likely first:
  1. **Eviction:** Zoho keeps 20 refresh tokens per user (per client, per our research) and silently deletes the
     oldest when a 21st consent happens. Repeated local testing or reconnects with the **same** client evict
     production. This is why PROD and DEV use separate Zoho clients.
  2. The merchant revoked access (Zoho Accounts -> Sessions -> Connected Apps) or the Zoho user lost access.
  3. Wrong DC accounts server for refresh (would show `invalid_client` instead).

  Failed connects do not add to the eviction count: when anything fails after the code exchange, the callback revokes
  the refresh token it was just issued (log `revoked abandoned refresh token`, or `could not revoke abandoned refresh
token` when Zoho was unreachable, in which case that token lingers until Zoho evicts it).

- **Action:** the merchant reconnects at `WEB/connect`. In v1 that creates a **new tenant and a new key** (ADR-0008):
  the old key keeps answering `RECONNECT_REQUIRED`, so the merchant must put the new key into every agent host and
  then retire the old one with `POST /api/connection/disconnect` (see "Merchant wants to disconnect"). Then check who
  else consented with the PROD client recently; never use the PROD client locally.

## Zoho token-request throttle

- **Symptoms:** refresh fails with throttling errors, many tenants at once, after a deploy or Redis flush.
- **Diagnosis:** Zoho allows 10 access tokens per refresh token per 10 min (vendored) and, per our research, 10 token
  requests per client per 10 min. A cold Redis (cached access tokens lost) makes every tenant refresh at once; a broken
  single-flight lock multiplies refreshes.
- **Action:** confirm single-flight: at most one `zoho access token refreshed` log line per connection per ~55 min,
  and no bursts of `timed out waiting for zoho token refresh`. If Redis was flushed, refreshes queue behind the lock;
  let them drain (they happen lazily on the next call). Restarts do not lose tokens while Redis is intact; a Redis
  flush does.

## LLM provider rate limit or daily quota (playground)

- **Symptoms:** playground questions end with an `error` trace event: `RATE_LIMITED` "The AI model is busy right now;
  try again shortly." (with `retry_after_s` when the provider sent one), or `BUDGET_EXHAUSTED` "The demo has used its
  AI budget for now". Or the request itself gets HTTP 429 "Today's playground budget is used up" (MerchantBridge's own
  daily cap). `/tools` and `/mcp/demo` keep working: they need no model.
- **Diagnosis:** the API logs `playground run failed` with `provider`, `code` and `status`. On the $0 path the provider
  is Groq's free tier (ADR-0009), which limits requests and tokens per minute (about 30 requests/min) and per day (for
  `llama-3.3-70b-versatile` about 1,000 requests and 100K tokens, approximate). A 429 that clears within a minute is
  the per-minute limit (`RATE_LIMITED`); a 429 whose body mentions a daily (TPD/RPD) limit or a spent quota maps to
  `BUDGET_EXHAUSTED` and lasts until Groq's daily window resets. Each question resends the tool schemas (about 3.4K
  tokens) on every model turn, so the daily allowance covers only a handful of questions. The HTTP 429 instead is
  `MB_PLAYGROUND_DAILY_CAP` (default 300 questions per UTC day). Current usage and exact limits per model: the Groq
  console.
- **Action:** per-minute limits clear by themselves. For the daily quota: wait for the reset, or point the Space at
  another free OpenAI-compatible endpoint (Space variables `MB_LLM_BASE_URL`, `MB_PLAYGROUND_MODEL`, secret
  `MB_LLM_API_KEY`; e.g. Gemini's OpenAI-compatible endpoint or an OpenRouter free model), or a smaller Groq model with
  a larger daily allowance (check the console), then restart the Space. Lower `MB_PLAYGROUND_DAILY_CAP` so visitors see
  MerchantBridge's own "budget used up" message before Groq's. There is **no replay fallback** yet: the page points
  visitors to the Tools explorer, and reviewers can still use `claude mcp add … /mcp/demo` with their own Claude.
  Emergency stop: Space variable `MB_PLAYGROUND_ENABLED=false` (human only); the page then shows "Live agent paused".
- **Paid provider instead** (`MB_LLM_PROVIDER=anthropic`): `BUDGET_EXHAUSTED` means the Anthropic workspace hit its
  spend cap; raise the cap in the Anthropic console or switch back to the free provider.

## LLM key rejected or rotated (Groq)

- **Symptoms:** every playground question ends with a generic `INTERNAL` error ("The agent hit an unexpected
  error"); the API logs `LLM provider rejected the key` with `status` 401 or 403 (the key itself is never logged).
  `pnpm evals` stops with "rejected the API key".
- **Diagnosis:** the Groq key was revoked, mistyped, or belongs to another account; or `MB_LLM_BASE_URL` points at a
  provider the key is not for.
- **Action (rotation, also after a suspected leak):** create a new key in the Groq console; replace the Space secret
  `MB_LLM_API_KEY` (and your local shell's copy for evals); restart the Space; run one playground card; then delete the
  old key in the console. Never paste the key into issues, chats or variables (only the Space **secret**).

## Upstash command budget

- **Symptoms:** Redis errors in logs, tool calls failing, `/health/ready` answering 503 with `checks.kv: false`, or the
  Upstash console showing the command count near the free tier's 500K/month.
- **Diagnosis:** each governed call costs several commands (window ZSET, lease ZSET, day INCR, cache GET/SET). Demo
  traffic and uptime pings add up.
- **Action:** read the command count in the Upstash console (`/health/ready` does not expose it, and each probe costs
  one PING, coalesced to one per 2 s); ping `/health/live` instead of `/health/ready` from the uptime monitor, extend
  the item cache TTL, or upgrade the plan. Last resort (documented cut, PLAN §6): unset `REDIS_URL` for in-memory Kv on
  one machine; production refuses to boot without it, so this also needs a code change.

## Neon cold start

- **Symptoms:** first request after idle takes seconds; `/health/ready` slow or 503 with `checks.store: false`; first
  usage-event insert fails then succeeds.
- **Diagnosis:** Neon free tier suspends compute when idle.
- **Action:** usage events are batched (every 2 s or 100 events) and never fail tool calls (write errors are logged,
  not surfaced). The keep-warm workflow pings `/health/live`, which does not touch Neon, so Neon still sleeps; during
  demo hours an uptime check on `/health/ready` keeps compute warm at the cost of Upstash commands (see above); raise
  the DB connect timeout if needed.

## API down, or the Space asleep

- **Symptoms:** the site loads but the playground, explorer and `/mcp/demo` fail or hang; MCP clients time out on the
  first call; `keep-warm.yml` fails ("did not answer {"ok":true}").
- **Diagnosis:** open the Space page (`https://huggingface.co/spaces/SPACE`) and read its status and **Logs**.
  - **Sleeping / paused:** a free Space sleeps after a period without traffic (about 48 h). The keep-warm workflow
    prevents that only while GitHub runs it: GitHub disables scheduled workflows in a public repository after 60 days
    without repository activity (Actions tab shows it disabled).
  - **Building / restarting:** a deploy just happened (every push that touches the API rebuilds the image and restarts
    the container) or Hugging Face restarted it; open SSE streams are cut.
  - **Build error:** the build log shows it; the CI `docker` job builds the same Dockerfile, and the deploy workflow
    builds before pushing, so this is usually a Hugging Face-side problem: rebuild from the Space settings.
  - **Runtime error / crash loop:** the container log shows env validation ("Invalid environment configuration",
    "Production requires: DATABASE_URL, REDIS_URL", or "MB_DEV_FAKE_ZOHO=true is a local development mode and is
    refused": unset that variable, it must never be set in production). 403s on every non-health route mean a host
    missing from `MB_PUBLIC_API_URL` / `MB_ALLOWED_HOSTS` (the Host allow-list applies everywhere except `/health/*`).
- **Action:** a sleeping Space wakes on the next request: open `API/health/live` or run **Keep warm** from the Actions
  tab (it retries for ~10 minutes); re-enable the keep-warm workflow if GitHub disabled it. For config errors fix the
  Space variable or secret and restart the Space; for code, fix on `main` (the deploy workflow redeploys). If the Space
  status stays "Starting" while the log shows `merchantbridge api listening`, check `PORT` = `app_port` = 8787 (see
  [deploy.md](deploy.md#5-deploy-to-the-space-github-actions)). On the optional Fly host the equivalent checks are
  `fly status`, `fly logs` and `fly machine start`.

## HTTP 400 from `/mcp/demo` or `/api/explorer/call`

- **Symptoms:** a demo client gets `400 {"error":{"code":"BAD_REQUEST","message":"X-MB-Faults …"}}`, or the explorer
  answers 400 "Unknown field(s) …".
- **Diagnosis:** `/mcp/demo` rejects `X-MB-Faults` with an unknown fault name, or sent without a valid client
  `X-MB-Session` (8-64 chars of `A-Za-z0-9_-`, not starting with `ip-`); faults never apply to the shared per-IP
  session. An empty `X-MB-Faults` is fine (no faults). `POST /api/explorer/call` takes only `tool`, `args`,
  `session_id` and `faults`; tool arguments go in `args`, and any other key is a 400.
- **Action:** fix the client; the message names the problem and the valid values. The response header
  `X-MB-Applied-Faults` shows which faults a demo request actually ran with.

## Merchant wants to disconnect

- **Request:** "turn MerchantBridge off", "remove access", an offboarding, or a suspected key leak.
- **Action (merchant, or the FDE with the merchant's key):**
  ```sh
  curl -X POST API/api/connection/disconnect -H "Authorization: Bearer mb_live_…"
  ```
  `200 {"revoked_locally":true,"revoked_at_zoho":true,"had_connection":true}` means done: the Zoho refresh token is
  revoked at Zoho, the cached access token dropped, the connection marked `revoked` and the key revoked (HTTP 401 from
  now on). Make sure every agent host that used the key is updated or removed.
- **`revoked_at_zoho: false`:** Zoho was unreachable or the stored token could not be decrypted (log line
  `zoho revoke failed; revoking locally only`). Local access is already off. Ask the merchant to also remove
  MerchantBridge under Zoho Accounts -> Connected Apps so the refresh token dies at Zoho.
- **Key lost, merchant still wants out:** there is no admin endpoint yet. The merchant removes MerchantBridge in Zoho
  Accounts (tool calls then return `RECONNECT_REQUIRED`); an operator can revoke locally in Postgres:
  `update api_keys set revoked_at = now() where tenant_id = $1 and revoked_at is null;` and
  `update connections set status = 'revoked', updated_at = now() where tenant_id = $1;`. Find the tenant with
  `select tenant_id, organization_name, status from connections where organization_id = $2;`.
- **Several tenants for one organization** (ADR-0008): disconnect each key, or revoke each tenant as above.
- **Data:** nothing to delete in Zoho; MerchantBridge stores no Zoho records. Usage events (masked) age out after 30
  days.

## Per-IP limits not applied (spoofed client IP)

- **Symptoms:** one host exceeds 60 `/mcp/demo` requests per minute without 429s; probe (a) in
  [deploy.md](deploy.md#8-verify-production) §8 shows only `200`s on two runs. The opposite failure, probe (b): a
  visitor on another network gets 429 right after someone else used up "their" bucket.
- **Diagnosis:** on the Hugging Face Space the caller IP is the right-most `X-Forwarded-For` entry
  (`MB_CLIENT_IP_SOURCE=xff-last`, UNVERIFIED until the probes pass). Only `200`s means a client-sent value ends up
  right-most (spoofable); a shared 429 means the right-most entry is an internal proxy address shared by everyone.
  (On the optional Fly host the source is `Fly-Client-IP` and the same probe uses that header.)
- **Action:** spoofable: set the Space variable `MB_CLIENT_IP_SOURCE=socket` and restart (all traffic then shares one
  bucket: strict but safe). Shared bucket: safe as is, but reviewers share 60 requests per minute; record it and
  revisit with the platform's documented headers. Either way, record the finding in `docs/STATUS.md`.
