# Status

Updated: 2026-10-03 (initial parallel build). Update this file at the end of every session: done / next / open
questions. Plan: [`PLAN.md`](PLAN.md). Prompts: [`prompts/`](prompts/).

## Done

- **Scaffold:** pnpm workspace (`apps/*`, `packages/*`, `evals`), TypeScript 6 strict base config, ESLint 10
  (type-checked, `consistent-type-imports`, `no-floating-promises`), Prettier, `.gitignore`, Node 22 pin. Git repo on
  `main` with 3 commits; **no remote yet**.
- **Core contract (`packages/core`, frozen):** `ToolRuntime` (Zod validation, envelope, `isError` bodies, 10K-token
  cap, exactly one `UsageEvent`), `ConnectorError`/`UpstreamError`, money/masking/`untrusted`/cursors, `Kv` +
  `MemoryKv`, `Clock` + `ManualClock`, `Governor`/`Cache` interfaces + `zohoRateProfile`, store interfaces,
  `API_ROUTES` + HTTP types, `TraceEvent`/`DemoFault`, `SCENARIOS` + `DEMO_IDS`. Runtime tests in
  `packages/core/test/`.
- **Grounding:** Zoho OpenAPI subset + Accounts OAuth pages vendored in `docs/vendor/zoho/`; MCP SDK v2 docs and the
  Anthropic MCP helper source in `docs/vendor/mcp/`. CLAUDE.md rewritten for the v2 plan.
- **Docs pack:** `notes/zoho.md` (verified reference + 23 smoke probes), `notes/mcp-v2.md` and
  `notes/anthropic-mcp.md` (snippets runtime-probed / `tsc`-checked against installed packages), 7 ADRs,
  `agent-capabilities.md`, `integration.md`, `runbook.md`, `platform-feedback.md`, root `README.md`, prompts
  `00-kickoff` + `M0`-`M8` (old kit prompts deleted).

## In progress (parallel agents, same tree; not yet verified together)

| Area                      | State in tree                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/governor`       | window, leases/lock, backoff, circuit, cache, keys modules present                                     |
| `packages/auth`           | DC map (7 supported DCs + `unsupported_dc` list), authorize URL, HMAC state, vault present             |
| `packages/db`             | Drizzle schema, first migration, Postgres + in-memory stores, demo tenant seed present                 |
| `packages/zoho-inventory` | client, upstream, mappers, schemas, scopes, connector, tools, FakeZoho (wire, server, dataset) present |
| `apps/web`                | Next.js shell, theme, header/footer, DEMO badge, explorer/trace/SSE libs present                       |
| `apps/api`                | config (env schema), Redis `Kv`, logger, limits, SSE, Turnstile helpers present; no server entry yet   |
| toolkit                   | `.claude/` commands, skill and subagents per PLAN §8.4 assigned; only `settings.json` in tree so far   |

Each package's own typecheck/test/eslint results are reported by its agent; nothing has been run across the whole
workspace yet.

## Next

1. **Integrate `apps/api`:** server entry, `/mcp` + `/mcp/demo` via the pass-through registration
   (`notes/mcp-v2.md` §3), OAuth routes, playground SSE, explorer, health; `pnpm gen:tools` -> `docs/mcp-tools.json`.
2. Run `pnpm lint && pnpm typecheck && pnpm test` across the workspace; fix contract drift between packages.
3. **Evals** (`evals/`): 15 on Haiku 4.5 + Sonnet 5.5 (M5).
4. **E2E:** Playwright journey against local, then prod (M4).
5. **Deploy:** GitHub repo + CI, Fly (api, `min_machines_running=1`), Vercel (web), Neon, Upstash; hello-world first
   (M0 done-when), then real.
6. Human runs `! pnpm smoke`; fill ADR-0001; adjust ADR-0006 tier 1.

## Open questions

- **Deadline:** full Tier 1 (3-4 days) or the 48-hour cut (PLAN §6: evals 8, owner-only `/connect`, code-44 toggle
  only, 7 tools)?
- **GitHub:** account/org and repo name (public, for free secret scanning, Dependabot, CodeQL)?
- **Deploy accounts:** Fly, Vercel, Neon, Upstash, Cloudflare Turnstile created? App names/domains decide
  `MB_PUBLIC_API_URL`, `MB_PUBLIC_WEB_URL`, `allowedHosts`, CORS.
- **Zoho:** trial org on `.in` created and seeded (20 items, 10 SOs, 5 invoices, payments with `pay_TEST…` refs)?
  PROD and DEV server-based clients created with multi-DC (IN/US/EU) and "same credentials for all DCs"?
- **Smoke results:** none yet (ADR-0001 table empty). Blocks: sales-order filters, payment-ref field, `api_domain`.
- **Anthropic:** non-default workspace with a spend cap ($15) and its key?
- Duplicate kit CLAUDE.md now sits outside the repo at `../CLAUDE.kit-original.md`; delete when convenient.

## Human-only tasks

- Create accounts: GitHub, Vercel, Fly, Neon, Upstash, Cloudflare Turnstile, Anthropic workspace with spend cap.
- Zoho: trial org + seed data; two server-based clients (PROD callback, DEV localhost callback) in api-console.zoho.in.
- Write `.env` locally; set deploy secrets with `fly secrets set` and `vercel env add` (Claude is denied these).
- Run `! pnpm smoke` and paste sanitized output; run `scripts/record-fixtures.ts` (M8) the same way.
- Connect the trial org on prod via `/connect` (M2 done-when); record the 2-minute OAuth video.
- Review every plan and PR; merge; tag `v0.1.0`; submit links, invite code and video.
