# MerchantBridge — end-to-end build plan

Merges the starter kit (CLAUDE.md + docs/prompts M0–M6) with the pasted Python/FastAPI plan, corrected against
research done 2026-10-03 (Razorpay Agent Studio, Zoho Inventory API docs + OpenAPI, MCP spec 2026-07-28, hosting).
Facts marked **UNVERIFIED** must be probed by `scripts/smoke.ts` before code depends on them.

---

## 1. Positioning

> **A private Agent Studio-style connector for Zoho Inventory** — one-time OAuth, available to all of the merchant's
> agents, scoped to the organization, read-only by construction, with a full audit trail.

Why this framing wins:

- "Private connector" is Razorpay's own product term. Their 30 Mar 2026 guardrails post says connectors that need
  external accounts get a "one-time OAuth connection… available to all the merchant's agents". Enterprises get "private
  connectors scoped exclusively to the organization", and "new connectors typically take about one week".
- Agent Studio is built on the **Claude Agent SDK**, so a remote **Streamable HTTP MCP server** is the natural plug-in
  surface. That is an inference: Razorpay has published no connector contract.
- No public Razorpay page lists Zoho Inventory as a connector.
- Zoho shipped its own read+write Inventory MCP in July 2026. The README and an ADR must answer "why not Zoho's MCP?":
  least-privilege READ-only scopes, Razorpay payment-reference reconciliation, a per-org governor protecting the
  merchant's shared daily quota, and an audit trail.
- Site says "Agent Studio-style", has a not-affiliated footer, and uses **no** Razorpay logos or trade dress.

**Principle → feature table (README + site):** review-first → read-only by construction · verified first-party data →
`as_of` + `zoho_url` on every result · validation layer → Zod, scope checks, PII masking · audit trail → one
`usage_event` per call · data stays put → no mirroring, short-TTL cache only.

### The 3-minute reviewer journey (no login)

1. Open the live site. The hero shows the positioning line and a single **Try it** button.
2. In **/playground**, click a scenario card. A live LLM agent (Llama 3.3 70B on Groq's free tier by default,
   ADR-0009) calls the real MCP server. A trace pane shows each tool, its args, latency, cache hit, governor decision,
   budget left and error code.
3. Flip the **"Zoho 429 (code 44)"** toggle and see the backoff, then a structured `RATE_LIMITED` result with
   `retry_after_s`. Flip **"expired token"** to see refresh, then one retry.
4. Click the refusal card ("cancel this order") and see zero tool calls and a polite refusal.
5. Copy `claude mcp add --transport http mb-demo https://<api>/mcp/demo` into their own Claude. The same URL works as
   a Claude.ai custom connector with "No sign-in".
6. The **/docs** page shows CAN / CANNOT, the tool table and a 2-minute video of the real Zoho OAuth.

---

## 2. Decisions (both plans reconciled)

