# Deploying MerchantBridge for $0

Step-by-step for the **human** operator. Every service below is used on a free plan that needs no payment card
([ADR-0009](adr/0009-free-tier-stack.md)). Claude prepares the config but never sets secrets: `gh secret`,
`vercel env` and `fly secrets` are denied to it by `.claude/settings.json`, and Hugging Face secrets are entered in
the browser. Never paste secret values into issues, PRs, chats or this file.

**Fast path:** run `python3 scripts/setup-deploy.py` yourself from the repo root. It logs the Neon CLI in through your
browser, applies the migrations, asks for the Upstash URL, Groq key and Hugging Face token with hidden input, creates
the Space with all its secrets and variables, sets the GitHub secret/variables, triggers the Space deploy and waits for
`/health/ready`. Re-run with `--skip-neon --web-url <vercel url>` after the Vercel import, and with `--skip-neon --zoho`
after creating the Zoho PROD client. The sections below are the manual equivalent.

Placeholders used below:

| Placeholder | Meaning                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SPACE`     | the Space id `<owner>/<space>`, e.g. `jayasinghthakur/merchantbridge-api`                                                              |
| `API`       | the Space's app URL `https://<owner>-<space>.hf.space`, e.g. `https://jayasinghthakur-merchantbridge-api.hf.space` (no trailing slash) |
| `WEB`       | the Vercel production URL, e.g. `https://merchantbridge.vercel.app`                                                                    |

Hugging Face derives the app host from the owner and Space names; once the Space runs, open the app in a new tab from
the Space page and use exactly the host it shows.

## Checklist (what you click and create)

1. **Hugging Face:** account → new **Docker** Space (blank, **CPU basic**, **public**) → its variables and secrets
   (§3) → an access token with write access to that Space (§5).
2. **Neon:** free project → pooled and direct connection strings (§1).
3. **Upstash:** free Redis database → `rediss://` URL (§1).
4. **Groq:** free API key (§1).
5. **Cloudflare Turnstile:** widget for the Vercel hostnames → site key and secret key (§1).
6. **Zoho API console:** PROD server-based client with redirect `API/oauth/zoho/callback`, plus a DEV client (§1).
7. **Your machine, once:** generate the two keys (§3) and run the database migrations against Neon (§4).
8. **GitHub** (repo Settings → Secrets and variables → Actions): secret `HF_TOKEN`; variables `HF_SPACE`, `API_URL`
   and (optional) `WEB_URL` (§5). Then run the **Deploy API (Hugging Face Space)** workflow.
9. **Vercel:** import the repo with root `apps/web` and the env vars in §6; then put `WEB` into the Space variables
   `MB_PUBLIC_WEB_URL` / `MB_CORS_ORIGINS` and the Turnstile hostnames.
10. **Verify** (§8), including the client-IP probe, and record the result in `docs/STATUS.md`.

## 0. What runs where, and what it costs

