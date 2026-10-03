# Status

Updated: 2026-10-03, after integration, security hardening, disconnect and evals (last commit `7a83037`). Update this
file at the end of every session: done / next / human-only / open questions. Plan: [`PLAN.md`](PLAN.md). Prompts:
[`prompts/`](prompts/).

Everything below runs locally with no credentials. **Nothing is deployed, there is no GitHub remote, and no real
Zoho or Anthropic call has been made yet.**

## Done (verified 2026-10-03)

| Area                | State                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools               | 10 read-only tools in [`mcp-tools.json`](mcp-tools.json): the 9 Tier-1 tools plus `zoho_check_stock`. `zoho_list_shipments` not built (shipments come from `zoho_get_sales_order` and `zoho_find_by_payment_reference`). Staleness test in `apps/api`.                                                                                                                  |
| MCP endpoints       | `POST /mcp` (bearer `mb_live_` key, 600/min per key, failed-key limiter) and `POST /mcp/demo` (public, FakeZoho, per-session isolation via `X-MB-Session`, faults via `X-MB-Faults` only with a client session id, 60/min per IP). Both MCP protocol eras tested.                                                                                                       |
| Public API          | `GET /api/status`, `/api/tools`, `/api/scenarios`; `POST /api/explorer/call` (30/min per IP); `POST /api/playground` (SSE; per-IP 10/10 min, Turnstile, then global daily cap 300; per question <= 10 tool calls, 6 turns, 120K input tokens).                                                                                                                          |
| OAuth connect       | `GET /oauth/zoho/start` (invite code, 10 attempts per IP per 10 min, HMAC state + browser-bound cookie) and `/oauth/zoho/callback` (accounts-server allow-list, AES-256-GCM vault, key minted). Unconfigured connect redirects with `reason=connect_disabled`.                                                                                                          |
| Disconnect          | `POST /api/connection/disconnect` (bearer key): revokes the refresh token at Zoho, drops the cached access token, marks the connection revoked, revokes the key; local revocation even when Zoho is unreachable. [ADR-0008](adr/0008-tenant-per-connect-and-disconnect.md).                                                                                             |
| Ops endpoints       | `GET /health/live`, `/health/ready` (probes coalesced to one per 2 s); `GET /metrics` (prom-client; 404 in production unless `MB_METRICS_TOKEN` is set, then bearer).                                                                                                                                                                                                   |
| Security hardening  | Per-session demo isolation with server-reserved `ip-` ids; client-IP source (`MB_CLIENT_IP_SOURCE` = socket / fly-client-ip / xff-last, auto `fly-client-ip` on Fly, IPv6 /64 buckets); log redaction incl. query strings and SQL params; 5xx bodies without internals; Host-header validation; CORS allow-lists; hashed keys. Suite: `apps/api/test/security.test.ts`. |
| Web                 | `/`, `/playground` (5 cards, 6 fault toggles, trace pane), `/tools` (explorer, raw JSON-RPC), `/connect` (+ success, error), `/docs` (CAN/CANNOT, live tool table, client snippets incl. disconnect). DEMO DATA badge, 390 px, light + dark.                                                                                                                            |
| Evals               | 17 cases (5 scenario cards, 3 write attempts, 1 prompt injection, 8 tool-specific); every tool required by >= 1 case; offline CI suite (110 tests). Real runs pending.                                                                                                                                                                                                  |
| Deploy config       | `apps/api/Dockerfile`, `fly.toml` (bom, 1 always-on machine, migrations as `release_command`), CI (lint, typecheck, test, web build, Docker build + boot smoke, gitleaks), CodeQL, Dependabot, `deploy-api.yml`, [`deploy.md`](deploy.md).                                                                                                                              |
| Claude Code toolkit | `.claude/settings.json` is **active** (commit `7a83037`; permissions, `.env`/Zoho-write guard, format and stop hooks); applies when Claude Code is started inside this repository directory. Commands, `add-tool` skill and 3 subagents in `.claude/`.                                                                                                                  |
| Docs                | README, `agent-capabilities.md`, `integration.md`, `deploy.md`, `runbook.md` updated to the code on 2026-10-03; ADRs 0001-0008.                                                                                                                                                                                                                                         |

### Test results (2026-10-03)

`pnpm test` from the repo root: **624 passed, 0 failed, 45 files.**

| core | web | governor | auth | zoho-inventory |  db | api | evals | total |
| ---: | --: | -------: | ---: | -------------: | --: | --: | ----: | ----: |
|   13 |  27 |       63 |  112 |            161 |  52 |  86 |   110 |   624 |

Playwright (`apps/web`, Chromium, not in CI):

- Mocked e2e (`playwright.config.ts`): 32/32 passed.
- Real stack (`playwright.real.config.ts`) against a local credential-free API and `next start`: **35/35**.

## Next

1. Create the GitHub repo, push, get CI green, including the first Docker image build (no Docker on the dev machine).
2. Deploy: Fly (api), Vercel (web), Neon, Upstash; then [`deploy.md`](deploy.md) §11: `/health/ready`, Inspector
   `tools/list`, the spoofed `Fly-Client-IP` probe, the real-stack Playwright suite against prod.
3. Human runs `pnpm evals` (Sonnet gate 90%) and commits `evals/reports/`; fill the README pass-rate table. Fix tool
   descriptions before code if cases fail (`eval-analyst`).
4. Human runs `! pnpm smoke`; fill ADR-0001 results; if `/salesorders` filters work, enable `SERVER_SIDE_SO_FILTERS`
   and drop the 600-order bound from the docs.
5. ADR-0008 fix: key the governor by organization (and/or reuse the tenant on reconnect) so several tenants of one org
   share one budget; tests for "second connect of the same org shares the governor".
6. Playground replay fallback (recorded transcript badged "replay"; the UI already renders the badge, the API always
   sends `replay: false`), or drop it from PLAN M4.
7. Smaller: Playwright in CI; organization picker on connect; record-fixtures script and fixture-backed contract runs (M8).

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
- **Tenant model (ADR-0008):** org-keyed governor, tenant reuse on reconnect, or both? Is an organization picker
  needed for v1?
- **Deadline scope:** is the replay fallback (PLAN M4) still required, given the explorer works without an LLM?
- The kit's original `CLAUDE.md` still sits outside the repo at `../CLAUDE.kit-original.md`; delete when convenient.

## Docs that disagree with the code (not fixed here)

- PLAN §4 describes the full 4-tier sales-order fallback chain; only the bounded scan is built.
  [ADR-0006](adr/0006-sales-order-search-fallback.md) now records exactly what is built and what is planned.
- PLAN M4 and §5 list a replay fallback and a `/mcp/demo` bucket for Anthropic's egress range; the egress bucket
  exists (`MB_TRUSTED_EGRESS_CIDRS`), the replay fallback does not.