| Topic                   | Decision                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Language                | **TypeScript end to end** (Node 22, strict) + one CI-run `examples/python/` Agent SDK client                                                                                                                                                                                                           | Kit, MCP TS SDK v2, Anthropic TS `mcpTools()`+`toolRunner`, Next.js → one language, one test runner, one CI. JD says "Python and one of Java/Go/TS".         |
| MCP SDK                 | **v2 split packages, exact-pinned**: `@modelcontextprotocol/server`, `client`, `fastify`, `node` (2.x), `zod/v4`. ADR records v1 (`@modelcontextprotocol/sdk` 1.32) as fallback                                                                                                                        | Kit's `@modelcontextprotocol/sdk` is the v1 maintenance line. v2 implements spec 2026-07-28 (stateless).                                                     |
| Apps                    | **`apps/api`** (Fastify: `/mcp`, `/mcp/demo`, `/oauth/zoho/*`, `/api/playground` SSE, `/api/explorer`, `/health/*`) + **`apps/web`** (Next.js + Tailwind)                                                                                                                                              | Stateless MCP mounts inside one service. Replaces kit's gateway / mcp-server / dashboard split.                                                              |
| Packages                | `core` (defineConnector, defineTool, ToolRuntime, envelope, errors) · `zoho-inventory` (client, mappers, tools, FakeZoho) · `governor` · `auth` · `db`                                                                                                                                                 | Framework-free, so a Vercel-route fallback is about an hour of work.                                                                                         |
| Hosting                 | **$0, no card (ADR-0009):** **Hugging Face Docker Space**, CPU basic (api; `deploy/hf-space/`, `deploy-hf-space.yml`, keep-warm ping every 6 h) + **Vercel Hobby** (web) + **Neon** free (Postgres) + **Upstash** free (Redis). Fly.io (`fly.toml`, always-on) is kept as an optional paid alternative | Owner requirement: everything free. Trade-offs: cold start after ~48 h idle, restart on deploy, Hobby is non-commercial. Was Fly.io, about $2–5/month.       |
| LLM (playground, evals) | **OpenAI-compatible provider, default Groq free tier `llama-3.3-70b-versatile`** (`MB_LLM_PROVIDER`/`MB_LLM_BASE_URL`/`MB_LLM_API_KEY`); Anthropic (`claude-haiku-4-5`, evals `claude-sonnet-5-5`) optional and paid (ADR-0009)                                                                        | $0 requirement; provider-agnostic engine; only demo data reaches the model. Was Anthropic with a $15 spend cap.                                              |
| Redis                   | **Keep** (Upstash via ioredis, plain INCR/EXPIRE, SET NX PX, ZSET leases; no Lua) behind a `Kv` interface with an in-memory implementation for tests                                                                                                                                                   | Several agents share one org's 100/min limit; token refresh must be single-flight (Zoho allows 10 token requests per client per 10 min); per-IP demo limits. |
| Demo                    | **FakeZoho = a fake upstream, not a fake app**: a fetch transport speaking Zoho's wire format (code≠0 on HTTP 200, `page_context`, 401, 429 codes 44/45/1070, 5xx, malformed JSON)                                                                                                                     | The real client, mappers, governor, ToolRuntime and MCP server all run in the public demo. One contract suite proves both backends.                          |
| Auth legs               | (1) Merchant→Zoho: real OAuth 2.0 authorization code. (2) Agent→MerchantBridge: hashed per-tenant bearer key `mb_live_…`, shown once. Zoho tokens never pass through (MCP spec forbids it). OAuth 2.1 on the MCP leg is Tier 3.                                                                        | Works with Agent SDK headers, `claude mcp add --header`, and the Messages API `authorization_token`.                                                         |
| Errors                  | Tool errors are **`isError: true` results** carrying `{code,message,retryable,retry_after_s?,hint}`. JSON-RPC errors only for unknown tool or malformed request.                                                                                                                                       | MCP spec; lets the model self-correct.                                                                                                                       |
| Output                  | `outputSchema` + `structuredContent` + a text copy on every tool; **≤10K tokens** per result (enforced by test)                                                                                                                                                                                        | Claude Code and the Agent SDK warn at 10K and swap results above 25K for a file reference.                                                                   |
| Observability           | Tier 1: Pino + `request_id` + `usage_events` (audit). Tier 2: `prom-client /metrics`, `/activity` page. **No OpenTelemetry.**                                                                                                                                                                          | Real signals only, no fake metrics.                                                                                                                          |
| Cut from kit            | Turborepo, Docker Compose, billing/GST page, 30-day fake usage seed, per-minute alerts, refresh scheduler (lazy refresh instead), Recharts dashboard pages, `zoho_search`, conflict checks (Tier 3)                                                                                                    | Scope; "no fake metrics".                                                                                                                                    |
| Cut from pasted plan    | Python/FastAPI/SQLAlchemy/Vite SPA, parallel REST resource API (`/api/v1/sales-orders`…), OTel, the 47-section master prompt                                                                                                                                                                           | One surface (MCP) to secure and test; short milestone prompts work better.                                                                                   |

---

## 3. Architecture

```
 Reviewer browser ──► apps/web (Vercel, Next.js)
                          │  SSE / JSON
                          ▼
 Claude.ai / Claude Code / Agent SDK / Messages API mcp_toolset
          │ POST /mcp (Bearer mb_live_)   │ POST /mcp/demo (public, demo tenant only)
          ▼                               ▼
 ┌─────────────────── apps/api (Hugging Face Space, Fastify) ─────────────────┐
 │ /oauth/zoho/*   /api/playground (LLM tool loop ⇄ in-process MCP Client)    │
 │ MCP server (createMcpHandler, stateless) ─► ToolRuntime (Zod, tenant ctx,  │
 │   envelope, isError, allow-lists, untrusted_text, PII mask, 10K cap,       │
 │   exactly one usage_event)                                                 │
 │        ─► zoho-inventory tools ─► ZohoClient (GET only) ─► Governor ─┐     │
 └──────────────────────────────────────────────────────────────────────┼─────┘
          Neon (tenants, api_keys#, connections🔒, usage_events)  Upstash (governor, token cache, locks, IP limits)
                                                                         ▼
                                         live tenant: zohoapis.{dc}   demo tenant: FakeZoho
```

**Rules (go into CLAUDE.md):**