| Piece                      | Service and plan                                                                | Free-tier limits that matter (approximate, checked 2026-10-03)                                                                                                         | Cost   |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/api`                 | **Hugging Face Spaces**, Docker SDK, **CPU basic**                              | 2 vCPU, 16 GB RAM; ephemeral disk; sleeps after a period without traffic (about 48 h; the keep-warm workflow pings every 6 h); the Space must be public                | $0     |
| `apps/web`                 | **Vercel Hobby**                                                                | Non-commercial use only                                                                                                                                                | $0     |
| Postgres                   | **Neon Free**                                                                   | Free-plan storage and compute caps; compute scales to zero when idle, so the first query after idle is slow                                                            | $0     |
| Redis                      | **Upstash Free**                                                                | 500K commands per month                                                                                                                                                | $0     |
| Playground and evals model | **Groq free tier**, `llama-3.3-70b-versatile` through the OpenAI-compatible API | About 30 requests/min; for this model about 1,000 requests and 100K tokens per day, plus a per-minute token limit (exact numbers: the limits page in the Groq console) | $0     |
| Playground bot check       | **Cloudflare Turnstile**                                                        | Free                                                                                                                                                                   | $0     |
| CI, deploys, keep-warm     | **GitHub Actions**, public repository                                           | Free for public repositories; scheduled workflows are disabled after 60 days without repository activity                                                               | $0     |
| Live Zoho leg              | **Zoho Inventory** 14-day trial, then the Free plan                             | 1,000 API calls per day per organization on Free (MerchantBridge uses at most half: the governor's 50% daily share)                                                    | $0     |
| **Total**                  |                                                                                 |                                                                                                                                                                        | **$0** |

Not used on the $0 path: the Anthropic API (paid; only if you set `MB_LLM_PROVIDER=anthropic`), Fly.io (paid; see
[Optional: Fly.io](#optional-flyio-paid)) and Render (free fallback, see [Fallback: Render free](#fallback-render-free)).

### Honest caveats

- **Free-tier rate limits are tight for an agent loop.** A playground question resends the 10 tool schemas (about
  3.4K tokens) and the growing conversation on every model turn, so one question costs very roughly 10-25K Groq
  tokens. At about 100K tokens per day for `llama-3.3-70b-versatile`, expect only a handful of live questions per day
  before Groq answers 429; the `/tools` explorer and `/mcp/demo` need no model and keep working. Consider lowering
  `MB_PLAYGROUND_DAILY_CAP` (default 300 questions per UTC day) so visitors hit MerchantBridge's own "budget used up"
  message first. A full eval run (17 cases) needs more than one day's allowance on this model: split it with
  `--cases` across days ([README](../README.md#evals)). Groq's numbers are approximate and change; check the console.
- **Vercel Hobby is for non-commercial use.** Fine for this take-home demo; a real merchant deployment needs a paid
  plan or another host.
- **The Space can sleep and restarts on every deploy.** After a period without traffic (about 48 h) the next request
  waits for a cold start; MCP clients may time out on that first call and should retry. Each deploy rebuilds and
  restarts the container, cutting open SSE streams. The disk is ephemeral, which is fine: all state is in Neon and
  Upstash.
- **Groq sees what the playground sends.** The playground and evals are bound to the demo tenant and FakeZoho ("Chai
  & Co (DEMO)", fake data) by design, so only demo data reaches the model. Never point a third-party free model at
  real merchant data without reading the provider's current data-retention terms.
- **A smaller model.** Llama 3.3 70B is weaker at multi-step tool use than the Claude models the playground was
  first built on; the ≥90% eval gate runs on Llama so the published score matches what visitors see.
- **Space variables are not secrets.** Anything sensitive goes in **Secrets** (§3). The Space repository itself is
  public (the same code as GitHub; it never contains `.env` files or values).

## 1. Accounts (once)

1. **GitHub:** done: https://github.com/jayasinghthakur/merchantbridge (public, so Actions, secret scanning,
   Dependabot and CodeQL are free).
2. **Hugging Face:** sign up at huggingface.co.
3. **Neon:** create a free project. Copy two connection strings: the **pooled** one (host contains `-pooler`) and the
   **direct** one, both with `sslmode=require`.
4. **Upstash:** create a free Redis database with TLS on; copy the `rediss://…` URL.
5. **Region for Neon and Upstash:** put them close to the API, not to users; every tool call makes several Redis
   round trips. Hugging Face does not let you choose where a free Space runs (US East is commonly reported;
   UNVERIFIED), so pick a US East region (e.g. AWS `us-east-1`) for both, and compare `/health/ready` timings if in
   doubt.
6. **Groq:** at console.groq.com create an API key (free, no card). Groq's API is OpenAI-compatible and its models
   support tool use.
7. **Vercel:** Hobby account connected to the GitHub repo (§6).
8. **Cloudflare Turnstile:** add a widget; hostnames = the Vercel domain(s) the playground runs on. Copy the site key
   and the secret key.
9. **Zoho API console** (`api-console.zoho.in` for an `.in` account): create a **Server-based** client for **PROD**.
   - Homepage URL: `WEB`. Authorized redirect URI: **`API/oauth/zoho/callback`** (exact match, no trailing slash),
     e.g. `https://jayasinghthakur-merchantbridge-api.hf.space/oauth/zoho/callback`.
   - Settings: enable the data centres you serve and "use the same OAuth credentials for all data centers".
   - Keep a separate DEV client (redirect `http://localhost:8787/oauth/zoho/callback`) for local work: Zoho keeps only
     20 refresh tokens per user per client, so local re-consents on the PROD client evict production (see
     "RECONNECT_REQUIRED" in the [runbook](runbook.md)).
   - A Zoho Inventory trial org runs 14 days, then continues on the Free plan (1,000 API calls per day).

