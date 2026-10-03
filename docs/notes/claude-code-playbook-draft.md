# MerchantBridge build plan (Claude Code-first)

## 1. Positioning and the 3-minute reviewer journey

**A private, Agent Studio-style connector for Zoho Inventory.** In the words of Razorpay's 30 Mar 2026 guardrails post, it is a one-time OAuth connection, scoped to one organization and read-only. All of the merchant's agents share one rate budget, and every call is audited. The site says it is an independent take-home and uses no Razorpay branding.

The reviewer needs no login:

1. **0:00** Clicks **Try the demo**.
2. **0:20** Picks the _"Dispute evidence for pay_DEMO123"_ card. A live trace shows args, latency, cache hits and budget, and the answer cites the order, tracking and invoice.
3. **1:10** Turns on _Simulate Zoho 429 (code 44)_. The governor backs off, the agent explains the `RATE_LIMITED` result, and the activity log records it.
4. **1:40** Asks _"Cancel invoice INV-0042"_. The agent refuses, because no write tools exist.
5. **2:10** On `/tools`, runs a tool and copies `claude mcp add …/mcp/demo`.
6. **2:40** On `/connect`, tries real OAuth, then opens the README, evals and ADRs.

## 2. Stack: TypeScript end to end

Keep the kit's stack and add the pasted plan's demo ideas.

- **MCP TS SDK v2** (`@modelcontextprotocol/server` 2.3.0 plus the Fastify adapter). It is stateless (`createMcpHandler`), serves both 2025-era and 2026-07-28 clients, and runs in-process for tests via `handler.fetch`. Anthropic's TS SDK supplies `mcpTools()` and `toolRunner` for the playground. With Next.js too, that is one language and one CI.
- **One Fastify deployable** serves `/mcp`, `/mcp/demo`, `/oauth`, `/api` and `/playground`. `apps/mcp-server` becomes only the stdio entry.
- **Streamable HTTP is the primary transport.** Agent Studio is built on the Claude Agent SDK, which accepts HTTP MCP servers, and the Messages API connector cannot use stdio. Whether Agent Studio accepts third-party MCP servers at all is not public, so treat that as an inference.
- **Redis: yes** (Upstash), with an in-memory fallback. Zoho limits are per org and every agent the merchant runs shares them, so a per-process bucket is wrong.
- **Cut:** billing, fake-merchant seeding, `zoho_search`, per-minute alerts, full OpenTelemetry, Python and Vite.
- **Tools:** 12 in total, 10 of them in Tier 1.

## 3. Architecture

```
Browser ─► Vercel: apps/web (Next.js) ── REST + SSE ──┐
Agents (Agent SDK · Claude Code · Messages API · Claude.ai)
   └─► Fly.io: apps/server (Fastify, always warm) ◄───┘
       /mcp (Bearer mb_live_) · /mcp/demo (no auth) · /oauth/zoho · /api · /playground
            │ thin MCP handlers
       ToolService: envelope · field allow-lists · PII mask · untrusted_text · audit
            │ Connector interface: health / list / get / search
       ├─ ZohoInventoryConnector ─► Governor ─► Zoho API (GET only)
       └─ DemoZohoConnector (fixtures + faults) ─► Governor (simulated org)
Neon Postgres: tenants, hashed keys, encrypted refresh tokens, usage/audit
Upstash Redis: buckets, daily budget, token cache + refresh lock, short-TTL cache
```

1. **MCP is a thin door.** Handlers validate input and wrap results. `/api` and the playground call the same `ToolService`.
2. **One connector contract.** The demo connector copies Zoho's semantics: `code≠0` errors on HTTP 200, `page_context`, 429 codes 44/45/1070, and 401. It passes the same contract suite as the real connector.
3. **The governor runs on every Zoho call.** It allows 80 requests/min and 4 or 8 concurrent, takes 50% of the daily quota, and applies jittered backoff and a circuit breaker. A test fails on any raw call to `zohoapis`.
4. **Read-only is enforced on the server:** GET-only client, READ scopes, no write tools. Annotations are only hints.
5. **Tenant isolation.** `tenant_id` is in every query and cache key. The demo tenant can only read fixtures. Zoho tokens never leave the server and are never accepted at `/mcp` (the spec forbids passthrough).
6. **Agent-shaped output.** Responses carry `as_of` and `zoho_url`. Errors return as `isError` with `code`, `retry_after_s` and `hint`. Results stay under 10k tokens; Claude Code and the Agent SDK move anything over 25k to a file.