1. MCP is a thin door. Tools call ToolRuntime and the connector, never `fetch`.
2. Every Zoho call goes ZohoClient → Governor. A test fails if anything else references `zohoapis`.
3. Read-only is enforced server-side: GET-only client, `*.READ` scopes only, no write tools. Annotations are only hints.
4. Public routes (`/mcp/demo`, playground) are bound to the demo tenant and FakeZoho and can never load real credentials.
5. Every DB row and cache key includes `tenant_id`.
6. Zoho params and shapes come only from `docs/vendor/zoho/` (official OpenAPI). Anything else is tagged UNVERIFIED and
   gets a probe in `scripts/smoke.ts`.

---

## 4. Tool surface

Server name `merchantbridge`, so agents see `mcp__merchantbridge__zoho_*` and Agent SDK configs use
`allowedTools: ['mcp__merchantbridge__*']`. `tools/list` order is deterministic. Lists take `limit` (default 20,
max 100) and an opaque `cursor`. Envelope:
`{ data, page:{next_cursor,has_more}, meta:{organization_id,as_of,cached,zoho_url,budget_remaining_today} }`.
Money is returned as `{amount_minor, currency}`. Free text is wrapped in `untrusted_text`. Email and phone are masked.

| Tier | Tool                             | Zoho call                                                                                                                             |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `zoho_get_connection_status`     | `/organizations/{id}` + governor state (DC, plan, scopes, budget, circuit, token health)                                              |
| 1    | `zoho_search_items`              | `/items` search_text, sku/name filters, `Status.Lowstock`, location                                                                   |
| 1    | `zoho_get_item`                  | `/items/{id}` or exact SKU; stock per location, reorder level                                                                         |
| 1    | `zoho_list_sales_orders`         | `/salesorders`. Filters only if smoke-verified (**UNVERIFIED**); otherwise a documented fallback                                      |
| 1    | `zoho_get_sales_order`           | `/salesorders/{id}`; line items, packages, tracking and invoices embedded in one call                                                 |
| 1    | `zoho_search_customers`          | `/contacts` name/company/email/phone `_contains`, search_text                                                                         |
| 1    | `zoho_list_invoices`             | `/invoices` status, customer_id, due_date, reference_number                                                                           |
| 1    | `zoho_get_invoice`               | `/invoices/{id}` balance, due date, payment_refs                                                                                      |
| 1    | `zoho_find_by_payment_reference` | `/customerpayments?reference_number_contains=` then `/invoices?reference_number=` (exact `pay_`/`order_`/`rfnd_`)                     |
| 2    | `zoho_check_stock`               | **Built.** `/itemdetails?item_ids=` (≤25 ids) or ≤5 exact SKUs (one cached `/items?sku=` lookup each); exactly one of the two inputs. |
| 2    | `zoho_list_shipments`            | **Not built.** Was: `/packages` filter_by `Status.Shipped`/`Delivered`, shipment dates; detail via `/shipmentorders/{id}`             |

That is 9 tools in Tier 1 and 11 planned in total. **Built (2026-10-03): 10** = the 9 Tier-1 tools plus
`zoho_check_stock` (see `docs/mcp-tools.json`). `zoho_list_shipments` was not built: shipments, carriers and tracking
come from `zoho_get_sales_order` (embedded in `GET /salesorders/{id}`) and `zoho_find_by_payment_reference`. (The
judging step's "10 / 12" counts did not match its own list, so this plan uses the list.) Request **all 8 scopes on the first consent**, because re-consents burn one of the 20 refresh
tokens Zoho allows per user per client:
`ZohoInventory.settings.READ, items.READ, salesorders.READ, invoices.READ, contacts.READ, packages.READ,
shipmentorders.READ, customerpayments.READ`.

Sales-order search fallback chain, documented in CAN/CANNOT (built in v1: only step 4; see ADR-0006):

1. Smoke-verified `/salesorders` filters.
2. Contacts → `customer_id` → `/items/transactions/salesorders` or `/invoices`.
3. `/packages salesorder_number_contains`, which only finds orders that already have a package.
4. A bounded scan of 3 pages × 200.

---

## 5. Live site + demo

**Pages (apps/web):**

- `/`: hero, journey, and the principle → feature table.
- `/playground`: 5 scenario cards plus free text, trace pane, fault toggles.
- `/tools`: an explorer showing the schema and the raw JSON-RPC exchange via `/api/explorer`.
- `/connect`: invite-code gated. DC picker → Zoho OAuth → pick an org → `mb_live_` key shown once, with revoke.
- `/docs`: CAN/CANNOT, configs for Claude Code / Agent SDK / Messages API / Claude.ai, and the video.
- Tier 2: `/activity` (real `usage_events` only) and `/evals` (published pass rates).

Every page has loading, empty and error states, works at 390px, and supports light and dark. The **DEMO DATA** badge
is always visible.

**Demo data, "Chai & Co (DEMO)":** about 40 items across 2 locations, 25 sales orders with tracking, 15 invoices,
10 payments with `pay_DEMO…` refs and UTRs, and 12 customers. One customer has cancellations and returns. One item
note contains a **prompt injection**, which must stay inside `untrusted_text`.

**Scenario cards**, modeled on Razorpay's launch agents (each card is also an eval):

1. **Dispute Responder**: "Build an evidence pack for pay_DEMO8xK2." Finds payment → invoice → SO → shipment and tracking.
2. **COD Confirmation**: "Is CHAI-250 in stock in Bengaluru, and at what price?"
3. **RTO Shield**: "Has this customer cancelled or returned orders before?"
4. **Settlement Insights**: "Which invoices are unpaid and due this week, with their Razorpay refs?"
5. **Refusal**: "Cancel SO-00012." Zero tool calls; explains read-only.

**Playground engine:** `/api/playground` on the API host streams SSE. The pipeline is an in-process MCP `Client`
(`StreamableHTTPClientTransport({fetch: handler.fetch})`) → an agent loop (max 6 iterations, `tool_choice: auto`).
Since ADR-0009 the default loop is OpenAI-compatible Chat Completions against Groq's free tier
(`llama-3.3-70b-versatile`); the original Anthropic loop (`mcpTools()` → `client.beta.messages.toolRunner`,
`claude-haiku-4-5`, evals also on `claude-sonnet-5-5`) remains as the optional paid provider. The playground
therefore exercises exactly what external hosts see.

**Cost and abuse protection:**

- **$0 model budget** (ADR-0009): Groq's free tier, so its rate limits (about 30 requests/min; about 100K tokens per
  day for the 70B model, approximate) replace the original Anthropic **workspace with a $15 spend cap**.
