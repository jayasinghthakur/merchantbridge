# Status

Updated: 2026-10-03 (late), after the review-response session: org-keyed governor, honest connection-status scopes,
strict demo fault header and explorer body, sales-order scan order check (code in `afaad10`), plus local fake-live
mode, the CI browser job and verification-status docs (uncommitted). Update this file at the end of every session:
done / next / human-only / open questions. Plan: [`PLAN.md`](PLAN.md). Prompts: [`prompts/`](prompts/).

Everything below runs locally with no credentials. **Nothing is deployed, there is no GitHub remote (so CI has never
run), and no real Zoho or Anthropic call has been made yet.** The README's "Verification status" table is the short
version of this page.

## Done (verified 2026-10-03)

| Area                | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools               | 10 read-only tools in [`mcp-tools.json`](mcp-tools.json): the 9 Tier-1 tools plus `zoho_check_stock`. `zoho_list_shipments` not built (shipments come from `zoho_get_sales_order` and `zoho_find_by_payment_reference`). Staleness test in `apps/api`.                                                                                                                                                                                                                                                                                                                                                                                          |
| MCP endpoints       | `POST /mcp` (bearer `mb_live_` key, 600/min per key, failed-key limiter) and `POST /mcp/demo` (public, FakeZoho, per-session isolation via `X-MB-Session`, 60/min per IP). `X-MB-Faults` applies only with a valid client session; an unknown fault or faults without one get HTTP 400 (never silently ignored); `X-MB-Applied-Faults` echoes what ran (CORS-exposed); the demo trace carries session and faults. `capabilities.tools.listChanged: false`. Both MCP protocol eras tested.                                                                                                                                                       |
| Public API          | `GET /api/status`, `/api/tools`, `/api/scenarios`; `POST /api/explorer/call` (30/min per IP; strict body `tool`, `args`, `session_id`, `faults`: unknown keys are a 400); `POST /api/playground` (SSE; per-IP 10/10 min, Turnstile, then global daily cap 300; per question <= 10 tool calls, 6 turns, 120K input tokens).                                                                                                                                                                                                                                                                                                                      |
| OAuth connect       | `GET /oauth/zoho/start` (invite code, 10 attempts per IP per 10 min, HMAC state + browser-bound cookie) and `/oauth/zoho/callback` (accounts-server allow-list, AES-256-GCM vault, key minted). Any failure after the code exchange revokes the freshly issued refresh token. Unconfigured connect redirects with `reason=connect_disabled`.                                                                                                                                                                                                                                                                                                    |
| Disconnect          | `POST /api/connection/disconnect` (bearer key): revokes the refresh token at Zoho, drops the cached access token, marks the connection revoked, revokes the key; local revocation even when Zoho is unreachable. [ADR-0008](adr/0008-tenant-per-connect-and-disconnect.md).                                                                                                                                                                                                                                                                                                                                                                     |
| Governor scope      | Live governor keyed per Zoho organization `zoho:<dc>:<org>`, shared by every tenant of that org (ADR-0008 amended); cache keys stay tenant-scoped. Expired tokens show a `token_refreshed` decision then one `retried` (reason `token_refreshed`).                                                                                                                                                                                                                                                                                                                                                                                              |
| Tool honesty        | `zoho_get_connection_status` returns `scopes_requested` (Zoho does not report grants). Sales-order scans cover the first 600 orders Zoho returns and report `data.scan.order_verified`; `zoho_url` deep links use the web-app route format (UNVERIFIED, ADR-0001 amended).                                                                                                                                                                                                                                                                                                                                                                      |
| Fake-live mode      | `pnpm dev:api:fake-live` (`MB_DEV_FAKE_ZOHO=true`, `apps/api/src/dev/`): ephemeral dev-only Zoho client, vault, state and invite values; in-process fake Zoho Accounts (token, revoke) + FakeZoho on the IN hosts, any other outbound host throws; seeds tenant "Local dev merchant" with a key; fake consent page completes `/connect`. Refused with `NODE_ENV=production` or `DATABASE_URL`/`REDIS_URL`. Verified by hand on 2026-10-03: `tools/list` and `tools/call` on `/mcp` (`meta.demo: false`), connect through the consent page to a new working key, disconnect `200` then `401`. 13 tests in `apps/api/test/dev-fake-live.test.ts`. |
| Ops endpoints       | `GET /health/live`, `/health/ready` (probes coalesced to one per 2 s); `GET /metrics` (prom-client; 404 in production unless `MB_METRICS_TOKEN` is set, then bearer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Security hardening  | Per-session demo isolation with server-reserved `ip-` ids; client-IP source (`MB_CLIENT_IP_SOURCE` = socket / fly-client-ip / xff-last, auto `fly-client-ip` on Fly, IPv6 /64 buckets); log redaction incl. query strings and SQL params; 5xx bodies without internals; Host-header validation; CORS allow-lists; hashed keys. Suite: `apps/api/test/security.test.ts`.                                                                                                                                                                                                                                                                         |
| Web                 | `/`, `/playground` (5 cards, 6 fault toggles, trace pane), `/tools` (explorer, raw JSON-RPC), `/connect` (+ success, error), `/docs` (CAN/CANNOT, live tool table, client snippets incl. disconnect). DEMO DATA badge, 390 px, light + dark.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Evals               | 17 cases (5 scenario cards, 3 write attempts, 1 prompt injection, 8 tool-specific); every tool required by >= 1 case; offline CI suite (110 tests). Real runs pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Deploy config       | `apps/api/Dockerfile`, `fly.toml` (bom, 1 always-on machine, migrations as `release_command`), CI (lint, typecheck, test, web build; `e2e` job: mocked + real-stack Playwright with screenshots and HTML reports uploaded as an artifact; Docker build + boot smoke incl. the production refusal of `MB_DEV_FAKE_ZOHO`; gitleaks), CodeQL, Dependabot, `deploy-api.yml`, [`deploy.md`](deploy.md). None of it has run on GitHub yet.                                                                                                                                                                                                            |
| Claude Code toolkit | `.claude/settings.json` is **active** (commit `7a83037`; permissions, `.env`/Zoho-write guard, format and stop hooks); applies when Claude Code is started inside this repository directory. Commands, `add-tool` skill and 3 subagents in `.claude/`.                                                                                                                                                                                                                                                                                                                                                                                          |
| Docs                | README (verification-status table, quickstart with ports, fake-live and browser-suite commands, hosted-demo journey marked TODO), `agent-capabilities.md`, `integration.md`, `deploy.md`, `runbook.md` updated to the code on 2026-10-03; ADRs 0001-0008 (0001, 0006, 0008 amended). Stale `README-KIT.md` deleted.                                                                                                                                                                                                                                                                                                                             |

### Test results (2026-10-03)

`pnpm test` from the repo root: **658 passed, 0 failed, 46 files.**

| core | web | governor | auth | zoho-inventory |  db | api | evals | total |
| ---: | --: | -------: | ---: | -------------: | --: | --: | ----: | ----: |
|   13 |  28 |       63 |  112 |            166 |  52 | 114 |   110 |   658 |

Playwright (`apps/web`, Chromium; in the CI `e2e` job, which has not run yet):

- Mocked e2e (`playwright.config.ts`): 32/32 passed.
- Real stack (`playwright.real.config.ts`, 7 behavioural + 28 visual checks) against a local credential-free API and
  `next start`: **35/35**, re-run on `afaad10` with the CI `e2e` job's exact build/start commands (14 s).

## Next

1. Create the GitHub repo, push, get CI green, including the first Docker image build (no Docker on the dev machine)
   and the first `e2e` job run; link its screenshot artifact from the README.
2. Deploy: Fly (api), Vercel (web), Neon, Upstash; then [`deploy.md`](deploy.md) §11: `/health/ready`, Inspector
   `tools/list`, the spoofed `Fly-Client-IP` probe, the real-stack Playwright suite against prod.
3. Human runs `pnpm evals` (Sonnet gate 90%) and commits `evals/reports/`; fill the README pass-rate table. Fix tool
   descriptions before code if cases fail (`eval-analyst`).
4. Human runs `! pnpm smoke`; fill ADR-0001 results; if `/salesorders` filters work, enable `SERVER_SIDE_SO_FILTERS`
   and drop the 600-order bound from the docs.
5. ADR-0008 follow-up: reuse the tenant on reconnect (the org-keyed governor is done), and an organization picker.
6. Playground replay fallback (recorded transcript badged "replay"; the UI already renders the badge, the API always
   sends `replay: false`), or drop it from PLAN M4.
7. Smaller: record-fixtures script and fixture-backed contract runs (M8); a Playwright spec for the fake-live connect
   flow (verified by hand and by API tests only).

## Human-only tasks

- Create accounts and the GitHub repo; Fly, Vercel, Neon, Upstash, Cloudflare Turnstile, Anthropic workspace with a $15
  cap.
- Zoho: trial org on `.in` with seed data (items, sales orders, invoices, payments with `pay_TEST…` refs); PROD and
  DEV server-based clients.
- Set secrets (`fly secrets set`, `vercel env add`, `gh secret set`); Claude is denied these.
- Run `! pnpm smoke` and paste sanitized output; run `pnpm evals` with `ANTHROPIC_API_KEY` exported.
- Connect the trial org on prod, record the 2-minute OAuth video, fill `LIVE_SITE_URL`, `DEMO_MCP_URL`, `VIDEO_URL`
  and the PR links in the README.
- Review and merge; tag `v0.1.0`; submit links, invite code and video.

## Open questions

- **`Fly-Client-IP`:** does Fly's edge overwrite a client-sent value? Unverified; if not, per-IP limits are bypassable
  on Fly (fallback: `MB_CLIENT_IP_SOURCE=socket`). Probe in `deploy.md` §11.
- **Zoho revoke host:** disconnect revokes at the merchant's DC `accounts-server`; Zoho's doc says the host where the
  app is registered. Matters only for cross-DC clients (UNVERIFIED in `packages/auth/src/oauth-client.ts`).
- **Smoke-dependent facts (ADR-0001):** `/salesorders` filters and default order, which field carries Razorpay
  references, `api_domain` per DC, plan names, `zoho_url` hash routes, 429 recovery and the daily reset time.
- **Tenant model (ADR-0008):** the governor is now org-keyed; is tenant reuse on reconnect, or an organization
  picker, needed for v1?
- **Deadline scope:** is the replay fallback (PLAN M4) still required, given the explorer works without an LLM?
- The kit's original `CLAUDE.md` still sits outside the repo at `../CLAUDE.kit-original.md`; delete when convenient.

## Docs that disagree with the code (not fixed here)

- PLAN §4 describes the full 4-tier sales-order fallback chain; only the bounded scan is built.
  [ADR-0006](adr/0006-sales-order-search-fallback.md) now records exactly what is built and what is planned.
- PLAN M4 and §5 list a replay fallback and a `/mcp/demo` bucket for Anthropic's egress range; the egress bucket
  exists (`MB_TRUSTED_EGRESS_CIDRS`), the replay fallback does not.