## 2. Create the Space

On huggingface.co → **New Space**:

| Field      | Value                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Owner      | you (or your organization)                                                                                            |
| Space name | `merchantbridge-api` (any name; it becomes part of `API`)                                                             |
| SDK        | **Docker**, blank template                                                                                            |
| Hardware   | **CPU basic** (free: 2 vCPU, 16 GB)                                                                                   |
| Visibility | **Public**. A private Space's URL needs a Hugging Face login, so MCP clients and the web app could not reach the API. |

Do not add files by hand. The deploy workflow (§5) force-pushes the whole Space repository on every deploy: the
Space card ([`deploy/hf-space/README.md`](../deploy/hf-space/README.md), with `sdk: docker` and `app_port: 8787`), a
root `Dockerfile` (a copy of [`apps/api/Dockerfile`](../apps/api/Dockerfile)), a copy of
[`.dockerignore`](../.dockerignore) and the workspace files the image needs, assembled by
[`deploy/hf-space/assemble.sh`](../deploy/hf-space/assemble.sh). Hugging Face builds that Dockerfile and routes the
Space's URL to port 8787.

## 3. Space variables and secrets

Space → **Settings** → **Variables and secrets**. Use **New secret** for every row marked _secret_ (stored encrypted,
not shown again) and **New variable** for the rest (treat variables as public). Hugging Face injects both into the
container as environment variables. Names come from [`apps/api/src/config.ts`](../apps/api/src/config.ts).

| Name                     | Kind     | Value                                                                                                                                              |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`               | variable | `production` (the image default; production refuses to boot without `DATABASE_URL` and `REDIS_URL`)                                                |
| `PORT`                   | variable | `8787`. Must equal `app_port` in the Space card; the image already defaults to it.                                                                 |
| `DATABASE_URL`           | secret   | Neon **pooled** string (host contains `-pooler`, keep `sslmode=require`). The client disables prepared statements for the pooler.                  |
| `DATABASE_URL_UNPOOLED`  | secret   | Optional. Neon **direct** string; only the migration script uses it (§4), so it can also stay on your machine only.                                |
| `REDIS_URL`              | secret   | Upstash `rediss://…` URL (TLS).                                                                                                                    |
| `MB_PUBLIC_API_URL`      | variable | `API`. Its host joins the MCP Host allow-list and it feeds the demo URL and OAuth links.                                                           |
| `MB_PUBLIC_WEB_URL`      | variable | `WEB` (CORS and OAuth redirects).                                                                                                                  |
| `MB_CORS_ORIGINS`        | variable | Extra browser origins, comma-separated; one `*` allowed, e.g. `https://merchantbridge-*-<team>.vercel.app` for previews. `WEB` is always included. |
| `MB_ALLOWED_HOSTS`       | variable | Optional. Extra API hostnames for the Host check; leave empty (the Space host comes from `MB_PUBLIC_API_URL`).                                     |
| `MB_CLIENT_IP_SOURCE`    | variable | `xff-last` (expected for Hugging Face; UNVERIFIED until the §8 probe passes). See below.                                                           |
| `MB_ENCRYPTION_KEY`      | secret   | base64 of exactly 32 random bytes (AES-256-GCM key for refresh tokens). See below.                                                                 |
| `MB_STATE_SECRET`        | secret   | ≥ 32 bytes, HMAC key for OAuth `state`. See below.                                                                                                 |
| `MB_CONNECT_INVITE_CODE` | secret   | Any hard-to-guess code you hand to reviewers and merchants.                                                                                        |
| `ZOHO_CLIENT_ID`         | secret   | PROD client.                                                                                                                                       |
| `ZOHO_CLIENT_SECRET`     | secret   | PROD client.                                                                                                                                       |
| `ZOHO_REDIRECT_URI`      | variable | `API/oauth/zoho/callback`, identical to the Zoho console entry.                                                                                    |
| `MB_LLM_PROVIDER`        | variable | `openai` (any OpenAI-compatible endpoint; Groq here).                                                                                              |
| `MB_LLM_BASE_URL`        | variable | `https://api.groq.com/openai/v1` (also the default).                                                                                               |
| `MB_LLM_API_KEY`         | secret   | The Groq API key.                                                                                                                                  |
| `MB_PLAYGROUND_MODEL`    | variable | `llama-3.3-70b-versatile` (also the default for `openai`).                                                                                         |
| `MB_PLAYGROUND_ENABLED`  | variable | `true` to enable the playground; `false` is the kill switch.                                                                                       |
| `TURNSTILE_SITE_KEY`     | variable | Turnstile site key (public by design: served to browsers via `/api/status`).                                                                       |
| `TURNSTILE_SECRET_KEY`   | secret   | Turnstile secret key.                                                                                                                              |
| `MB_METRICS_TOKEN`       | secret   | Optional. Bearer token for the Prometheus scrape; without it `/metrics` answers 404 in production.                                                 |