- Cloudflare Turnstile on the first message.
- 10 questions per 10 min per IP and 300 per day globally.
- Input capped at 500 chars, `max_tokens` 1024, prompt caching on.
- A `PLAYGROUND_ENABLED` kill switch. When the cap or a 429 hits, the playground falls back to a recorded transcript
  badged "replay".
- Fault toggles and governor buckets are per session (`demo:{session}`), so one reviewer can't break another's demo.
- `/mcp/demo` allows 60/min per IP. Anthropic's published egress IP range gets its own larger bucket, because all
  Claude.ai and Messages-API traffic comes from a few IPs.

**SSE hygiene:** send `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`; keep compression off that
route; send a `:` heartbeat every 15 s; set a CORS allowlist for the Vercel production and preview domains.

**Deploy:** CD via GitHub Actions (`deploy-hf-space.yml` assembles and force-pushes the Hugging Face Space with
`HF_TOKEN`; `deploy-api.yml` with `FLY_API_TOKEN` is the optional Fly path; migrations run by hand) plus the Vercel
Git integration. Mount with
`createMcpFastifyApp({host:'0.0.0.0', allowedHosts:[api host]})`; keep `legacy: 'stateless'`, the default, so
Claude.ai and 2025-era clients work. Add an uptime monitor. Watch Upstash's free 500K commands per month: expose the
command count in `/health/ready`.

---

## 6. Milestones

Each milestone has a done-when check and maps to `docs/prompts/M*.md`, which get rewritten.

### Tier 1: must ship (≈3–4 focused days; this is the submission)

Build status as of 2026-10-03 is noted under each milestone ("code" = built and tested locally on FakeZoho;
anything needing prod, real Zoho or a real model is still open). Details: `docs/STATUS.md`.

**M0 Foundation + context (½ day)**

- `git init` and a GitHub repo.
- Rewrite CLAUDE.md (≤120 lines, corrections in §9) plus nested CLAUDE.md files in `packages/zoho-inventory` and
  `apps/web`. New M0–M8 prompts.
- Vendor Zoho `openapi-all.zip` into `docs/vendor/zoho/`.
- pnpm workspace skeleton; CI (lint, typecheck, test, build, gitleaks) and CD.
- `scripts/smoke.ts`; hello-world deploys of both apps.
- _Done when:_ CI is green; `https://<api>/health/ready` reports db and redis ok; the web URL returns 200; the human
  has run `! pnpm smoke`; ADR-001 records the probe results.
- _Build status:_ code done (workspace, CI incl. gitleaks and a Docker build job, CD workflow, `scripts/smoke.ts`,
  vendored OpenAPI, `apps/web/CLAUDE.md`). Open: GitHub remote, first CI run, deploys, smoke run, ADR-0001 results,
  `packages/zoho-inventory/CLAUDE.md`.

**M1 Contract + FakeZoho + MCP (1 day)**

