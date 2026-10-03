# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MerchantBridge is a private, Agent Studio-style connector that lets AI agents read a merchant's Zoho Inventory over MCP.
It is a Razorpay FDE take-home (Option 3) and v1 of a real product. The full plan, decisions and milestones are in
`docs/PLAN.md`; milestone prompts are in `docs/prompts/M*.md`; current progress is in `docs/STATUS.md`.

## Golden rules

1. **Read-only, enforced server-side.** ZohoClient issues GET only; only `ZohoInventory.*.READ` scopes; no write tools.
   MCP `readOnlyHint` is a hint, not the guarantee.
2. **Every Zoho call goes ZohoClient → Governor.** Nothing else may reference `zohoapis` (a test enforces this).
3. **MCP is a thin door.** Tools go through `ToolRuntime` (packages/core); no `fetch` in tools or in apps/api routes.
4. **Exactly one `usage_event` per tool call**, success or error.
5. **Tenant isolation:** every DB row and cache key includes the tenant (or `demo:{session}`). The live governor is
   keyed per Zoho organization (`zoho:<dc>:<org>`), because Zoho's quotas are per org and shared by every tenant of it.
6. **Public routes are demo-only.** `/mcp/demo` and the playground are bound to the demo tenant + FakeZoho and can
   never load real credentials.
7. **Never read, print or commit secrets.** `.env*` is off-limits. Never log tokens, auth codes, client secrets, or
   unmasked customer email/phone. Zoho tokens are never passed through to MCP clients.
8. **No invented APIs.** Zoho params/shapes come only from `docs/vendor/zoho/` (official OpenAPI) or `docs/notes/`.
   Anything else is tagged `UNVERIFIED` in code and gets a probe in `scripts/smoke.ts`. For library APIs released
   after your training (MCP SDK v2, Vitest 5, Next 16, Zod 4, ioredis 6), read the installed `node_modules/<pkg>`
   README / `.d.ts` before writing code.
9. **Never call real Zoho in tests.** Tests use FakeZoho (a fetch transport). `pnpm smoke` hits real Zoho; human-run only.
10. Tests first for risky logic (OAuth state/refresh, governor, contract). Never claim a check passed without running it.

## Stack

TypeScript 6 strict, Node ≥22 (`moduleResolution: bundler`, run with `tsx`) · pnpm workspaces (`pnpm -r`) ·
Zod 4 · MCP TS SDK **v2** (`@modelcontextprotocol/server|client|fastify`, exact-pinned) · Fastify 5 ·
Drizzle + Postgres (Neon in prod, PGlite in tests) · Redis via ioredis (Upstash in prod; `MemoryKv` in tests) ·
Next.js 16 + Tailwind 4 · `@anthropic-ai/sdk` (`mcpTools` + `toolRunner`) · Pino · Vitest · Playwright.
Hosting ($0, no card — a hard requirement): apps/web on Vercel Hobby, apps/api as a Hugging Face Docker Space (keep-warm
workflow), Neon free, Upstash free; Fly.io only as an optional paid alternative. No Turborepo, Docker Compose, OTel.

## Layout

```
apps/api                 Fastify: /mcp (bearer mb_live_), /mcp/demo, /oauth/zoho/*, /api/playground (SSE), /api/explorer, /health/*
apps/web                 Next.js site: /, /playground, /tools, /connect, /docs
packages/core            defineTool/defineConnector, ToolRuntime, envelope, errors, Kv, Clock, cursor, money, masking, trace + usage types
packages/governor        per-org rate governor (80/min, concurrency leases, daily share, 429 codes 44/45/1070, retries, circuit) + cache
packages/auth            Zoho DC map, OAuth URL + HMAC state, code exchange, AES-256-GCM vault, single-flight refresh, API keys
packages/db              Drizzle schema + migrations (tenants, api_keys, connections, usage_events)
packages/zoho-inventory  ZohoClient, mappers, tools, FakeZoho (wire-accurate fake upstream + demo dataset + faults)
evals/                   scenario questions + expected tool calls, run through the same toolRunner loop
docs/                    PLAN.md, STATUS.md, agent-capabilities.md, mcp-tools.json (generated), adr/, notes/, vendor/zoho/
```

Workspace packages are consumed as TS source (`exports: ./src/index.ts`); import them as `@mb/<name>`.

## Commands

- `pnpm i` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build`
- One package: `pnpm --filter @mb/governor test` · one test: `pnpm --filter @mb/governor exec vitest run -t "code 44"`
- `pnpm dev:api` (Fastify on :8787) · `pnpm dev:web` (Next on :3000) · `pnpm evals` · `pnpm gen:tools`
- `pnpm smoke` — real Zoho, **human only** (run as `! pnpm smoke`)
- Inspect MCP: `npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp/demo --transport http --method tools/list`
- Add to Claude Code: `claude mcp add --transport http mb-demo http://localhost:8787/mcp/demo`