Optional, with defaults: `LOG_LEVEL` (`info`), `MB_PLAYGROUND_DAILY_CAP` (`300` questions per UTC day; see the
caveats in §0), `MB_TRUSTED_EGRESS_CIDRS` (comma-separated CIDRs, e.g. Anthropic's published MCP egress ranges,
whose callers share one larger `/mcp/demo` bucket). `HOST` needs no value: production always binds `0.0.0.0`.

**Which model runs** (the LLM contract in `apps/api/src`):

- `MB_LLM_PROVIDER` is `openai` or `anthropic`. Unset, it is `openai` when `MB_LLM_API_KEY` is set, else
  `anthropic` when `ANTHROPIC_API_KEY` is set, else the playground is disabled.
- `openai` talks to `MB_LLM_BASE_URL` (default `https://api.groq.com/openai/v1`) with `MB_LLM_API_KEY`. Other
  OpenAI-compatible endpoints work the same way: Gemini's OpenAI-compatible endpoint, OpenRouter's free models, or a
  local Ollama (`http://localhost:11434/v1`, local development only).
- `MB_PLAYGROUND_MODEL` defaults to `llama-3.3-70b-versatile` for `openai` and `claude-haiku-4-5` for `anthropic`.
- The playground is enabled when `MB_PLAYGROUND_ENABLED=true` **and** the selected provider has a key.
- `ANTHROPIC_API_KEY` is optional and paid; leave it unset on the $0 path.

`/connect` stays disabled unless all six of `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`,
`MB_ENCRYPTION_KEY`, `MB_STATE_SECRET` and `MB_CONNECT_INVITE_CODE` are set.