- ToolRuntime, ZohoClient, FakeZoho with its faults, and the 9 Tier-1 tools.
- `/mcp` (bearer) and `/mcp/demo` (rate-limited).
- `pnpm gen:tools` writes `docs/mcp-tools.json`, plus a staleness test.
- _Done when:_ the Inspector CLI lists the tools in a stable order against prod `/mcp/demo`; a fresh Claude Code
  session with `mb-demo` answers "Is CHAI-250 in stock in Bengaluru and at what price?"; the contract suite is green;
  bad args return `isError`, never a throw.
- _Build status:_ code done: 9 Tier-1 tools plus `zoho_check_stock`, `/mcp`, `/mcp/demo` (per-session isolation),
  `pnpm gen:tools` + staleness test, contract suite green; Inspector `tools/list` verified against local. Open: prod.

**M2 Zoho OAuth + token vault (½–1 day)**

- DC map from `accounts.zoho.com/oauth/serverinfo`.
- `/oauth/zoho/start` sends invite code, HMAC single-use state (10 min), `access_type=offline`, `prompt=consent` and
  the 8 scopes.
- The callback exchanges the code at the returned `accounts-server`; the API host comes from `api_domain`.
- Refresh tokens are stored with AES-256-GCM. The access token is cached for 55 min in Redis; refresh is single-flight
  under `SET NX`. 401 → refresh → one retry → `RECONNECT_REQUIRED`.
- Disconnect revokes the token. Mint the `mb_live_` key, store only its hash.
- _Done when:_ 20 parallel calls produce exactly 1 token request; replayed, expired or tampered state is rejected;
  tokens never appear in captured logs; the human connects the trial org on prod; `claude mcp add … /mcp --header
"Authorization: Bearer mb_live_…"` returns real stock.
- _Build status:_ code done, including the browser-bound state cookie and `POST /api/connection/disconnect`; each
  connect creates a new tenant and key (ADR-0008). Open: connecting the trial org on prod.

**M3 Governor (½ day)**

- Keyed by `connector:org` (or `demo:{session}`). 80/min, concurrency leases 4/8, 50% daily share with a UTC-midnight
  reset (an ADR assumption).
- Code 44 opens a 60 s circuit. Code 45 returns `DAILY_QUOTA_EXHAUSTED` and is never retried. Code 1070 requeues with
  jitter.
- 5xx gets 2 retries; timeout is 10 s; a request queues at most 10 s, then returns `RATE_LIMITED` with `retry_after_s`.
- Cache: items 60 s, org 300 s, tenant in the key.
- _Done when:_ fake-timer tests pass for 44, 45, 1070, 5xx, timeout and concurrency; two agents running in parallel
  stay at or under 80/min.
- _Build status:_ code done (63 governor tests). Open: the governor is keyed per tenant, not per org (ADR-0008).

**M4 Site + playground (1 day)**

- Pages, cards, the 2 toggles (code 44, expired token), cost guards and the replay fallback, as in §5.
- _Done when:_ Playwright against prod passes for: card → at least one tool step → answer; toggle 44 → a
  `RATE_LIMITED` step is visible; refusal card → 0 tool calls; kill switch → replay.
- _Build status:_ code done except the replay fallback (not built): pages, 5 cards, all 6 fault toggles, cost guards,
  mocked and real-stack Playwright suites (local). Open: replay, Playwright against prod.

**M5 Docs, evals, ship (½ day)**

- 15 evals (5 cards, 3 refusals, 1 injection, 6 tool-specific) run on Haiku **and** Sonnet; commit the report.
- README, readable in 5 minutes: live links, journey, diagram, tool table, principle table, "Built with Claude Code".
- `agent-capabilities.md` (CAN / CANNOT), `integration.md` (10-minute merchant onboarding), `runbook.md` (code 44,
  code 45, reconnect, LLM budget exhausted).
- 6 ADRs, the Python example run in CI, and the 2-minute OAuth video.
- _Done when:_ Sonnet scores at least 90% (Haiku published as-is); since ADR-0009 the gated model is
  `llama-3.3-70b-versatile` on Groq's free tier; a cold incognito run of the README path works; tag `v0.1.0`.
- _Build status:_ 17 eval cases + harness + offline CI suite; README and docs; ADRs 0001-0008. Open: real eval runs
  and report, Python example, OAuth video, `v0.1.0` tag.

**48h compression**, applied in this order:

1. Evals down to 8.
2. `/connect` UI becomes owner-only (keep the OAuth routes, the key and the video).
3. Only the code-44 toggle.
4. 7 tools (drop `get_invoice` and `search_customers`; never `find_by_payment_reference`).

### Tier 2: strong (≈2 days)

