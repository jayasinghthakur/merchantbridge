# ADR-0009: A $0 stack: Groq through an OpenAI-compatible provider, Hugging Face Spaces instead of Fly.io

## Context

The plan (PLAN §2, §5) hosted `apps/api` on Fly.io (one always-on `shared-cpu-1x` Machine, about $2-5 per month)
and ran the playground and evals on the Anthropic API (`claude-haiku-4-5`, evals also on `claude-sonnet-5-5`) from a
workspace with a $15 spend cap. Both need a payment card.

New hard requirement from the owner (2026-10-03): **everything must be free**: no paid Anthropic API, no Fly.io, no
credit card anywhere. The reviewer journey (no-login playground with a live agent, public `/mcp/demo`, real Zoho
OAuth on prod) must still work.

Facts this decision relies on (checked 2026-10-03; free-tier numbers are approximate and change):

- **Groq** free tier needs no card and serves an OpenAI-compatible API; all its models support tool use. About 30
  requests per minute; `llama-3.3-70b-versatile` gets about 1,000 requests and 100K tokens per day.
- **Hugging Face Docker Spaces** build the Dockerfile at the Space repository root, route the public URL
  (`https://<owner>-<space>.hf.space`) to port 7860 unless the README frontmatter sets `app_port`, run containers as
  uid 1000, inject the Space's variables and secrets as environment variables, and give free **CPU basic** hardware
  2 vCPU and 16 GB. The disk is ephemeral, and a free Space sleeps after a period without traffic (about 48 h).
- **Neon** free (no card), **Upstash** free (500K commands per month, no card), **Vercel Hobby** (free,
  non-commercial use only), **Cloudflare Turnstile** (free), **GitHub Actions** (free for public repositories), and
  **Zoho Inventory** (14-day trial, then a Free plan with 1,000 API calls per day).
- **Render** free also runs Docker but sleeps after 15 minutes idle with a 30-50 s cold start.

## Decision

1. **LLM: provider-agnostic engine, Groq by default.** The playground and evals run through an OpenAI-compatible
   provider (`MB_LLM_PROVIDER=openai`, `MB_LLM_BASE_URL` default `https://api.groq.com/openai/v1`, key
   `MB_LLM_API_KEY`, model `MB_PLAYGROUND_MODEL` default `llama-3.3-70b-versatile`). The Anthropic path stays as an
   option (`MB_LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, default `claude-haiku-4-5`) but is paid and off on the
   $0 path. Unset, the provider is `openai` when `MB_LLM_API_KEY` is set, else `anthropic` when `ANTHROPIC_API_KEY`
   is set, else the playground is disabled; it is enabled only with `MB_PLAYGROUND_ENABLED=true` and a key for the
   selected provider. Gemini's OpenAI-compatible endpoint, OpenRouter's free models and a local Ollama work through
   the same setting.
2. **API host: a public Hugging Face Docker Space (CPU basic)** instead of Fly.io. The Space repository is a build
   artifact: `.github/workflows/deploy-hf-space.yml` runs `deploy/hf-space/assemble.sh` (Space card with `sdk: docker`
   and `app_port: 8787`, `apps/api/Dockerfile` as the root `Dockerfile`, the files `/.dockerignore` admits), builds it
   with Docker, and force-pushes it. The image already listens on `$PORT` (8787) on `0.0.0.0` in production and runs
   as the `node` user (uid 1000). Migrations, formerly Fly's `release_command`, are run by the human from their
   machine with `apps/api/scripts/migrate.ts`. A scheduled workflow (`keep-warm.yml`) GETs `/health/live` every 6 h.
   The client-IP source on the Space is `MB_CLIENT_IP_SOURCE=xff-last` (UNVERIFIED until the probe in
   `docs/deploy.md` passes).
3. **Everything else stays on free plans:** Neon (Postgres), Upstash (Redis), Vercel Hobby (`apps/web`), Turnstile,
   GitHub Actions.
4. **Fly.io becomes an optional, paid alternative.** `apps/api/fly.toml` and `deploy-api.yml` stay; the workflow skips
   while `FLY_API_TOKEN` is unset. Render free is the documented fallback if Hugging Face becomes unsuitable.

## Consequences

- **Model quality drops.** Llama 3.3 70B is weaker at multi-step tool use and at refusing write requests than Claude.
  The ≥90% eval gate now runs on `llama-3.3-70b-versatile`, so the published score describes what visitors actually
  see; failures are fixed by sharpening tool descriptions first (the existing eval loop). Claude runs remain possible
  with `pnpm evals -- --provider anthropic` and a paid key.
- **Rate limits replace a spend cap.** Groq's daily token allowance (about 100K for the 70B model) covers only a
  handful of playground questions per day, because each model turn resends the tool schemas and the conversation. The
  cost guards (per-IP limit, Turnstile, daily cap, kill switch) remain; `MB_PLAYGROUND_DAILY_CAP` should be set low
  enough that MerchantBridge's own cap answers before Groq's 429. A full eval run spans more than one day's allowance
  (`--cases` splits it). The `/tools` explorer and `/mcp/demo` need no model and are unaffected.
- **Cold starts are back.** The plan chose Fly's always-warm Machine to avoid them. A free Space sleeps after about
  48 h without traffic (the keep-warm ping makes that rare, as long as GitHub keeps the schedule enabled: it disables
  scheduled workflows after 60 days without repository activity), every deploy restarts the container, and Neon's
  free compute scales to zero. The first MCP call after a sleep can time out; clients retry.
- **Data handling.** Only demo data (FakeZoho) ever reaches the model, because the playground and evals are bound to
  the demo tenant (CLAUDE.md rule 6). That rule is what makes a third-party free model acceptable here.
- **Vercel Hobby is non-commercial**, which fits a take-home demo but not a paid merchant deployment.
- **Provider-agnostic engine is a plus.** The same code can run Groq, Gemini, OpenRouter, Ollama or Claude by changing
  environment variables, and the MCP surface (what Agent Studio-style hosts and reviewers' own Claude clients use) is
  unchanged: `claude mcp add`, the Agent SDK, the Messages API MCP connector and Claude.ai custom connectors all still
  point at `/mcp` and `/mcp/demo`.
- **Unverified until deployed:** the Hugging Face proxy's `X-Forwarded-For` behaviour (per-IP limits), whether the
  Space's readiness check is satisfied by an API that answers 404 on `/`, and where the free Space runs (which decides
  the best Neon and Upstash region).

## Status

Accepted (2026-10-03). Supersedes the hosting row and the LLM parts of PLAN §2 and §5 (Fly.io, the Anthropic
workspace with a $15 cap, Claude models for the playground and the eval gate). The OpenAI-compatible provider is
implemented in `apps/api/src` and `evals/`; the Space deployment is in `deploy/hf-space/` and
`.github/workflows/deploy-hf-space.yml`. Not yet deployed or run against real services.