## 4. Tools

The `zoho_` prefix keeps these tools distinct from a Shopify-style connector's tools. An ADR records this choice.

**Tier 1 (10 tools)**

| Tool                                                                                                | Scope            |
| --------------------------------------------------------------------------------------------------- | ---------------- |
| `get_connection_status`                                                                             | settings.READ    |
| `list_items`, `get_item`, `check_stock` (≤25 SKUs)                                                  | items.READ       |
| `list_sales_orders`, `search_sales_orders`, `get_sales_order` (embeds packages, tracking, invoices) | salesorders.READ |
| `search_customers` (PII masked)                                                                     | contacts.READ    |
| `list_invoices`, `get_invoice`                                                                      | invoices.READ    |

**Tier 2 (2 tools)**

- `find_by_payment_reference`: looks up pay_/order_/rfnd_ ids and UTRs via `/customerpayments` and `/invoices`, normalizing paise to rupees. Until it ships, the Tier 1 dispute card uses the documented `reference_number` filter on `/invoices`.
- `list_shipments`: reads from `/packages`.

Zoho does not document which field holds the Razorpay gateway reference (UNVERIFIED). Confirm it on your own test org.

**UNVERIFIED:** the Inventory docs list no search filters for `/salesorders`. A day-1 smoke test settles it. If filters are missing, the fallback is contacts → `customer_id` → `/invoices`, then a bounded scan, documented as such.

## 5. Live site and demo

- **Pages.**
  - `/` and `/playground`.
  - `/tools`: generated from `tools/list`, with a Run form.
  - `/connect`: real Zoho OAuth; issues and revokes `mb_live_` keys.
  - `/activity`: real usage, audit log and health.
  - `/docs`: CAN/CANNOT list, plus snippets for the Agent SDK, Claude Code, the Messages API and Claude.ai ("No sign-in").

  Every page handles loading, empty and error states, works at 390px, supports light and dark, and is labelled **DEMO DATA**.

- **Demo tenant.** A seeded Indian D2C merchant built from Zoho's OpenAPI examples: about 40 items, 25 orders, `pay_DEMO…` invoices and a customer with prior returns. Fault toggles (44/45/1070, expired token, 5xx, malformed) work on the demo tenant only.
- **Playground.**
  - Backend loop: in-process MCP client → `mcpTools()` → `toolRunner`, capped at 6 iterations, with `tool_choice: auto` on `claude-haiku-4-5`. Each step streams over SSE.
  - Four cards: dispute evidence, COD stock/price, RTO risk, unpaid invoices due this week.
  - Tier 2 adds a "Proof" toggle that reruns the question through the Messages API MCP connector against the public `/mcp/demo`.
- **Abuse controls.**
  - Dedicated Anthropic workspace with a $10–20 spend limit.
  - Turnstile.
  - 10 questions per IP per 10 minutes, plus a daily cap.
  - 500-character input limit and `max_tokens` 1024.
  - A kill switch.
  - If the API refuses, a recorded transcript replays.
- **Hosting.**
  - Web: Vercel Hobby.
  - API: Fly.io with `min_machines_running=1`, about $2–5/month (estimate).
  - Data: Neon and Upstash, both free.
  - Uptime ping on `/health/ready`.
  - Not Render free, which sleeps after 15 minutes.

## 6. Milestones

Each milestone is one PR. These replace kit milestones M0–M6.

**Tier 1 (must ship, about 3 days)**

- **M0 Foundation** (kit 00, M0)
  - Build: monorepo and CI; Zoho's OpenAPI vendored into `docs/vendor/zoho/`; a new CLAUDE.md; `docs/SPEC.md`; GitHub issues; and `scripts/smoke.ts`, which the human runs.
  - Done when: CI is green and ADR-001 records the smoke-test results.
- **M1 Contract, demo connector and MCP** (kit M3)
  - Build: the 10 tools on the demo connector, served at `/mcp`, `/mcp/demo` and over stdio; `gen:tools`; a skeleton deployed to Fly.
  - Done when: Inspector lists 10 tools from the deployed URL.
- **M2 OAuth, client and governor** (kit M1, M2)
  - Build: OAuth across data centres, an encrypted vault, single-flight token refresh, and the governor (in-memory backing is fine here).
  - Done when: the tests written first pass (20 parallel calls cause 1 refresh; 44, 45, 1070, 401, 5xx and malformed responses are all handled), and the human connects a real org.
