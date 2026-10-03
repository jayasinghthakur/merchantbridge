# Deploying MerchantBridge for $0

This is the path that runs the live deployment (deployed and verified 2026-10-04). Every service is on a free plan
with no payment card ([ADR-0009](adr/0009-free-tier-stack.md)):

| What            | Where                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| Web (`WEB`)     | https://merchantbridge-web.vercel.app (Vercel project `merchantbridge-web`, Hobby)       |
| API (`API`)     | https://merchantbridge-api.vercel.app (Vercel project `merchantbridge-api`, Hobby)       |
| Public demo MCP | https://merchantbridge-api.vercel.app/mcp/demo                                           |
| Postgres        | Neon Free, project `rough-resonance-29665077`, branch `production`                       |
| Redis           | Upstash Free                                                                             |
| Model           | Groq free tier, `openai/gpt-oss-120b` through Groq's OpenAI-compatible API               |
| Deploys         | `bash scripts/deploy-vercel.sh [api\|web\|all]` from the repo root (no Git auto-deploys) |

`API` and `WEB` below mean those two origins (no trailing slash). Commands run from the repo root unless they say
otherwise; put pnpm on the `PATH` first (`export PATH="$HOME/.local/bin:$PATH"`). Never paste secret values into
issues, PRs, chats or this file: pipe them from the tool that produced them (§3, §4) so they never reach the screen or
the shell history.

Hugging Face Docker Spaces were the first $0 API host and were dropped on 2026-10-04: Hugging Face now answers HTTP
402 ("hosting Gradio and Docker Spaces on free cpu-basic requires a PRO subscription"). The Space files, its deploy
and keep-warm workflows and `scripts/setup-deploy.py` were deleted; see the ADR-0009 amendment.

## Checklist

1. Accounts (§1): Vercel Hobby, Neon, Upstash, Groq; optional Cloudflare Turnstile; Zoho API console (pending).
2. Vercel CLI login and link both app folders once (§2).
3. Database: connection strings from Neon, migrations from your machine (§4).
4. API environment variables in the `merchantbridge-api` project (§3).
5. Deploy with `bash scripts/deploy-vercel.sh` (§5), then verify (§6) and record the result in `docs/STATUS.md`.
6. Still open: the Zoho PROD client and the real OAuth connect (§7).

## 0. What runs where, and what it costs