## Zoho facts (from official docs; see docs/notes/zoho.md)

- API: `{api_domain}/inventory/v1` (e.g. `https://www.zohoapis.in`). Header `Authorization: Zoho-oauthtoken <token>`.
  `organization_id` query param on every call except `GET /organizations` and `/organizations/{id}`.
- Accounts host per DC from `https://accounts.zoho.com/oauth/serverinfo` (ca = accounts.zohocloud.ca). Exchange the
  code at the callback's `accounts-server`; call APIs on the returned `api_domain`.
- OAuth: `access_type=offline` + `prompt=consent` (refresh token only then). Code valid 60 s; ≤10 codes/user/10 min;
  ≤10 token requests/client/10 min; ≤10 live access tokens per refresh token; ≤20 refresh tokens per user **per
  client** (21st silently kills the oldest). Access token ≈1 h. Revoke: `POST {accounts}/oauth/v2/revoke/token`.
  PKCE is documented for public clients only — do not claim PKCE.
- Scopes (request all on first consent): `ZohoInventory.settings.READ,items.READ,salesorders.READ,invoices.READ,
contacts.READ,packages.READ,shipmentorders.READ,customerpayments.READ`.
- Pagination: `page`, `per_page` (default 200; cap at 200, max UNVERIFIED), `page_context.has_more_page`.
- Body `code: 0` = success; non-zero is an error even on HTTP 200. 401 = bad token.
- Limits per org: 100 req/min (429 code 44, org blocked), daily by plan 1k/2k/5k/10k/10k (429 code 45),
  concurrency 5 free / 10 paid (429 code 1070). Retry-After, block duration and daily reset are undocumented →
  governor defaults (80/min, leases 4/8, 50% daily share, 60 s circuit on 44, UTC-midnight reset) are ADR assumptions.
- `/salesorders` documents no search/date/customer/status filters (UNVERIFIED until smoke). Shipment orders have no
  list endpoint — use `/packages`. `GET /salesorders/{id}` embeds packages, shipments and invoices.

## Tool conventions

- Server name `merchantbridge`; tool names `zoho_<verb>_<noun>`; deterministic `tools/list` order.
- Description = what it returns + "Use when…" + "Don't use when… (use X instead)" + limits.
- Every tool declares Zod input and output; MCP gets `inputSchema`, `outputSchema`, `structuredContent` + text copy.
- Envelope `{ data, page: { next_cursor, has_more }, meta: { organization_id, as_of, cached, zoho_url, budget_remaining_today, demo } }`.
- Lists: `limit` default 20, max 100, opaque `cursor`. Results ≤10K tokens (test-enforced). Field allow-lists.
- Money `{ amount_minor, currency }`; ISO dates; email/phone masked; Zoho free text wrapped as `{ untrusted_text }`.
- Errors are tool results with `isError: true` and `{ error: { code, message, retryable, retry_after_s?, hint } }`;
  codes: INVALID_INPUT, NOT_FOUND, RATE_LIMITED, DAILY_QUOTA_EXHAUSTED, RECONNECT_REQUIRED, SCOPE_NOT_GRANTED,
  UPSTREAM_ERROR. JSON-RPC errors only for unknown tools / malformed requests.

## MCP + LLM specifics

- Mount with `createMcpFastifyApp({ host: '0.0.0.0', allowedHosts })`; keep `legacy: 'stateless'` (never `'reject'`).
- `clientInfo` arrives per request in `_meta`; telemetry label only, never used for authz.
- Playground and evals run on a free OpenAI-compatible provider by default (`MB_LLM_PROVIDER=openai`, Groq,
  `llama-3.3-70b-versatile`); Anthropic is optional (`MB_LLM_PROVIDER=anthropic`, paid). Never make a paid provider the
  default. `tool_choice: auto` everywhere. Load the `claude-api` skill before touching the Anthropic path.

## Definition of done

Contract + failure tests pass on FakeZoho · `pnpm lint typecheck test` green · tool listed in `docs/mcp-tools.json`
(`pnpm gen:tools`) and `docs/agent-capabilities.md` · ≥1 eval covers it · usage event emitted · `docs/STATUS.md` updated.
Conventional commits (`feat(zoho): add zoho_get_item`); one milestone = one branch/PR.

## Brand / UI

"Agent Studio-style", independent; not-affiliated footer; no Razorpay logos/trade dress. Theme: surface #F7F6F2 /
#0E1513, ink #0F1A17 / #ECF2EF, brand Bridge Green #0B6E58 / #3DD6A8, accent Saffron #E8912A / #F5B14F (sparingly),
Manrope + JetBrains Mono, radius 6/10/16, hairline borders over shadows, no gradients, no emoji. Always-visible
DEMO DATA badge on demo surfaces; loading/empty/error states; works at 390px; light + dark.

## When unsure

Ask one specific question rather than guessing an API shape. If the plan and reality disagree, write an ADR in
`docs/adr/` and update `docs/PLAN.md`.