- **M3 Site, playground and deploy** (kit M5 UI, M6)
  - Done when: Playwright passes against prod (card → tool step → answer), and a separate Claude Code session answers all 4 scenarios.
- **M4 Docs and evals**
  - Build: README, capabilities doc, 5 ADRs, runbook, 20 evals, and a GIF.
  - Done when: evals pass at 90% or more and `v0.1.0` is tagged.

**Tier 2**

- **M5 Redis governor:** daily budget, cache and UI fault toggles. Done when 3 parallel agents stay under 80 requests/min.
- **M6 Payments linker:** done when tests cover false positives and the paise conversion.
- **M7 Activity dashboard and Proof toggle:** done when a call appears within 5 seconds.

**Tier 3**

- MCP-side OAuth, so Claude.ai shows a Connect card.
- A second connector stub that passes the contract suite.
- Conflict checks.
- Alerts.
- Billing.

## 7. Quality bar

- **Tests.**
  - The contract suite runs every tool against the demo connector and mocked Zoho, through the in-process MCP client.
  - The failure matrix covers 401 → refresh → retry → `RECONNECT_REQUIRED`, plus 403, 404, 429 (44/45/1070), 5xx, timeout, malformed JSON, an error code inside a 200, and a replayed `state`.
  - Bad arguments return `isError`, never an exception.
  - Size limits are tested.
  - Security tests check that tokens never appear in logs or responses, that the demo tenant stays isolated, that only GET reaches Zoho, and that nothing bypasses the governor.
- **Evals.** 20, growing to 30, on Sonnet 5.5. They cover refusals, prompt injection planted in Zoho notes, and ambiguous questions. The pass rate is published.
- **Security.** Hashed API keys, encrypted refresh tokens, masked PII, `untrusted_text`, READ-only scopes. PKCE only if the smoke test shows Zoho's server client accepts it (UNVERIFIED).
- **Observability.** Pino logs carry request_id, tenant, tool, governor decision and latency. Health endpoints. One usage event per tool call.
- **Docs.**
  - README with a "Built with Claude Code" section.
  - `agent-capabilities.md`.
  - Generated `mcp-tools.json` with a staleness test.
  - `connect.md` and `runbook.md`.
  - 5 ADRs: stack; the two auth legs; undocumented 429 behaviour; sales-order fallback; why not Zoho's own MCP.

## 8. How to work with Claude Code

**One-time setup (M0, about 1 hour)**

- **Repo and plan.**
  - Save this plan as `docs/SPEC.md`.
  - Run `git init` and `gh repo create`.
  - Have Claude turn section 6 into GitHub milestones and issues.
- **Rewrite CLAUDE.md** to about 100 lines, using `@imports`.
  - Update to MCP SDK v2 and this layout.
  - Add these golden rules:
    - no token passthrough;
    - the demo tenant reads fixtures only;
    - errors are returned as `isError`;
    - every tool has an `outputSchema`;
    - every result is under 10k tokens;
    - Zoho facts come only from `docs/vendor/zoho/`. Anything else is tagged UNVERIFIED and added to `smoke.ts`.
  - Fix these Zoho facts:
    - take the accounts host from serverinfo;
    - 10 token refreshes per 10 minutes;
    - 20 refresh tokens per user per client;
    - the exact scopes;
    - `per_page` is at most 200.
  - Add a **Verify** section.
  - Add nested CLAUDE.md files in `connectors/zoho-inventory/` and `apps/web/`. They load only when Claude works there.
- **Kickoff prompt** of about 8 lines: read the docs, list the gaps, write no code.
  - Then run 3 parallel research subagents into `docs/notes/*.md`: the Zoho OpenAPI, MCP v2 serving and testing, and `toolRunner` plus the MCP connector.
  - Later prompts cite these notes instead of re-researching.
- **Milestone prompts** of 40 lines or fewer.
  - Sections: _Goal · Read · Tests first · Build · Out of scope · Done when_.
  - Each must fit in one context window. If one doesn't, split it, for example into M2a (auth) and M2b (governor).
- **Hooks** in `.claude/settings.json`, set up with the `update-config` skill.
  - Keep the `.env` deny rule and Prettier, and add `eslint --fix`.
  - A PreToolUse guard exits 2 to block:
    - POST, PUT, PATCH or DELETE requests to Zoho hosts;
    - printing secrets;
    - `fly secrets`, `vercel env` and `git push origin main`;
    - edits to `.env*` files;
    - non-GET calls in connector code.
  - A Stop hook typechecks the changed packages and blocks on failure. It checks `stop_hook_active` so it can't loop.
