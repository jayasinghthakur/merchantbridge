# Deploying MerchantBridge

Step-by-step for the **human** operator. Claude prepares the config but never sets secrets: `fly secrets`,
`vercel env` and `gh secret` are denied to it by the active project settings (`.claude/settings.json`, which apply
when Claude Code is started inside this repository directory). Placeholders used below: `APP` is the
Fly app name, `API` is `https://APP.fly.dev`, `WEB` is the Vercel production URL. Never paste secret values into
issues, PRs, chats or this file.

| Piece          | Where                                | Config in repo                                                                                                                    |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`     | Fly.io, region `bom`, 1 always-on VM | [`apps/api/fly.toml`](../apps/api/fly.toml), [`apps/api/Dockerfile`](../apps/api/Dockerfile), [`.dockerignore`](../.dockerignore) |
| `apps/web`     | Vercel (Git integration)             | project settings only (no `vercel.json`), see §7                                                                                  |
| Postgres       | Neon (free)                          | migrations: [`apps/api/scripts/migrate.ts`](../apps/api/scripts/migrate.ts) via Fly `release_command`                             |
| Redis          | Upstash (free, 500K commands/month)  | `REDIS_URL`                                                                                                                       |
| CD for the API | GitHub Actions                       | [`.github/workflows/deploy-api.yml`](../.github/workflows/deploy-api.yml)                                                         |

> **Docker is not installed on the dev machine.** The `docker build (api image)` job in
> [`ci.yml`](../.github/workflows/ci.yml) is the first real build of the image. Push a branch and let that job go
> green before the first `fly deploy`; it also checks that production mode refuses to start without its secrets or
> with `MB_DEV_FAKE_ZOHO=true`, boots the image (development mode, no secrets) and checks `/health/live`,
> `/health/ready`, `/mcp/demo tools/list` and a graceful SIGTERM exit.

## 1. Accounts (once)

1. **GitHub**: push the repo (public, for free secret scanning, Dependabot and CodeQL).
2. **Fly.io**: create an account, add a card, install `flyctl`, run `fly auth login`.
3. **Vercel**: Hobby account connected to the GitHub repo.
4. **Neon**: free project in the region closest to Mumbai.
5. **Upstash**: free Redis database in the region closest to Mumbai, with TLS on.
6. **Cloudflare Turnstile**: add a widget; hostnames = the Vercel domain(s) the playground runs on.
7. **Anthropic**: in the Console create a dedicated workspace (e.g. `merchantbridge-demo`), set its **spend limit
   to $15** (PLAN §5), and create an API key inside that workspace. Never use an org-wide key here.
8. **Zoho API console** (`api-console.zoho.in` for an `.in` account): create a **Server-based** client for **PROD**.
   - Homepage URL: `WEB`. Authorized redirect URI: **`API/oauth/zoho/callback`** (exact match, no trailing slash).
   - Settings: enable the data centres you serve and "use the same OAuth credentials for all data centers".
   - Keep a separate DEV client (redirect `http://localhost:8787/oauth/zoho/callback`) for local work: Zoho keeps only
     20 refresh tokens per user per client, so local re-consents on the PROD client evict production (see
     "RECONNECT_REQUIRED" in the [runbook](runbook.md)).

## 2. Create the Fly app

```sh
fly apps create merchantbridge-api        # app names are global; pick another if taken
```

If the name differs, change `app = "..."` in `apps/api/fly.toml` (and commit it). Do **not** run `fly launch`: it
rewrites `fly.toml`.

## 3. Collect the values