**`MB_CLIENT_IP_SOURCE`** decides which address the per-IP limits (`/mcp/demo`, explorer, playground, OAuth start,
failed-key lookups) and Turnstile see: `socket` (the TCP peer), `fly-client-ip` (Fly's edge header) or `xff-last`
(the right-most `X-Forwarded-For` entry, i.e. the address the last proxy saw). On a Space the TCP peer is Hugging
Face's proxy, so `socket` would put every visitor in one bucket; `xff-last` is the expected value, on the assumption
that Hugging Face's proxy appends the real client address to `X-Forwarded-For`. That assumption is **UNVERIFIED**
until the probe in §8 passes on the deployed Space. Unset, it defaults to `socket` (or `fly-client-ip` on Fly).

> **Never set `MB_DEV_FAKE_ZOHO`** (not as a variable, not as a secret, not in Vercel). It is the local fake-live
> mode. The server refuses to start with `MB_DEV_FAKE_ZOHO=true` and `NODE_ENV=production` (exit 1, "is a local
> development mode and is refused"), and CI's image smoke test checks that refusal.

**Generate the two keys** (into your password manager first: Space secrets cannot be read back). Start the line with
a space to keep it out of shell history (bash `HISTCONTROL=ignorespace`, zsh `setopt HIST_IGNORE_SPACE`):

```sh
 openssl rand -base64 32   # MB_ENCRYPTION_KEY: exactly 32 bytes, base64
 openssl rand -base64 48   # MB_STATE_SECRET: 64 characters (>= 32 bytes required)
```

`MB_ENCRYPTION_KEY` must never change once a merchant has connected: every stored refresh token becomes
undecryptable and all merchants must reconnect. `MB_STATE_SECRET` can be rotated at any time (only in-flight consents
fail).

Changes to variables and secrets apply when the container restarts; if the Space does not restart by itself, use
**Restart** in the Space settings. The Vercel URL is known only after §6: deploy the API first with a placeholder
`MB_PUBLIC_WEB_URL`, then fix it.

## 4. Database migrations (by hand, from your machine)

A Space has no release phase, and the server never migrates on boot (Drizzle's migrator takes no lock, so concurrent
runners could race). Apply `packages/db/drizzle/*.sql` with
[`apps/api/scripts/migrate.ts`](../apps/api/scripts/migrate.ts) **before the first deploy**, and again **before
merging any change that adds a migration** (they are forward-only and must land before the code that needs them):

```sh
pnpm i
 export DATABASE_URL_UNPOOLED='postgresql://…'   # Neon DIRECT string; leading space keeps it out of history
pnpm --filter @mb/api exec tsx scripts/migrate.ts
unset DATABASE_URL_UNPOOLED
```

It reads `DATABASE_URL_UNPOOLED` when set, else `DATABASE_URL`, never logs the URL, logs `migrations applied` and
exits 0. Re-running is safe: only pending migrations are applied. It is run by you, never by Claude or CI (no database
credentials live in GitHub).

## 5. Deploy to the Space (GitHub Actions)

1. **Hugging Face token:** avatar → **Settings** → **Access Tokens** → **Create new token**. Prefer a
   **fine-grained** token with write access to this one Space's repository only; a classic **Write** token also
   works but reaches every repo you own. Copy it once.
2. **GitHub:** repo → **Settings** → **Secrets and variables** → **Actions**:
   - **Secrets** tab: `HF_TOKEN` = the token.
   - **Variables** tab: `HF_SPACE` = `SPACE` (e.g. `jayasinghthakur/merchantbridge-api`); `API_URL` = `API` (used
     by the keep-warm workflow); optional `WEB_URL` = `WEB` (linked from the Space card).
3. **Actions** → **Deploy API (Hugging Face Space)** → **Run workflow** (or push to `main`).

[`deploy-hf-space.yml`](../.github/workflows/deploy-hf-space.yml) runs on pushes to `main` that touch `apps/api`,
`packages`, the root manifests and lockfile, `.dockerignore`, `deploy/hf-space` or the workflow itself. It assembles
the Space into a temp directory, **builds it with Docker first** (nothing is pushed if the image does not build, and
it checks the container runs as uid 1000), then force-pushes one commit to `https://huggingface.co/spaces/SPACE`.
The token reaches git only through a credential helper's environment, never in a URL or the log. Without `HF_TOKEN`
or `HF_SPACE` the job posts a "Space deploy skipped" notice and succeeds.

Hugging Face then builds the image (several minutes the first time; the Space page's **Logs** show the build and the
container) and starts it. Expect `merchantbridge api listening` with `port: 8787`, `storage: "postgres"` and
`kv: "redis"` in the container log (the same line names the playground provider and model).

**Dry run locally** (no Docker needed, nothing is pushed):

```sh
bash deploy/hf-space/assemble.sh /tmp/mb-space && (cd /tmp/mb-space && find . -type f | sort)
```

It refuses a non-empty output directory, copies only files git knows about that `.dockerignore` lets into the image,
and fails if a `COPY` source is missing or if an env file, test, doc or dev config slipped in.

**Troubleshooting the first start:**

- Space stuck in "Building": open the build log; the CI `docker` job builds the same Dockerfile and should be green.
- Container exits with `Production requires: DATABASE_URL, REDIS_URL` or `Invalid environment configuration`: a
  secret or variable is missing or malformed (§3).
- 403 on every route except `/health/*`: the request host is not in the allow-list; `MB_PUBLIC_API_URL` must be
  exactly `API`.
- The Space's **App** tab shows a JSON 404: expected, the API has no home page; use `API/health/ready`.
- Space stuck in "Starting" while the log shows `merchantbridge api listening`: check that `PORT` and `app_port` are
  both 8787. UNVERIFIED: if Hugging Face's readiness check needs a 2xx on `/`, the API (404 on `/`) would need a small
  `GET /` route in `apps/api`.

## 6. Vercel (apps/web)

Import the GitHub repo as a new project (Hobby), then in **Settings → Build and Deployment**:

| Setting          | Value                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root Directory   | `apps/web` (the build still needs `packages/core` and the root lockfile, so keep the option that includes files outside the Root Directory enabled) |
| Framework Preset | Next.js                                                                                                                                             |
| Install Command  | Override: `pnpm install --frozen-lockfile --filter "@mb/web..."` (runs in `apps/web`; pnpm installs at the workspace root)                          |
| Build Command    | default (`pnpm run build` = `next build`) or override `next build`                                                                                  |
| Output Directory | default                                                                                                                                             |
| Node.js Version  | 24.x                                                                                                                                                |

**Environment variables** (Production and Preview; set in the dashboard, human only):

| Name                           | Value                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1`. **Required.** Vercel's built-in pnpm is 6-10; with Corepack it uses root `packageManager` (`pnpm@12.8.1`), which the lockfile needs. |
| `NEXT_PUBLIC_API_URL`          | `API`, the Space URL (no trailing slash)                                                                                                  |
| `NEXT_PUBLIC_REPO_URL`         | `https://github.com/jayasinghthakur/merchantbridge`                                                                                       |

`NEXT_PUBLIC_*` values are inlined at build time: redeploy after changing them. No `vercel.json` is needed. If the
build log shows Corepack failing to start pnpm 12, an untested fallback is the install command
`npx -y pnpm@12.8.1 install --frozen-lockfile --filter "@mb/web..."`.

Afterwards make the API agree with the web origins: Space variables `MB_PUBLIC_WEB_URL` = `WEB`, `MB_CORS_ORIGINS` =
the preview pattern (§3); add the same hostnames to the Turnstile widget; set the GitHub variable `WEB_URL`. Vercel
deploys `apps/web` itself through its Git integration (previews on PRs, production on `main`). Hobby is for
non-commercial use (§0).

## 7. Keep the Space awake

[`keep-warm.yml`](../.github/workflows/keep-warm.yml) runs every 6 hours (and on demand) and GETs `API/health/live`
until it answers `{"ok":true}` (up to ~10 minutes, which covers a cold start). It reads the `API_URL` repository
variable and skips without it. `/health/live` touches neither Neon nor Upstash, so the pings cost no database compute
and no Redis commands.

- GitHub runs schedules only from the default branch and **disables scheduled workflows in a public repository after
  60 days without repository activity**. If that happens, re-enable it on the Actions tab (or push a commit).
- An external free uptime monitor on `API/health/live` is a reasonable second line; keep it on `/health/live`, not
  `/health/ready` (which spends Upstash commands and wakes Neon).

## 8. Verify production

Run after the first deploy and after any change to proxies, limits or the web build. `/verify-prod API WEB` in Claude
Code runs the read-only parts of this list.

**1. Health and storage.**

```sh
curl -sS API/health/live          # {"ok":true}
curl -sS API/health/ready
# 200 {"ok":true,"storage":"postgres","kv":"redis","checks":{"kv":true,"store":true},"version":"0.1.0"}
curl -sS -o /dev/null -w '%{http_code}\n' API/metrics    # 404 without MB_METRICS_TOKEN, 401 with it but no bearer
```

`storage: "memory"` or `kv: "memory-kv"` would mean a missing secret (production refuses to boot without
`DATABASE_URL`/`REDIS_URL`, so check the Space's container log).

**2. MCP over the wire (Inspector CLI).** Expect the 10 tools in alphabetical order, the same list as
[`mcp-tools.json`](mcp-tools.json):

```sh
npx @modelcontextprotocol/inspector --cli API/mcp/demo --transport http --method tools/list
```

**3. Python client** (standard library only):

```sh
MB_MCP_URL=API/mcp/demo python3 examples/python/mcp_demo_client.py
```

**4. Client-IP probes (UNVERIFIED until run on the Space).** With `MB_CLIENT_IP_SOURCE=xff-last`, the per-IP limits
rely on Hugging Face's proxy appending the address it saw to `X-Forwarded-For`, so a client-sent value never ends
up right-most (see `resolveClientIp` in [`apps/api/src/http-util.ts`](../apps/api/src/http-util.ts)).

_(a) Spoofing._ From one machine, send 61 requests to `/mcp/demo`, each claiming a different client IP:

```sh
for i in $(seq 1 61); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST API/mcp/demo \
    -H "X-Forwarded-For: 198.51.100.$i" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
done | sort | uniq -c
```

- **Pass:** at least one `429` (the limit is 60 per minute per caller IP; `60 200` + `1 429` when the run fits in one
  minute window). The window is fixed per minute, so a run that straddles a minute boundary can show 61 `200`s: run it
  again immediately.
- **Fail:** 61 `200`s on two consecutive runs means the right-most entry is client-controlled. Set the Space variable
  `MB_CLIENT_IP_SOURCE=socket` (every caller then shares one bucket: safe but strict) and record it in
  `docs/STATUS.md`.

_(b) Shared bucket._ Right after a run of (a) that ended in `429`, send one request from a **different network** (a
phone hotspot, another machine):

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST API/mcp/demo -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- **Pass:** `200` (each visitor has their own bucket).
- **Fail:** `429` means the right-most entry is a Hugging Face internal address shared by everyone, so the per-IP
  limits act as one global limit (safe, but strict for reviewers). Record it in `docs/STATUS.md`.

Wait a minute afterwards: the probe uses up this host's `/mcp/demo` bucket.

**5. Real-stack browser suite** (no mocks; the specs discover the API origin from the deployed bundle's own requests):

```sh
PLAYWRIGHT_BASE_URL=WEB pnpm --filter @mb/web exec playwright test -c playwright.real.config.ts
```

It asserts the live tool count, the docs page's demo URL answering `tools/list`, the explorer running `zoho_get_item`
and the code-44 fault, the connect and playground states, and writes screenshots at 390 and 1440 px in light and dark
to `apps/web/e2e-real/screenshots/` (7 behavioural + 28 visual checks). With connect and the playground enabled on
prod, those two specs check the enabled state and make no model call. Do not run it within a minute of the probe.

**6. One playground card** on `WEB/playground` (spends Groq quota): at least one tool step, then an answer.

**7. One live tenant.** Connect the Zoho trial org at `WEB/connect` with the invite code; then
`zoho_get_connection_status` over `API/mcp` with the key returns the organization ([integration.md](integration.md)
§2), and a disposable second connection can be switched off with `POST API/api/connection/disconnect` (§5 there).

## 9. Operating it

- **Kill switch:** Space variable `MB_PLAYGROUND_ENABLED=false` (restart the Space if it does not restart by itself;
  `/mcp/demo` and `/tools` keep working). Every other failure mode: [runbook](runbook.md).
- **Rollback:** revert the commit on `main` (the workflow redeploys), or run the deploy workflow from an older tag or
  branch ("Use workflow from" on the Run workflow form; the workflow file must exist at that ref). Migrations are
  forward-only; a rollback across a schema change needs a compatible schema.
- **Logs:** the Space page's **Logs** (build and container). Logs are not kept by MerchantBridge; audit data is in
  `usage_events` (Postgres).
- **Rotate the Groq key:** create a new key in the Groq console, replace the Space secret `MB_LLM_API_KEY`, restart,
  check one playground card, then delete the old key ([runbook](runbook.md)).
- **One container is the design.** The governor, token cache and limits live in Redis (shared), and migrations run
  only from your machine.

## Optional: Fly.io (paid)

[`apps/api/fly.toml`](../apps/api/fly.toml) and [`deploy-api.yml`](../.github/workflows/deploy-api.yml) are kept as a
paid alternative (Fly needs a card and bills for the always-on Machine). The workflow runs on the same pushes and
only posts a "Fly deploy skipped" notice while the `FLY_API_TOKEN` secret is unset, so it costs nothing to leave in
place. To use it instead of the Space: `fly apps create <app>` (and set `app` in `fly.toml`); set the same secrets as
§3 with `fly secrets set --stage -a <app> …` (human only; leave `MB_CLIENT_IP_SOURCE` unset, it defaults to
`fly-client-ip` on Fly); `fly deploy . --config apps/api/fly.toml --remote-only --ha=false` from the repo root (its
`release_command` runs the migrations); for CD add the secret `FLY_API_TOKEN` (from
`fly tokens create deploy -a <app> -x 8760h`) and the variable `FLY_API_URL` (`https://<app>.fly.dev`, for the
post-deploy health check). Run probe 4(a) with the header `Fly-Client-IP` instead of `X-Forwarded-For`; on failure set
`MB_CLIENT_IP_SOURCE=socket`.

## Fallback: Render free

Not configured in this repo. Render's free web services also run a Dockerfile (here: `apps/api/Dockerfile`, build
context = repo root) but sleep after 15 minutes without traffic and take roughly 30-50 s to wake, which MCP clients
and SSE streams notice. Migrations would run by hand (§4), and the client-IP source and probe would need re-checking
for Render's proxy.
