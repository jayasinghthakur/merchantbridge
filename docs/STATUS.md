# Status

Updated: 2026-10-03 (night): new hard requirement, **everything must be free** (no paid Anthropic API, no Fly.io, no
card). [ADR-0009](adr/0009-free-tier-stack.md) moves the API to a free Hugging Face Docker Space and the playground
and evals to a free OpenAI-compatible provider (Groq by default); deploy docs and workflows rewritten for the $0 path
(uncommitted). Earlier the same day: org-keyed governor, honest connection-status scopes, strict demo fault header and
explorer body, sales-order scan order check, local fake-live mode, the CI browser job and verification-status docs.
Update this file at the end of every session: done / next / human-only / open questions. Plan:
[`PLAN.md`](PLAN.md). Prompts: [`prompts/`](prompts/).

Everything below runs locally with no credentials. **Nothing is deployed, and no real Zoho or LLM call has been made
yet.** The code is on GitHub ([jayasinghthakur/merchantbridge](https://github.com/jayasinghthakur/merchantbridge),
`main` pushed); CI results are not recorded here yet. The README's "Verification status" table is the short version
of this page.

## Done (verified 2026-10-03)

| Area                | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools               | 10 read-only tools in [`mcp-tools.json`](mcp-tools.json): the 9 Tier-1 tools plus `zoho_check_stock`. `zoho_list_shipments` not built (shipments come from `zoho_get_sales_order` and `zoho_find_by_payment_reference`). Staleness test in `apps/api`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| MCP endpoints       | `POST /mcp` (bearer `mb_live_` key, 600/min per key, failed-key limiter) and `POST /mcp/demo` (public, FakeZoho, per-session isolation via `X-MB-Session`, 60/min per IP). `X-MB-Faults` applies only with a valid client session; an unknown fault or faults without one get HTTP 400 (never silently ignored); `X-MB-Applied-Faults` echoes what ran (CORS-exposed); the demo trace carries session and faults. `capabilities.tools.listChanged: false`. Both MCP protocol eras tested.                                                                                                                                                                                                                                                                                                                                                                        |
| Public API          | `GET /api/status`, `/api/tools`, `/api/scenarios`; `POST /api/explorer/call` (30/min per IP; strict body `tool`, `args`, `session_id`, `faults`: unknown keys are a 400); `POST /api/playground` (SSE; per-IP 10/10 min, Turnstile, then global daily cap 300; per question <= 10 tool calls, 6 turns, 120K input tokens).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OAuth connect       | `GET /oauth/zoho/start` (invite code, 10 attempts per IP per 10 min, HMAC state + browser-bound cookie) and `/oauth/zoho/callback` (accounts-server allow-list, AES-256-GCM vault, key minted). Any failure after the code exchange revokes the freshly issued refresh token. Unconfigured connect redirects with `reason=connect_disabled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Disconnect          | `POST /api/connection/disconnect` (bearer key): revokes the refresh token at Zoho, drops the cached access token, marks the connection revoked, revokes the key; local revocation even when Zoho is unreachable. [ADR-0008](adr/0008-tenant-per-connect-and-disconnect.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Governor scope      | Live governor keyed per Zoho organization `zoho:<dc>:<org>`, shared by every tenant of that org (ADR-0008 amended); cache keys stay tenant-scoped. Expired tokens show a `token_refreshed` decision then one `retried` (reason `token_refreshed`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tool honesty        | `zoho_get_connection_status` returns `scopes_requested` (Zoho does not report grants). Sales-order scans cover the first 600 orders Zoho returns and report `data.scan.order_verified`; `zoho_url` deep links use the web-app route format (UNVERIFIED, ADR-0001 amended).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Fake-live mode      | `pnpm dev:api:fake-live` (`MB_DEV_FAKE_ZOHO=true`, `apps/api/src/dev/`): ephemeral dev-only Zoho client, vault, state and invite values; in-process fake Zoho Accounts (token, revoke) + FakeZoho on the IN hosts, any other outbound host throws; seeds tenant "Local dev merchant" with a key; fake consent page completes `/connect`. Refused with `NODE_ENV=production` or `DATABASE_URL`/`REDIS_URL`. Verified by hand on 2026-10-03: `tools/list` and `tools/call` on `/mcp` (`meta.demo: false`), connect through the consent page to a new working key, disconnect `200` then `401`. 13 tests in `apps/api/test/dev-fake-live.test.ts`.                                                                                                                                                                                                                  |
| Ops endpoints       | `GET /health/live`, `/health/ready` (probes coalesced to one per 2 s); `GET /metrics` (prom-client; 404 in production unless `MB_METRICS_TOKEN` is set, then bearer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Security hardening  | Per-session demo isolation with server-reserved `ip-` ids; client-IP source (`MB_CLIENT_IP_SOURCE` = socket / fly-client-ip / xff-last; `xff-last` expected on the Hugging Face Space, auto `fly-client-ip` on Fly; IPv6 /64 buckets); log redaction incl. query strings and SQL params; 5xx bodies without internals; Host-header validation; CORS allow-lists; hashed keys. Suite: `apps/api/test/security.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Web                 | `/`, `/playground` (5 cards, 6 fault toggles, trace pane), `/tools` (explorer, raw JSON-RPC), `/connect` (+ success, error), `/docs` (CAN/CANNOT, live tool table, client snippets incl. disconnect). DEMO DATA badge, 390 px, light + dark.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Evals               | 17 cases (5 scenario cards, 3 write attempts, 1 prompt injection, 8 tool-specific); every tool required by >= 1 case; offline CI suite (110 tests). Real runs pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Deploy config       | **$0 path (ADR-0009):** `apps/api/Dockerfile` (PORT 8787, `0.0.0.0` in production, uid 1000, no Fly-only assumptions); `deploy/hf-space/` (Space card with `sdk: docker`, `app_port: 8787`; `assemble.sh`, dry-run locally on 2026-10-03: 117 files, all `COPY` sources present, no env/test/doc files); `deploy-hf-space.yml` (assemble, Docker build, force-push; skips without `HF_TOKEN`/`HF_SPACE`); `keep-warm.yml` (GET `/health/live` every 6 h; skips without `API_URL`); migrations by hand with `scripts/migrate.ts`; [`deploy.md`](deploy.md) with a $0 cost table. CI (lint, typecheck, test, web build; `e2e` job with screenshot artifacts; Docker build + boot smoke; gitleaks), CodeQL, Dependabot. Kept as optional paid alternative: `fly.toml` + `deploy-api.yml` (skips without `FLY_API_TOKEN`). None of the deploy workflows has run yet. |
| Claude Code toolkit | `.claude/settings.json` is **active** (commit `7a83037`; permissions, `.env`/Zoho-write guard, format and stop hooks); applies when Claude Code is started inside this repository directory. Commands, `add-tool` skill and 3 subagents in `.claude/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Docs                | README (verification-status table, quickstart with ports and the free LLM setup, fake-live and browser-suite commands, hosted-demo journey marked TODO), `agent-capabilities.md`, `integration.md`, `deploy.md` ($0 path), `runbook.md` (LLM 429/quota, Space asleep, Groq key rotation); ADRs 0001-0009 (0001, 0006, 0008 amended; 0009 free-tier stack). Stale `README-KIT.md` deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

1. Get CI green on GitHub, including the first Docker image build (no Docker on the dev machine) and the first `e2e`
   job run; link its screenshot artifact from the README.
2. Deploy the $0 stack ([`deploy.md`](deploy.md)): Hugging Face Space (api), Vercel (web), Neon, Upstash, Groq,
   Turnstile; migrations by hand (§4); then §8: `/health/ready`, Inspector `tools/list`, the Python client, the two
   `X-Forwarded-For` probes, the real-stack Playwright suite against prod.
3. Human runs `pnpm evals` with `MB_LLM_API_KEY` (Groq, `llama-3.3-70b-versatile`, gate 90%), split across days with
   `--cases` if Groq's daily token allowance runs out, and commits `evals/reports/`; fill the README pass-rate table.
   Fix tool descriptions before code if cases fail (`eval-analyst`).
4. Human runs `! pnpm smoke`; fill ADR-0001 results; if `/salesorders` filters work, enable `SERVER_SIDE_SO_FILTERS`
   and drop the 600-order bound from the docs.
5. ADR-0008 follow-up: reuse the tenant on reconnect (the org-keyed governor is done), and an organization picker.
6. Playground replay fallback (recorded transcript badged "replay"; the UI already renders the badge, the API always
   sends `replay: false`), or drop it from PLAN M4.
7. Smaller: record-fixtures script and fixture-backed contract runs (M8); a Playwright spec for the fake-live connect
   flow (verified by hand and by API tests only).

## Human-only tasks

- Create the free accounts (no card): Hugging Face, Vercel Hobby, Neon, Upstash, Groq, Cloudflare Turnstile. The
  GitHub repo exists. No Fly.io and no Anthropic account are needed.
- Zoho: trial org on `.in` with seed data (items, sales orders, invoices, payments with `pay_TEST…` refs); PROD and
  DEV server-based clients.
- Set secrets: Space variables and secrets in the Hugging Face UI, Vercel env vars, GitHub secret `HF_TOKEN` and
  variables `HF_SPACE`, `API_URL`, `WEB_URL` ([`deploy.md`](deploy.md) checklist); Claude is denied `gh secret`,
  `vercel env` and `fly secrets`.
- Run the database migrations against Neon from your machine (`deploy.md` §4).
- Run `! pnpm smoke` and paste sanitized output; run `pnpm evals` with `MB_LLM_API_KEY` exported.
- Connect the trial org on prod, record the 2-minute OAuth video, fill `LIVE_SITE_URL`, `DEMO_MCP_URL`, `VIDEO_URL`
  and the PR links in the README.
- Review and merge; tag `v0.1.0`; submit links, invite code and video.

## Open questions

- **Client IP on the Hugging Face Space:** does the platform's proxy append the real caller to `X-Forwarded-For`, so
  `xff-last` is neither spoofable nor one shared internal address? Unverified; two probes in `deploy.md` §8
  (fallback: `MB_CLIENT_IP_SOURCE=socket`).
- **Space readiness:** the API answers 404 on `/` (403 for an unknown Host). If Hugging Face's readiness check needs a
  2xx there, the Space would stay in "Starting" and `apps/api` needs a small `GET /` route. Unverified until the
  first deploy.
- **Free-tier headroom:** Groq allows `llama-3.3-70b-versatile` roughly 100K tokens per day, a handful of playground
  questions; is that enough for the review window, or should `MB_PLAYGROUND_DAILY_CAP` be lowered / another free
  endpoint be configured as well? Where the free Space runs (for the Neon/Upstash region) is also unverified.
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
- After ADR-0009: `CLAUDE.md` (Stack: "apps/api on Fly.io"; "Playground model `claude-haiku-4-5`"), the web
  playground copy ("a real Claude agent", `apps/web/app/playground/page.tsx`), `.claude/commands/verify-prod.md`
  ("Anthropic budget") and the historical `docs/prompts/` and `docs/notes/` still describe Fly.io and Claude as the
  playground model. ADR-0009 and `deploy.md` are authoritative.