| Secret                    | Required for                | Value                                                                                                                                             |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | boot (prod refuses without) | Neon **pooled** connection string (host contains `-pooler`, keep `sslmode=require`). The client disables prepared statements for the pooler.      |
| `REDIS_URL`               | boot (prod refuses without) | Upstash `rediss://…` URL (TLS).                                                                                                                   |
| `MB_PUBLIC_API_URL`       | Host allow-list, links      | `API`, e.g. `https://merchantbridge-api.fly.dev` (no trailing slash).                                                                             |
| `MB_PUBLIC_WEB_URL`       | CORS, OAuth redirects       | `WEB`, e.g. `https://merchantbridge.vercel.app`.                                                                                                  |
| `MB_CORS_ORIGINS`         | Vercel previews             | Extra browser origins, comma-separated; one `*` allowed, e.g. `https://merchantbridge-*-<team>.vercel.app`. `WEB` is always included.             |
| `MB_ENCRYPTION_KEY`       | `/connect`                  | base64 of exactly 32 random bytes (AES-256-GCM key for refresh tokens). See below.                                                                |
| `MB_STATE_SECRET`         | `/connect`                  | ≥ 32 bytes, HMAC key for OAuth `state`. See below.                                                                                                |
| `MB_CONNECT_INVITE_CODE`  | `/connect`                  | Any hard-to-guess code you hand to reviewers/merchants.                                                                                           |
| `ZOHO_CLIENT_ID`          | `/connect`                  | PROD client.                                                                                                                                      |
| `ZOHO_CLIENT_SECRET`      | `/connect`                  | PROD client.                                                                                                                                      |
| `ZOHO_REDIRECT_URI`       | `/connect`                  | `API/oauth/zoho/callback`, identical to the Zoho console entry.                                                                                   |
| `ANTHROPIC_API_KEY`       | playground                  | Key from the spend-capped workspace.                                                                                                              |
| `MB_PLAYGROUND_ENABLED`   | playground                  | `true` to enable; `false` is the kill switch.                                                                                                     |
| `TURNSTILE_SITE_KEY`      | playground bot check        | Turnstile widget site key (served to the browser via `/api/status`).                                                                              |
| `TURNSTILE_SECRET_KEY`    | playground bot check        | Turnstile widget secret.                                                                                                                          |
| `MB_TRUSTED_EGRESS_CIDRS` | `/mcp/demo` limits          | Optional. Comma-separated CIDRs copied from Anthropic's published outbound IP list, so Claude.ai / Messages API traffic shares one larger bucket. |
| `MB_METRICS_TOKEN`        | `/metrics`                  | Optional. Bearer token for the Prometheus scrape. Without it `/metrics` answers 404 in production (it is open only in dev/test).                  |