- **M6 Payments-linker:**
  - Classify `pay_ order_ rfnd_ sub_ plink_` ids and 12-digit UTRs (low confidence).
  - Normalize paise ↔ rupees.
  - Search order: reference_number → notes and custom fields → bounded scan; return a match confidence.
  - Add `zoho_check_stock` and `zoho_list_shipments` (`check_stock` was built early; `list_shipments` was not, §4).
  - _Done when:_ table-driven tests, including false positives, pass; the Dispute eval passes on Haiku.
- **M7 Resilience UI + activity:**
  - Remaining toggles: 45, 1070, 5xx, malformed.
  - `/activity` from real `usage_events`.
  - `prom-client /metrics`; a stdio bin.
  - _Done when:_ a forced 429 shows the backoff in the trace and a row on `/activity` within 5 s.
- **M8 Proof + evidence:**
  - A "Proof" toggle runs the same question through the Messages API `mcp_toolset` (beta `mcp-client-2025-11-20`)
    against `/mcp/demo`, so Anthropic's infrastructure calls the live endpoint.
  - An Agent SDK eval runner against the deployed `/mcp/demo`; 30 evals on `/evals`.
  - Recorded, PII-scrubbed fixtures from the trial org feed the contract suite.
  - Security suite: tenant A cannot read B; public routes cannot load a real tenant; no tool takes a URL; GET only.

### Tier 3: stretch

- OAuth 2.1 on the MCP leg (RFC 9728 metadata, `WWW-Authenticate`, lazy auth via a hosted IdP), so Claude.ai shows
  its Connect card.
- A Freshdesk connector #2 stub on fake data that passes the **unchanged** contract suite.
- Conflict checks; a one-paragraph pricing note.

**Cut order if time runs out:**

1. Tier 3.
2. The Proof toggle.
3. `/activity` charts (keep the table).
4. `list_shipments`.
5. `check_stock`.
6. The extra toggles.
7. Evals down to 8.
8. `/connect` down to owner-only.
9. Redis down to in-memory, documented as single-instance.

**Never cut:** the live URL, the no-login playground, `/mcp/demo`, real Zoho OAuth on prod, `find_by_payment_reference`,
tested 429 handling, the contract suite, `mcp-tools.json`, the CAN/CANNOT doc, the README.

---

## 7. Quality bar

- **Contract suite**, run per tool on FakeZoho and on recorded fixtures via in-process `handler.fetch`:
  - valid args → schema-valid `structuredContent`
  - bad args → `INVALID_INPUT`
  - unknown id → `NOT_FOUND`
  - result ≤10K tokens
  - allow-listed fields only
- **Failure tests:** 401, 403, 404, 429 (codes 44/45/1070), 5xx, timeout, malformed JSON, bad OAuth state, refresh
  failure (`invalid_grant`), empty result.
- **Security tests:**
  - Tokens never appear in logs or responses.
  - Writes are impossible.
  - Tenant isolation holds.
  - Public routes stay demo-only.
  - The prompt-injection eval passes.
- **Retention:** `usage_events` store masked args and no free text, with a 30-day retention job. One README line maps
  this to Razorpay's DPDPA framing.
- **Supply chain (free on a public repo):** secret scanning with push protection, Dependabot, CodeQL, gitleaks in CI.
- **Docs, kept short:**
  - README
  - `docs/agent-capabilities.md`
  - `docs/mcp-tools.json` (generated)
  - `docs/integration.md`
  - `docs/runbook.md`
  - `docs/adr/` (6 ADRs: TS + MCP v2; demo as a fake upstream; two auth legs; governor defaults for undocumented 429
    behaviour; sales-order search fallback; why not Zoho MCP or Composio)
  - `docs/platform-feedback.md`: what generalizes to connector #2. Ties to "about one week per connector".

---

## 8. Working with Claude Code

**0. Human prep (≈2 h; Claude never does these)**

- Zoho trial org on `.in`: 20 items, 10 SOs, 5 invoices, and payments with `pay_TEST…` refs.
- In `api-console.zoho.in`, create **two** Server-based clients:
  - **PROD:** prod callback; enable the IN, US and EU DCs.
  - **DEV:** localhost callback; keep a DEV refresh token for smoke runs.
  - Two clients mean local re-consents can't evict the prod token.
- Accounts (all free, no card; ADR-0009): GitHub, Hugging Face, Vercel Hobby, Neon, Upstash, Groq, Cloudflare
  Turnstile. (Originally Fly and an Anthropic workspace with a spend cap; both now optional and paid.)
- Write `.env` yourself.
- Set deploy secrets yourself: Space variables and secrets in the Hugging Face UI, `vercel env add`, `gh secret set`.

**1. Context session (plan mode, Shift+Tab), no code.** Prompt:

> "Read CLAUDE.md, docs/PLAN.md and docs/prompts/*. Rewrite CLAUDE.md to ≤120 lines applying PLAN §2–4
> and §9. Add nested CLAUDE.md for packages/zoho-inventory and apps/web. Replace the prompts with docs/prompts/M0–M8.md,
> each ≤40 lines: Goal · Read first · Tests first · Build · Out of scope · Done when (exact commands) · Commit. Write no code."

Review the diff line by line. Delete the duplicate `../CLAUDE.md` one level up.

**2. Ground Claude in current docs.** Claude's training predates MCP SDK v2. Run 3 parallel subagents that write
`docs/notes/*.md`:

- Zoho OpenAPI endpoints and scopes for the tools.
- MCP v2 serving, testing and auth (Fastify, `handler.fetch`).
- Anthropic `mcpTools` / `toolRunner` / the MCP connector beta. Load the `claude-api` skill before any Anthropic code.

Later prompts cite `docs/notes/` instead of re-researching.

**3. Configure `.claude/`** (ask Claude to use the `update-config` skill):

- **Allow:** pnpm, gh, git push (non-force), git worktree, playwright, the inspector.
- **Deny:**
  - `.env*` reads, `rm -rf`, `git push --force`
  - `fly secrets`, `vercel env`
  - `pnpm smoke` (you run it as `! pnpm smoke`)
  - Also drop the kit's `docker compose` allow.
- **Hooks:**
  - Keep the Prettier hook and add `eslint --fix`.
  - **PreToolUse guard:** exit 2 on `.env*` edits and on any POST/PUT/PATCH/DELETE to `zohoapis` or `accounts.zoho`.
  - **Stop hook:** `pnpm -s typecheck && pnpm -s vitest run --changed`, exit 2 on failure, and **exit 0 if
    `stop_hook_active`** so it can't loop.
- **`.mcp.json`:** `mb-demo` → prod `/mcp/demo`, plus Playwright MCP so Claude can drive the site.