| Piece                      | Service and plan                                              | Limits that matter                                                                                                                   | Cost   |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `apps/api`                 | **Vercel Hobby**, one Vercel Function (Node.js 22, streaming) | Hobby usage allowances (vercel.com/docs/limits); at most 300 s per request (`maxDuration`); cold start on each new function instance | $0     |
| `apps/web`                 | **Vercel Hobby**, Next.js                                     | Hobby is for non-commercial use only                                                                                                 | $0     |
| Postgres                   | **Neon Free**                                                 | Free-plan storage and compute caps; compute scales to zero when idle, so the first query after idle is slow                          | $0     |
| Redis                      | **Upstash Free**                                              | 500K commands per month                                                                                                              | $0     |
| Playground and evals model | **Groq free tier**, `openai/gpt-oss-120b`                     | Per-minute and per-day request and token limits per model; current numbers: console.groq.com/settings/limits                         | $0     |
| Playground bot check       | **Cloudflare Turnstile** (optional, not configured yet)       | Free                                                                                                                                 | $0     |
| CI                         | **GitHub Actions**, public repository                         | Free for public repositories                                                                                                         | $0     |
| Live Zoho leg              | **Zoho Inventory** 14-day trial, then the Free plan           | 1,000 API calls per day per organization on Free (MerchantBridge uses at most half: the governor's 50% daily share)                  | $0     |
| **Total**                  |                                                               |                                                                                                                                      | **$0** |

Not used on the $0 path: the Anthropic API (paid; only with `MB_LLM_PROVIDER=anthropic`) and Fly.io (paid; see
[Optional alternatives](#optional-alternatives-docker-image-and-flyio)).

### How the API runs on Vercel

[`apps/api/src/vercel.ts`](../apps/api/src/vercel.ts) is the whole entry point: it builds the Fastify app once per
function instance (Fluid compute reuses an instance for several requests), hands each request to Fastify's own HTTP
handler, waits until the response has finished, then flushes the buffered usage events before the invocation ends
(serverless gives no guarantee that a background timer runs after the response).
[`apps/api/scripts/build-vercel.mjs`](../apps/api/scripts/build-vercel.mjs) (`pnpm build:vercel` in `apps/api`)
bundles it with esbuild, workspace packages and npm dependencies included, into Vercel's Build Output API layout:
`apps/api/.vercel/output` with one function `index.func` (`nodejs22.x`, response streaming on, `maxDuration` 300)
and a single route that sends every path to it. If the app cannot start (for example a malformed variable), every
request gets `503 {"error":{"code":"UNAVAILABLE","message":"Service is starting or misconfigured."}}` and the log
names the variable, never its value; the next request retries the start.

### Honest caveats

- **Free-tier model limits are tight for an agent loop.** Each model turn resends the 10 tool schemas and the
  conversation. Measured on 2026-10-04: the COD card (one `zoho_get_item` call) used about 7K input tokens and took
  about 8 s; multi-step cards cost more. Groq's limits are per model and change; check
  console.groq.com/settings/limits. The live API sets `MB_PLAYGROUND_DAILY_CAP=40` so MerchantBridge's own "budget
  used up" message comes before Groq's 429. The `/tools` explorer and `/mcp/demo` need no model and keep working.
- **Groq sees what the playground sends.** The playground and evals are bound to the demo tenant and FakeZoho ("Chai
  & Co (DEMO)", fake data) by design, so only demo data reaches the model. Never point a third-party free model at
  real merchant data without reading the provider's current data-retention terms.
- **The model is untested at scale.** `openai/gpt-oss-120b` answered the COD card correctly on prod; the full eval
  suite has not run on it yet (README, [Evals](../README.md#evals)).
- **Serverless trade-offs.** A new function instance pays a cold start (bundle load, Postgres and Redis
  connections), and Neon's free compute sleeps when idle, so the first request after a quiet spell is slow. A single
  request (including a playground SSE stream) is cut at 300 s; a playground run is bounded by 6 model turns and 10
  tool calls. All state (governor windows, limits, token cache, OAuth nonces) lives in Redis and Postgres, so any
  number of instances behave as one.
- **Vercel Hobby is for non-commercial use.** Fine for this take-home demo; a paid merchant deployment needs a paid
  plan or another host.

## 1. Accounts (once)

1. **GitHub:** https://github.com/jayasinghthakur/merchantbridge (public, so Actions, secret scanning, Dependabot
   and CodeQL are free).
2. **Vercel:** a Hobby account; the projects live in the scope `jaya-singhs-projects` (override with `VERCEL_SCOPE`
   when running the deploy script elsewhere).
3. **Neon:** a free project (here `rough-resonance-29665077`, branch `production`). The `neonctl` CLI prints its
   connection strings (§4).
4. **Upstash:** a free Redis database with TLS. Copy the `rediss://default:<password>@<host>.upstash.io:6379` URL
   (not the REST URL).
5. **Region:** every tool call makes several Redis round trips, so keep Neon and Upstash in or near the API's
   function region (Vercel project → Settings → Functions).
6. **Groq:** at console.groq.com create an API key (free, no card). Groq's API is OpenAI-compatible and supports
   tool use.
7. **Cloudflare Turnstile** (optional): a widget for `merchantbridge-web.vercel.app`; site key and secret key.
8. **Zoho API console** (pending, §7): a **Server-based** PROD client, plus a separate DEV client for local work.

## 2. Vercel CLI and project links

The CLI is pinned and run through pnpm, so nothing is installed globally:

```sh
export PATH="$HOME/.local/bin:$PATH"
pnpm dlx vercel@62.2.0 login
(cd apps/api && pnpm dlx vercel@62.2.0 link --yes --project merchantbridge-api)
(cd apps/web && pnpm dlx vercel@62.2.0 link --yes --project merchantbridge-web)
```

Linking writes `apps/api/.vercel/project.json` and `apps/web/.vercel/project.json` (`.vercel/` is gitignored). The
deploy script refuses to run until both exist.

### Why deploys come from a git-free temp folder

A `vercel deploy` run from inside this repository sends the git metadata along, including the commit author, and
Vercel **blocks** the deployment ("the commit author doesn't have permission to create deployments for this
project") unless that author is a member of the Vercel team, and a Hobby account cannot add team members. So
[`scripts/deploy-vercel.sh`](../scripts/deploy-vercel.sh) builds inside the repo, copies the prebuilt output and the
project link into a fresh `mktemp -d` folder that has no `.git`, and deploys from there with `--prebuilt --prod`.
Never run `vercel deploy` from inside the repo; use the script.

For the same reason Vercel's Git integration (auto-deploys on push, PR previews) is **not set up**. To enable it later
(optional, untested here): connect the GitHub account `jayasinghthakur` to the Vercel account (in Vercel's account
settings), then import the repository twice:

| Project              | Root Directory | Build                                                                          | Env vars needed in the project                                                                |
| -------------------- | -------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `merchantbridge-api` | `apps/api`     | Framework "Other", Build Command `pnpm build:vercel` (writes `.vercel/output`) | those in §3 (already set)                                                                     |
| `merchantbridge-web` | `apps/web`     | Framework Next.js, default build                                               | `NEXT_PUBLIC_API_URL` = `API`, `NEXT_PUBLIC_REPO_URL` (the script inlines them today; see §5) |

Both builds need the workspace root (lockfile, `packages/`), so keep "include files outside the Root Directory"
enabled. The lockfile needs pnpm 12 (`packageManager` in the root `package.json`); if Vercel's built-in pnpm is too
old, the env var `ENABLE_EXPERIMENTAL_COREPACK=1` (in both projects) makes it use that version. With the integration
Vercel builds from GitHub itself; `scripts/deploy-vercel.sh` stays as the manual path.

## 3. Environment variables (`merchantbridge-api`, Production)

Names come from [`apps/api/src/config.ts`](../apps/api/src/config.ts). _Sensitive_ variables are write-only in Vercel
(nobody can read them back, including you), so keep the originals where they came from (Neon, Upstash, Groq, your
password manager).

| Name                      | Type      | Value on the live deployment                                                                                                              |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Sensitive | Neon **pooled** string (host contains `-pooler`, `sslmode=require`). The client disables prepared statements for the pooler.              |
| `DATABASE_URL_UNPOOLED`   | Sensitive | Neon **direct** string. Not read at runtime; migrations use it (§4).                                                                      |
| `REDIS_URL`               | Sensitive | Upstash `rediss://…` URL. A pasted `redis-cli --tls -u redis://…` command is tolerated: the URL is extracted and upgraded to `rediss://`. |
| `MB_LLM_API_KEY`          | Sensitive | The Groq API key.                                                                                                                         |
| `MB_ENCRYPTION_KEY`       | Sensitive | base64 of exactly 32 random bytes (AES-256-GCM key for refresh tokens). **Never change it once a merchant has connected.**                |
| `MB_STATE_SECRET`         | Sensitive | ≥ 32 bytes, HMAC key for OAuth `state`. Rotating it only fails in-flight consents.                                                        |
| `MB_CONNECT_INVITE_CODE`  | Sensitive | The hard-to-guess code handed to reviewers and merchants.                                                                                 |
| `MB_PUBLIC_API_URL`       | Plain     | `https://merchantbridge-api.vercel.app` (its host joins the MCP Host allow-list; it feeds the demo URL and OAuth links)                   |
| `MB_PUBLIC_WEB_URL`       | Plain     | `https://merchantbridge-web.vercel.app` (CORS and OAuth redirects)                                                                        |
| `MB_CORS_ORIGINS`         | Plain     | Extra browser origins, comma-separated, one `*` allowed (e.g. a preview pattern). `MB_PUBLIC_WEB_URL` is always included.                 |
| `MB_CLIENT_IP_SOURCE`     | Plain     | `xff-last` (the right-most `X-Forwarded-For` entry; the TCP peer on Vercel is the platform's proxy). Probe in §6 not run yet.             |
| `MB_LLM_PROVIDER`         | Plain     | `openai` (any OpenAI-compatible endpoint)                                                                                                 |
| `MB_LLM_BASE_URL`         | Plain     | `https://api.groq.com/openai/v1` (also the default)                                                                                       |
| `MB_PLAYGROUND_MODEL`     | Plain     | `openai/gpt-oss-120b` (also the code default for `openai`)                                                                                |
| `MB_PLAYGROUND_ENABLED`   | Plain     | `true`; `false` is the kill switch                                                                                                        |
| `MB_PLAYGROUND_DAILY_CAP` | Plain     | `40` questions per UTC day (code default 300)                                                                                             |
| `ZOHO_REDIRECT_URI`       | Plain     | `https://merchantbridge-api.vercel.app/oauth/zoho/callback` (must match the Zoho console entry exactly)                                   |
| `LOG_LEVEL`               | Plain     | `info`                                                                                                                                    |
| `ZOHO_CLIENT_ID`          | Sensitive | **Not set yet** (no Zoho org/PROD client yet, §7). Until it and the secret are set, `/connect` shows `connect_disabled`.                  |
| `ZOHO_CLIENT_SECRET`      | Sensitive | **Not set yet** (§7).                                                                                                                     |
| `TURNSTILE_SITE_KEY`      | Plain     | Optional, not set. Public by design (served to browsers via `/api/status`).                                                               |
| `TURNSTILE_SECRET_KEY`    | Sensitive | Optional, not set. Without it the playground relies on the per-IP limit (10 questions per 10 min) and the daily cap.                      |
| `MB_METRICS_TOKEN`        | Sensitive | Optional, not set: `/metrics` then answers 404 in production.                                                                             |

Also optional: `MB_ALLOWED_HOSTS` (extra API hostnames for the Host check) and `MB_TRUSTED_EGRESS_CIDRS` (CIDRs, e.g.
Anthropic's MCP egress ranges, whose callers share one larger `/mcp/demo` bucket). Not set by hand: `HOST` and `PORT`
(a Vercel Function does not listen on a port) and `NODE_ENV`. **Never set `MB_DEV_FAKE_ZOHO`**: it is the local
fake-live mode, and the server refuses to start with it in production.

The `merchantbridge-web` project needs no variables: the deploy script inlines `NEXT_PUBLIC_API_URL` (`API`) and
`NEXT_PUBLIC_REPO_URL` (the GitHub URL) into the build (§5).

**Set or change a variable** from the linked `apps/api` folder, then redeploy (a deployment keeps the values it was
created with):

```sh
cd apps/api
printf %s "$VALUE" | pnpm dlx vercel@62.2.0 env add NAME production --sensitive --force   # Sensitive
printf %s "$VALUE" | pnpm dlx vercel@62.2.0 env add NAME production --force               # Plain
cd ../.. && bash scripts/deploy-vercel.sh api
```

`printf %s` sends the value without a trailing newline; `--force` overwrites an existing value (so never re-run it for
`MB_ENCRYPTION_KEY` once a merchant has connected). Generated secrets can go straight in without being shown:

```sh
cd apps/api
printf %s "$(openssl rand -base64 32)" | pnpm dlx vercel@62.2.0 env add MB_ENCRYPTION_KEY production --sensitive --force
printf %s "$(openssl rand -base64 48)" | pnpm dlx vercel@62.2.0 env add MB_STATE_SECRET production --sensitive --force
```

A key generated this way exists only in Vercel, and a Sensitive value cannot be copied out. That is fine for
`MB_STATE_SECRET`; for `MB_ENCRYPTION_KEY`, if you might ever move hosts, generate it into your password manager
first and pipe it from there, or every connected merchant will have to reconnect after the move.

For values you must type (the Groq key, the Upstash URL), read them into a variable with `read -rs VALUE` (no echo),
pipe as above, then `unset VALUE`. `pnpm dlx vercel@62.2.0 env ls production` lists the names (never Sensitive
values).

**Which model runs:** `MB_LLM_PROVIDER` is `openai` or `anthropic`; unset, it is `openai` when `MB_LLM_API_KEY` is
set, else `anthropic` when `ANTHROPIC_API_KEY` is set, else the playground is disabled. `openai` talks to
`MB_LLM_BASE_URL` (default Groq) with `MB_LLM_API_KEY`. `MB_PLAYGROUND_MODEL` defaults to `openai/gpt-oss-120b` for
`openai` and `claude-haiku-4-5` for `anthropic`. Switching to another free model is a config change: Groq's
`openai/gpt-oss-20b`, Gemini's OpenAI-compatible endpoint, an OpenRouter free model, or a local Ollama
(`http://localhost:11434/v1`, local development only). The playground is enabled when `MB_PLAYGROUND_ENABLED=true`
**and** the selected provider has a key. `ANTHROPIC_API_KEY` is optional and paid; leave it unset on the $0 path.
`/connect` stays disabled unless all six of `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`,
`MB_ENCRYPTION_KEY`, `MB_STATE_SECRET` and `MB_CONNECT_INVITE_CODE` are set.

## 4. Database (Neon) and migrations

`neonctl` prints connection strings; they go straight into Vercel and into the migration script without being shown:

```sh
pnpm dlx neonctl auth     # browser login, once
cd apps/api
printf %s "$(pnpm dlx neonctl connection-string production --project-id rough-resonance-29665077 --pooled --ssl require)" \
  | pnpm dlx vercel@62.2.0 env add DATABASE_URL production --sensitive --force
printf %s "$(pnpm dlx neonctl connection-string production --project-id rough-resonance-29665077 --ssl require)" \
  | pnpm dlx vercel@62.2.0 env add DATABASE_URL_UNPOOLED production --sensitive --force
cd ../..
```

The server never migrates on boot (Drizzle's migrator takes no lock, so concurrent instances could race). Apply
`packages/db/drizzle/*.sql` with [`apps/api/scripts/migrate.ts`](../apps/api/scripts/migrate.ts) over the **direct**
connection, before the first deploy and again before deploying any change that adds a migration (they are
forward-only and must land before the code that needs them):

```sh
DATABASE_URL_UNPOOLED="$(pnpm dlx neonctl connection-string production --project-id rough-resonance-29665077 --ssl require)" \
  pnpm --filter @mb/api exec tsx scripts/migrate.ts
```

It reads `DATABASE_URL_UNPOOLED` when set, else `DATABASE_URL`, never logs the URL, logs `migrations applied` and
exits 0. Re-running is safe: only pending migrations are applied. CI holds no database credentials.

## 5. Deploy

```sh
bash scripts/deploy-vercel.sh        # api, then web
bash scripts/deploy-vercel.sh api    # API only (after an API change or an env-var change)
bash scripts/deploy-vercel.sh web    # web only
```

What [`scripts/deploy-vercel.sh`](../scripts/deploy-vercel.sh) does:

- **api:** `pnpm build:vercel` in `apps/api` (esbuild bundle into `apps/api/.vercel/output`); copy that output and
  `.vercel/project.json` into a git-free temp folder; `vercel deploy --prebuilt --prod --yes --scope …` from there;
  print the `Aliased https://…` line and `curl API/health/ready`.
- **web:** `vercel build --prod --yes` in `apps/web` with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_REPO_URL` set, so
  both are inlined into the bundle; copy the output into a git-free temp folder that mirrors the repo layout with
  symlinks (`node_modules`, `apps/web`, `packages`: the Next.js output references files relative to the repo root);
  deploy prebuilt; print the HTTP status of `WEB/`.
- On a failed deploy it prints the error lines and the path of the temp `deploy.log`, and exits non-zero. On exit it
  deletes any `apps/api/.env.local` / `apps/web/.env.local` the CLI wrote, so pulled values do not linger on disk.
- Overrides: `VERCEL_SCOPE` (default `jaya-singhs-projects`), `MB_API_URL`, `MB_WEB_URL`, `MB_REPO_URL`.

Each run creates a new production deployment and moves the production alias to it. **Environment variable changes
apply only to new deployments:** after `vercel env add`, run `bash scripts/deploy-vercel.sh api`. Changing `API`
means redeploying the web too (its value is inlined at build time).

## 6. Verify production

`/verify-prod https://merchantbridge-api.vercel.app https://merchantbridge-web.vercel.app` in Claude Code runs the
read-only parts of this list.

```sh
API=https://merchantbridge-api.vercel.app WEB=https://merchantbridge-web.vercel.app
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

curl -sS $API/health/live                       # {"ok":true}
curl -sS $API/health/ready                      # {"ok":true,"storage":"postgres","kv":"redis","checks":{...},"version":...}
curl -sS $API/api/status                        # tool_count 10, playground_enabled, model, connect_enabled
curl -sS -o /dev/null -w '%{http_code}\n' $API/metrics          # 404 (production, no MB_METRICS_TOKEN)

# MCP over the wire: 10 tools in alphabetical order, the same list as docs/mcp-tools.json
npx @modelcontextprotocol/inspector --cli $API/mcp/demo --transport http --method tools/list
curl -sS -X POST $API/mcp/demo "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"zoho_find_by_payment_reference","arguments":{"reference":"pay_DEMO8xK2"}}}'
# INV-00005, SO-00007, tracking 1490811234567

# Fault injection needs your own demo session
curl -sS -X POST $API/mcp/demo "${H[@]}" -H 'X-MB-Session: verify-prod-01' -H 'X-MB-Faults: rate_limit_44' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zoho_get_item","arguments":{"sku":"CHAI-250"}}}'
# isError result: RATE_LIMITED with retry_after_s (circuit open). X-MB-Faults: expired_token → refreshed, then answered

curl -sS -o /dev/null -w '%{http_code}\n' -X POST $API/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 401
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' $API/oauth/zoho/start
# 302 → $WEB/connect/error?reason=connect_disabled (until §7)
curl -sS -o /dev/null -D - -H "Origin: $WEB" $API/api/status | grep -i access-control-allow-origin

MB_MCP_URL=$API/mcp/demo python3 examples/python/mcp_demo_client.py    # stdlib-only client
PLAYWRIGHT_BASE_URL=$WEB pnpm --filter @mb/web exec playwright test -c playwright.real.config.ts
```

Then run one playground card on `WEB/playground` (it spends Groq quota): at least one tool step, then an answer.

**Verified on 2026-10-04:** `/health/ready` ok with `postgres` and `redis`; `/api/status` 10 tools, playground
enabled, model `openai/gpt-oss-120b`, connect disabled; `/mcp/demo` `tools/list` (10);
`zoho_find_by_payment_reference` `pay_DEMO8xK2` → INV-00005 / SO-00007 / tracking 1490811234567; `rate_limit_44` →
`RATE_LIMITED` + `circuit_open`; `expired_token` → `token_refreshed`; `/mcp` without a key → 401;
`/oauth/zoho/start` → 302 to `WEB/connect/error?reason=connect_disabled`; CORS for the web origin; the Python client;
the real-stack Playwright suite against production, 35/35; the COD playground card (one `zoho_get_item` call; 38
units at Bengaluru, ₹180.00; about 8 s, about 7K input tokens).

**Not run yet: client-IP probes.** With `MB_CLIENT_IP_SOURCE=xff-last` the per-IP limits (`/mcp/demo`, explorer,
playground, OAuth start, failed-key lookups) trust the right-most `X-Forwarded-For` entry, on the assumption that
Vercel's proxy sets it to the real caller (see `resolveClientIp` in
[`apps/api/src/http-util.ts`](../apps/api/src/http-util.ts)). Until these two probes pass, treat it as UNVERIFIED:

```sh
# (a) Spoofing: 61 requests from one machine, each claiming another IP
for i in $(seq 1 61); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/mcp/demo "${H[@]}" \
    -H "X-Forwarded-For: 198.51.100.$i" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
done | sort | uniq -c
# (b) Shared bucket: right after (a) ended in a 429, one request from a different network
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/mcp/demo "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- (a) **Pass:** at least one `429` (60 per minute per caller; a run that straddles a minute boundary can show 61
  `200`s, so run it again). **Fail:** 61 `200`s twice means the right-most entry is client-controlled: set
  `MB_CLIENT_IP_SOURCE=socket` (every caller then shares one bucket: safe but strict), redeploy, record it.
- (b) **Pass:** `200`. **Fail:** `429` means the right-most entry is a shared proxy address, so the per-IP limits act
  as one global limit (safe, but strict for reviewers). Record it in `docs/STATUS.md`.

Wait a minute afterwards (the probe uses up this host's `/mcp/demo` bucket) before running Playwright.

## 7. Pending: real Zoho on production

1. Create the Zoho Inventory organization (trial on `.in`, then Free) with seed data.
2. Zoho API console (`api-console.zoho.in` for an `.in` account): **Server-based** client for PROD. Homepage URL
   `WEB`; Authorized redirect URI exactly `https://merchantbridge-api.vercel.app/oauth/zoho/callback`; Settings →
   enable the data centres you serve and "use the same OAuth credentials for all data centers". Keep a separate DEV
   client (redirect `http://localhost:8787/oauth/zoho/callback`) for `pnpm smoke` and local work: Zoho keeps only 20
   refresh tokens per user per client, so local re-consents on the PROD client would evict production.
3. Set `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` as Sensitive variables (§3), then `bash scripts/deploy-vercel.sh api`.
4. `API/api/status` shows `connect_enabled: true`. Connect the org at `WEB/connect` with the invite code; with the
   minted key, `zoho_get_connection_status` over `API/mcp` returns the organization
   ([integration.md](integration.md) §2). Record the 2-minute OAuth video.

## 8. Operating it

- **Logs:** `pnpm dlx vercel@62.2.0 logs --project merchantbridge-api --environment production -x` (or the project's
  Logs tab). Look for `merchantbridge api ready` (one per instance: storage, kv, connect, playground provider and
  model) and `merchantbridge api failed to start: …`. MerchantBridge keeps no logs of its own; audit data is in
  `usage_events` (Postgres).
- **Kill switch:** `MB_PLAYGROUND_ENABLED=false` (§3), then redeploy the API. `/mcp/demo` and `/tools` keep working.
- **Rotate the Groq key:** create a new key in the Groq console, replace `MB_LLM_API_KEY` (§3), redeploy, run one
  playground card, then delete the old key ([runbook](runbook.md)).
- **Rollback:** promote the previous production deployment in the Vercel dashboard (Deployments → Instant Rollback),
  or check out an older commit and run the script. Migrations are forward-only; a rollback across a schema change
  needs a compatible schema.
- Every other failure mode: [runbook](runbook.md).

## 9. Troubleshooting

- **Deploy refused: "the commit author doesn't have permission to create deployments for this project".** The deploy
  ran from inside the git repository. Use `bash scripts/deploy-vercel.sh`, which deploys from a git-free folder (§2).
- **`apps/api is not linked`** (or `apps/web`): run the `vercel link` commands in §2.
- **Every request answers 503 `UNAVAILABLE`**: the app could not start. The logs show
  `merchantbridge api failed to start:` followed by `Production requires: DATABASE_URL, REDIS_URL` or
  `Invalid environment configuration:` and the variable names. Fix the variable (§3) and redeploy.
- **`Invalid URL` at start, from `REDIS_URL`.** A mis-pasted `REDIS_URL` used to fail this way: the value was
  Upstash's whole `redis-cli --tls -u redis://…` command instead of the URL. The config now extracts the URL from
  such a command and upgrades it to `rediss://`; a value with no `redis://`/`rediss://` URL in it (for example
  Upstash's REST URL) still fails, with a message that names `REDIS_URL`. The same extraction applies to a pasted
  `psql '…'` for `DATABASE_URL`.
- **Playground error "The agent hit an unexpected error" and a log line `playground run failed` with `status: 404`
  and `model_not_found`:** the model id is not available to the key. Groq moved Llama 3.3 70B
  (`llama-3.3-70b-versatile`) to Enterprise-only, so free keys get 404; the default is now `openai/gpt-oss-120b`. Set
  `MB_PLAYGROUND_MODEL` to a model the key can use and redeploy. `pnpm evals` reports the same case as "returned HTTP
  404 … (unknown model id?)".
- **An env-var change has no effect:** deployments keep the values they were created with; redeploy (§5).
- **Slow first request, or `/health/ready` 503 with `checks.store: false` that clears on retry:** Neon's compute was
  asleep (scale to zero) or the function instance was cold. Retry; see the [runbook](runbook.md#neon-cold-start).
- **403 on every route except `/health/*` and `/`:** the request Host is not in the allow-list. Use the production
  alias (`MB_PUBLIC_API_URL`); deployment-specific `…vercel.app` URLs are not allowed unless added to
  `MB_ALLOWED_HOSTS`.
- **The site calls the wrong API:** `NEXT_PUBLIC_API_URL` is inlined at build time; redeploy the web (§5).

## Optional alternatives: Docker image and Fly.io

- **Docker image** ([`apps/api/Dockerfile`](../apps/api/Dockerfile), build context = repo root): the long-running
  server (`src/server.ts`) for any Docker host. The CI `docker` job builds and boot-tests it; it is not deployed
  anywhere. Same variables as §3 plus `PORT` (8787); run the migrations by hand (§4).
- **Fly.io (paid, needs a card):** [`apps/api/fly.toml`](../apps/api/fly.toml) and
  [`deploy-api.yml`](../.github/workflows/deploy-api.yml) are kept; the workflow only posts a "Fly deploy skipped"
  notice while the `FLY_API_TOKEN` secret is unset. To use it: `fly apps create <app>` (and set `app` in `fly.toml`),
  set the §3 values with `fly secrets set --stage -a <app> …` (leave `MB_CLIENT_IP_SOURCE` unset; it defaults to
  `fly-client-ip` on Fly), then `fly deploy . --config apps/api/fly.toml --remote-only --ha=false` from the repo root
  (its `release_command` runs the migrations). For CD add the secret `FLY_API_TOKEN` and the variable `FLY_API_URL`.
  Run probe (a) with the header `Fly-Client-IP` instead of `X-Forwarded-For`.