Optional, not secret: `MB_ALLOWED_HOSTS` (extra API hostnames, e.g. a custom domain, see §9),
`DATABASE_URL_UNPOOLED` (Neon's **direct** string; if set, only the migration step uses it, as `@mb/db` recommends)
and `MB_CLIENT_IP_SOURCE`.

`MB_CLIENT_IP_SOURCE` decides which address the per-IP limits (`/mcp/demo`, explorer, playground, OAuth start,
failed-key lookups) and Turnstile see: `socket` (the TCP peer), `fly-client-ip` (Fly's edge header) or `xff-last`
(right-most `X-Forwarded-For` entry, for one generic reverse proxy). **Leave it unset on Fly**: it defaults to
`fly-client-ip` whenever `FLY_APP_NAME` is present (Fly sets it on every machine) and to `socket` elsewhere. A
client-sent `X-Forwarded-For` is never trusted unless you choose `xff-last`. Whether Fly overwrites a client-sent
`Fly-Client-IP` is UNVERIFIED; §11 has the probe.

`/connect` stays disabled unless all six of `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`,
`MB_ENCRYPTION_KEY`, `MB_STATE_SECRET` and `MB_CONNECT_INVITE_CODE` are set. The playground needs
`ANTHROPIC_API_KEY` and `MB_PLAYGROUND_ENABLED=true`. Names come from
[`apps/api/src/config.ts`](../apps/api/src/config.ts).

> **Never set `MB_DEV_FAKE_ZOHO` in production** (not as a secret, not in `fly.toml [env]`, not in Vercel). It is the
> local fake-live mode: it seeds a tenant and key over fake data, fills ephemeral OAuth secrets and replaces Zoho with
> an in-process fake. The server refuses to start with `MB_DEV_FAKE_ZOHO=true` and `NODE_ENV=production` (exit 1,
> "is a local development mode and is refused"), and CI's image smoke test checks that refusal; `fly secrets list`
> must not show it.

Non-secret defaults (`NODE_ENV=production`, `HOST`, `PORT=8787`, `LOG_LEVEL=info`,
`MB_PLAYGROUND_MODEL=claude-haiku-4-5`, `MB_PLAYGROUND_DAILY_CAP=300`) live in `fly.toml [env]`; do not set them as
secrets.

**Generate the two keys** (into your password manager first: Fly secrets cannot be read back):

```sh
openssl rand -base64 32   # MB_ENCRYPTION_KEY: exactly 32 bytes, base64
openssl rand -base64 48   # MB_STATE_SECRET: 64 characters (>= 32 bytes required)
```

`MB_ENCRYPTION_KEY` must never change once a merchant has connected: every stored refresh token becomes
undecryptable and all merchants must reconnect. `MB_STATE_SECRET` can be rotated at any time (only in-flight
consents fail).

## 4. Set the secrets (human only)

`--stage` stores them without restarting anything; the first deploy picks them up. Start the line with a space so
it stays out of shell history (bash `HISTCONTROL=ignorespace`, zsh `setopt HIST_IGNORE_SPACE`).

```sh
 fly secrets set --stage -a APP \
   DATABASE_URL='…' REDIS_URL='…' \
   MB_PUBLIC_API_URL='https://APP.fly.dev' MB_PUBLIC_WEB_URL='https://….vercel.app' \
   MB_CORS_ORIGINS='https://…-*-….vercel.app' \
   MB_ENCRYPTION_KEY='…' MB_STATE_SECRET='…' MB_CONNECT_INVITE_CODE='…' \
   ZOHO_CLIENT_ID='…' ZOHO_CLIENT_SECRET='…' ZOHO_REDIRECT_URI='https://APP.fly.dev/oauth/zoho/callback' \
   ANTHROPIC_API_KEY='…' MB_PLAYGROUND_ENABLED='true' \
   TURNSTILE_SITE_KEY='…' TURNSTILE_SECRET_KEY='…' \
   MB_TRUSTED_EGRESS_CIDRS='…' MB_METRICS_TOKEN='…'
fly secrets list -a APP      # names and digests only
```

The Vercel URL is known once the Vercel project exists (§7); if you deploy the API first, set the two web values
afterwards with `fly secrets set -a APP …` (this restarts the machine).

## 5. First deploy

From the **repo root** (the Docker build context is the whole pnpm workspace, filtered by `.dockerignore`):

```sh
fly deploy . --config apps/api/fly.toml --remote-only --ha=false
```

- `--ha=false` creates one machine instead of Fly's default two (PLAN: one always-on `shared-cpu-1x`, 512 MB).
  Later deploys keep the machine count. If two were created anyway: `fly scale count 1 -a APP`.
- Fly's remote builder builds `apps/api/Dockerfile`, then runs the **release command**
  (`scripts/migrate.ts`, applies `packages/db/drizzle/*.sql`) in a temporary machine with your secrets. If it exits
  non-zero the deploy stops and nothing is replaced. Migrations never run on boot.
- The machine must pass the `/health/live` check before the deploy finishes. `/health/ready` is a top-level check
  (every 5 minutes): it shows in `fly checks list` but does not take the only machine out of rotation on a Redis or
  Neon blip.

Useful: `fly status -a APP`, `fly checks list -a APP`, `fly logs -a APP`, `fly releases -a APP`.

## 6. Verify

```sh
curl -sS API/health/live          # {"ok":true}
curl -sS API/health/ready         # "ok":true, "storage":"postgres", "kv":"redis", checks all true
npx @modelcontextprotocol/inspector --cli API/mcp/demo --transport http --method tools/list
curl -sS -X POST API/mcp/demo -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`storage: "memory"` or `kv: "memory-kv"` on Fly means a secret is missing (production refuses to boot without
`DATABASE_URL`/`REDIS_URL`, so check `fly logs`). Then run the full checks in §11, `/verify-prod API WEB` in Claude
Code, and connect the Zoho trial org through `WEB/connect` with the invite code (PLAN M2 done-when).

## 7. Vercel (apps/web)

Import the GitHub repo as a new project, then in **Settings → Build and Deployment**:

| Setting          | Value                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root Directory   | `apps/web` (the build still needs `packages/core` and the root lockfile, so keep the option that includes files outside the Root Directory enabled) |
| Framework Preset | Next.js                                                                                                                                             |
| Install Command  | Override: `pnpm install --frozen-lockfile --filter "@mb/web..."` (runs in `apps/web`; pnpm installs at the workspace root)                          |
| Build Command    | default (`pnpm run build` = `next build`) or override `next build`                                                                                  |
| Output Directory | default                                                                                                                                             |
| Node.js Version  | 24.x                                                                                                                                                |

**Environment variables** (Production and Preview; set in the dashboard or with `vercel env add`, human only):

| Name                           | Value                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1`. **Required.** Vercel's built-in pnpm is 6-10; with Corepack it uses root `packageManager` (`pnpm@12.8.1`), which the lockfile needs. |
| `NEXT_PUBLIC_API_URL`          | `API` (no trailing slash)                                                                                                                 |
| `NEXT_PUBLIC_REPO_URL`         | the GitHub repo URL                                                                                                                       |

`NEXT_PUBLIC_*` values are inlined at build time: redeploy after changing them. No `vercel.json` is needed. If the
build log shows Corepack failing to start pnpm 12, an untested fallback is the install command
`npx -y pnpm@12.8.1 install --frozen-lockfile --filter "@mb/web..."`.

Afterwards make the API agree with the web origins: `MB_PUBLIC_WEB_URL` = production URL, `MB_CORS_ORIGINS` =
the preview pattern (§3). Add the same hostnames to the Turnstile widget.

## 8. Continuous deployment (GitHub Actions)

`deploy-api.yml` runs `flyctl deploy . --config apps/api/fly.toml --remote-only` on pushes to `main` that touch the
image inputs, and skips with a notice while no token is set.

1. Create an app-scoped deploy token (default expiry is 20 years; prefer one year):
   `fly tokens create deploy -a APP -x 8760h`.
2. GitHub → repo **Settings → Secrets and variables → Actions**:
   - secret `FLY_API_TOKEN` = that token;
   - variable `API_URL` = `API` (the workflow then curls `/health/ready` after each deploy);
   - variable `FLY_CONFIG` only if `fly.toml` moves.
3. Vercel deploys `apps/web` itself via its Git integration (previews on PRs, production on `main`).

## 9. Custom domains (optional)

- API: `fly certs add api.example.com -a APP` and create the DNS records it prints. Then update `MB_PUBLIC_API_URL`
  (or add the host to `MB_ALLOWED_HOSTS`; the MCP Host check rejects unknown hosts with 403), `ZOHO_REDIRECT_URI`
  **and** the Zoho console redirect URI, and Vercel's `NEXT_PUBLIC_API_URL` (redeploy the web).
- Web: add the domain in Vercel, then update `MB_PUBLIC_WEB_URL` / `MB_CORS_ORIGINS` and the Turnstile hostnames.

## 10. After launch

- **Uptime monitor** (PLAN §5): ping `API/health/live` every 5 minutes. Pinging `/health/ready` also keeps Neon
  awake but spends Upstash commands (500K/month free) and Neon compute; keep that interval long.
- **Kill switch:** `fly secrets set -a APP MB_PLAYGROUND_ENABLED=false` (restarts the machine; `/mcp/demo` keeps
  working). See the [runbook](runbook.md) for every other failure mode.
- **Rollback:** `fly releases -a APP --image`, then `fly deploy . --config apps/api/fly.toml --image <previous image>`.
  Migrations are forward-only; a rollback across a schema change needs a compatible schema.
- **Scaling note:** one machine is the design. Before adding a second, remember the governor, token cache and
  limits live in Redis (shared) but `release_command` must stay the only migration runner.

## 11. Verify production

Run after the first deploy and after any change to proxies, limits or the web build. `API` and `WEB` as above.

**1. Health and storage.**

```sh
curl -sS API/health/ready
# 200 {"ok":true,"storage":"postgres","kv":"redis","checks":{"kv":true,"store":true},"version":"0.1.0"}
curl -sS -o /dev/null -w '%{http_code}\n' API/metrics    # 404 without MB_METRICS_TOKEN, 401 with it but no bearer
```

**2. MCP over the wire (Inspector CLI).** Expect the 10 tools in alphabetical order, the same list as
[`mcp-tools.json`](mcp-tools.json):

```sh
npx @modelcontextprotocol/inspector --cli API/mcp/demo --transport http --method tools/list
```

**3. Spoofed `Fly-Client-IP` probe.** The per-IP limits on Fly rely on Fly's edge overwriting any client-sent
`Fly-Client-IP` (UNVERIFIED; see `resolveClientIp` in [`apps/api/src/http-util.ts`](../apps/api/src/http-util.ts)).
From one machine, send 61 requests to `/mcp/demo`, each claiming a different client IP:

```sh
for i in $(seq 1 61); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST API/mcp/demo \
    -H "Fly-Client-IP: 198.51.100.$i" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
done | sort | uniq -c
```

- **Pass:** at least one `429` (the limit is 60 per minute per caller IP; `60 200` + `1 429` when the run fits in one
  minute window). The window is fixed per minute, so a run that straddles a minute boundary can show 61 `200`s: run it
  again immediately.
- **Fail:** 61 `200`s on two consecutive runs means the header is client-controlled. Set
  `fly secrets set -a APP MB_CLIENT_IP_SOURCE=socket` (then every caller behind Fly's proxy shares one bucket, which
  is safe but strict) and record the result in `docs/STATUS.md`.
- Wait a minute afterwards: the probe uses up this host's `/mcp/demo` bucket.

**4. Real-stack browser suite** (no mocks; the specs discover the API origin from the deployed bundle's own requests):

```sh
PLAYWRIGHT_BASE_URL=WEB pnpm --filter @mb/web exec playwright test -c playwright.real.config.ts
```

It asserts the live tool count, the docs page's demo URL answering `tools/list`, the explorer running `zoho_get_item`
and the code-44 fault, the connect and playground states, and writes screenshots at 390 and 1440 px in light and dark
to `apps/web/e2e-real/screenshots/` for review (7 behavioural + 28 visual checks; the same suite runs locally in the
CI `e2e` job, whose artifact holds the local screenshots). With connect and the playground enabled on prod, those two
specs check the enabled state instead of the disabled note and make no model call. Do not run it within a minute of
the probe above.

**5. One live tenant.** After connecting the trial org: `zoho_get_connection_status` over `/mcp` with the key returns
the organization ([integration.md](integration.md) §2), and a disposable second connection can be switched off with
`POST API/api/connection/disconnect` (§5 of the same page).