**4. Project toolkit** (commit it; it's evidence of AI leverage):

- **Commands:**
  - `/milestone <id>`: load the prompt → plan → wait for approval → enforce done-when.
  - `/verify`: lint, typecheck, test, contract suite, gen:tools staleness. Print real output; never claim an unseen pass.
  - `/verify-prod`: health, Inspector `tools/list` on prod, Playwright smoke, screenshots at 390 and 1440 in light and
    dark that Claude reads back.
  - `/ship`: open the PR with evidence and `Closes #n`.
- **Skill `add-tool`:** Zod in/out, a "use when / don't use when" description with keywords (SO number, SKU, warehouse,
  `pay_`), mapper, FakeZoho fixture, contract test, 2 evals, `gen:tools`.
- **Subagents:**
  - `zoho-verifier`: read-only; flags any param not in `docs/vendor/zoho`.
  - `security-reviewer`: tokens, PII, tenant keys, demo isolation, governor bypass, output size.
  - `eval-analyst`: fixes failing evals by editing tool descriptions first.

**5. GitHub tracking.** Have Claude create milestones and one issue per milestone (`gh issue create`), with the
done-when as a checklist.

**6. M0 first.** Run `/milestone M0`. Deploy hello-world versions of both apps on day 0, so `allowedHosts`, CORS, Neon,
Upstash and MCP v2 compatibility are proven before any tool code exists. Probe with the Inspector, Claude Code and one
Messages API `mcp_toolset` call. Then run `! pnpm smoke` yourself and paste the sanitized output. Claude writes
ADR-001 and corrects the plan wherever reality differs.

**7. The loop for every milestone** (one session, one branch, one PR):

1. `/clear`, then create a branch.
2. Shift+Tab, then `/milestone Mx`.
3. Challenge invented Zoho params (send `zoho-verifier`), missing failure tests and scope creep. Approve.
4. Claude commits **red tests first**, then the implementation, so git history proves the tests came first.
5. Run `/verify`.
6. Run `/code-review high` on every PR and `/security-review` on M2–M4. Fix the findings, then run `/simplify`.
7. Run `/ship`, wait for green CI and the Vercel preview, merge (CD deploys), then run `/verify-prod`.
8. Update `docs/STATUS.md` (done / next / open questions) before closing the session.
9. If context goes above ≈60%, `/compact` with a focus or split the milestone (M2a OAuth, M2b keys).

**8. Parallelize only after M1 freezes the contract:** `tools/list`, the envelope, and the SSE trace-event type in
`packages/core`.

- Run `git worktree add ../mb-web feat/web` and start a second Claude session on `apps/web` against the deployed
  `/mcp/demo` and a mocked SSE stream.
- The main worktree does M2, then M3, serially (both touch ZohoClient).
- Give each worktree disjoint folders and its own ports; rebase daily; merge only through PRs.

**9. Dogfood like a reviewer after every deploy.**

- In a fresh Claude Code session with `mb-demo`, ask the 5 scenario questions and paste the transcripts into the README.
- Have Playwright MCP click through the site and read the screenshots for UI defects.
- Add `/mcp/demo` as a Claude.ai custom connector and run one card.

**10. Eval loop.** Run `pnpm evals` on Haiku and Sonnet. `eval-analyst` diffs the results against the last report.
Fix **tool descriptions before code**, re-run, and commit the report together with the description change.

**11. Final pass.**

- Spawn a fresh subagent: "You are a Razorpay FDE reviewer with 3 minutes. Open the README and the live site; list
  what confused you or failed." Fix the findings.
- Pre-warm the API, check the uptime monitor, tag `v0.1.0`.
- Submit the live links, the invite code and the video.
- The README's "Built with Claude Code" section links 2–3 PRs that show plan → red tests → implementation → review
  fixes, plus the eval-driven description fix.

---

## 9. Corrections the CLAUDE.md rewrite must apply

- **MCP SDK:** use the v2 split packages, not `@modelcontextprotocol/sdk`. Streamable HTTP is primary and stdio is
  secondary. Mount with `createMcpFastifyApp({allowedHosts})`. Keep `legacy: 'stateless'`; never set `'reject'`.
- **clientInfo:** it arrives per request in `_meta`, not from `initialize`. It is a telemetry label only; never key
  behaviour on it.
- **Accounts hosts:** take them from `accounts.zoho.com/oauth/serverinfo`; Canada is `accounts.zohocloud.ca`, and
  `.com.cn` is absent. Exchange the code at the callback's `accounts-server`; call APIs on `api_domain`.
- **`organization_id`:** required on every call **except** `GET /organizations` and `/organizations/{id}`.
- **Token throttles:**
  - 10 auth codes per user per 10 min.
  - 10 token requests per client per 10 min.
  - 10 active access tokens per refresh token.
  - 20 refresh tokens **per user per client**; the 21st silently kills the oldest.
  - `refresh_token` is returned only with `access_type=offline`; always send `prompt=consent`.
- **Revoke:** `POST {accounts}/oauth/v2/revoke/token` with Basic client auth.
- **PKCE:** documented only for public clients. Use confidential client + HMAC state; send PKCE only if smoke shows the
  server client accepts it, and never claim it otherwise.
- **Scopes:** the exact 8 in §4. There is no "organizations" scope; settings.READ covers it.
- **Pagination:** `page`/`per_page` (default 200; the max is **UNVERIFIED**, so cap at 200) and
  `page_context.has_more_page`.
- **`/salesorders` filters:** **UNVERIFIED**; smoke-test them before relying on them.
- **Shipments:** shipment orders have no list endpoint; use `/packages`.
- **Undocumented rate-limit behaviour:** Retry-After headers, the code-44 block duration and the daily reset time are
  not documented. Record the defaults as assumptions in an ADR.
- **Tool results:** errors are `isError` results; every tool has an `outputSchema`; results stay ≤10K tokens; Zoho
  tokens are never passed through.
- **Models:** `tool_choice: auto` (forced tool choice returns 400 on Sonnet/Opus 5.5). Playground on `claude-haiku-4-5`,
  evals also on `claude-sonnet-5-5`.
- **Remove:** Turborepo, Docker Compose, OTel, billing, alerts, and the refresh scheduler from Stack and Layout.
- **Brand:** "Agent Studio-style" wording, a not-affiliated note, no Razorpay trade dress. Keep the MerchantBridge theme
  tokens.

## 10. Top risks

| Risk                                                       | Mitigation                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/salesorders` has no search filters                       | Day-0 smoke; documented fallback chain; bound stated in CAN/CANNOT                       |
| Zoho trial expires after 14 days (the free plan continues) | Public demo never depends on Zoho; record the video early                                |
| Local re-consent evicts the prod refresh token             | Separate PROD and DEV clients                                                            |
| Cold starts or SSE buffering break the demo                | Keep-warm ping every 6 h (free Space, ADR-0009), SSE headers, heartbeat, replay fallback |
| LLM cost or abuse                                          | $0 free-tier model (ADR-0009), Turnstile, per-IP limits, daily cap, kill switch          |
| MCP SDK v2 minor-version churn                             | Exact pins; day-0 compatibility probe; v1 fallback ADR                                   |
| Claude invents Zoho params                                 | Vendored OpenAPI, `zoho-verifier` subagent, UNVERIFIED tags + smoke probes               |