- **Commands** in `.claude/commands/`.
  - `/milestone <id>`: plan, wait for approval, then build.
  - `/verify`: runs lint, typecheck, tests, the contract suite, the spec staleness check and Inspector. It prints the real output and never claims an unseen pass.
  - `/demo-check [url]`: runs health checks, Inspector on `/mcp/demo` and Playwright, and takes screenshots at 390px and 1440px in light and dark. Claude reads the screenshots and lists defects.
  - `/zoho-fact <q>`: answers from the OpenAPI only; otherwise tags the fact UNVERIFIED and adds a smoke probe.
  - `/eval`: diffs results against the last report and suggests description fixes.
  - `/ship`: opens a PR with evidence and `Closes #n`.
- **Subagents** in `.claude/agents/`.
  - `zoho-verifier`: read-only; flags invented parameters.
  - `security-reviewer`.
  - `tool-critic`: naming, overlap and "when not to use".
  - `ui-reviewer`.
  - `test-writer`: writes red tests from the done-when criteria.

**Per-milestone loop (one session, one PR)**

1. `/clear`, then create a branch.
2. Shift+Tab into plan mode and run `/milestone Mx`. Push back on invented Zoho params, missing failure tests and scope creep. Ask: "what will you NOT do?"
3. Commit the red tests first, then the implementation. The git log then shows tests came first.
4. Run `/verify`. For auth and governor work, also run `/security-review`.
5. Run `/code-review high`, fix the findings, then run `/simplify`.
6. Run `/ship`. If context is above about 60%, run `/compact` with a focus, or split the milestone.

**Parallel worktrees** (after M1 freezes `tools/list` and the SSE event types)

- Create `../mb-server` and `../mb-web` with `git worktree add`, and run one Claude session in each.
- Each worktree gets disjoint folders, its own ports and its own `.env`, and is rebased daily.
- The web worktree builds against the deployed `/mcp/demo` and a mocked SSE stream.
- The verifier and critic run as background subagents.

**Verify like a reviewer**

- Add `/mcp/demo` to a fresh Claude Code session and ask it the 4 scenarios. The transcripts go in the README.
- Drive the UI with the `run` skill or Playwright MCP, and read the screenshots.
- `/demo-check` against prod must pass before every merge to main.

**Only the human does these**

- Create a Zoho trial org on the `.in` data centre and seed it: 20 items, 10 orders, and 5 invoices with fake `pay_` ids.
- In the API Console, create a server-based client with both redirect URIs (localhost and prod), and enable the US and EU data centres.
  - Use a separate client for prod. A 21st consent silently kills the oldest refresh token.
- Write `.env` by hand. Run `pnpm smoke` and paste back the sanitized output.
- Set up accounts for the Anthropic workspace, Fly, Vercel, Neon, Upstash and Turnstile, and set every secret.
- Review every plan and PR, record the GIF, and do a final read-through of the README.
- Commit `.claude/` and `docs/prompts/` as evidence of being the "most AI-leveraged engineer".

## 9. Risks and cuts

| Risk                                                                 | Mitigation                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Sales-order filters unknown (UNVERIFIED)                             | Smoke test on day 1; fallback chain; documented scan bound           |
| Zoho token throttles                                                 | Single-flight refresh, cached token, separate prod client            |
| Demo cold or down                                                    | Always-warm host, uptime ping, no Zoho dependency, replay mode       |
| Playground cost (about $0.02–0.04 per question, UNVERIFIED estimate) | Caps from section 5                                                  |
| MCP SDK v2 is one day old                                            | Pin versions; contract tests; ADR names v1 1.32.0 as fallback        |
| Upstash Lua support (UNVERIFIED)                                     | Check on day 1; otherwise INCR+EXPIRE                                |
| Agent Studio connector contract is not public                        | Present as "Agent Studio-style"; target the Claude Agent SDK and MCP |
| Claude invents Zoho behaviour                                        | Vendored OAS, `/zoho-fact`, verifier subagent, UNVERIFIED tags       |

**Cut in this order:** billing → alerts → MCP-side OAuth → connector #2 → conflict checks → Proof toggle → activity dashboard → Redis (fall back to in-memory) → payments linker.

**Never cut:** real Zoho OAuth, the demo tenant, 429 handling, contract tests, the tool spec, the capabilities doc, the live site and playground.
