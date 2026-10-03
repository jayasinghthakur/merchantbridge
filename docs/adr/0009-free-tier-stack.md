# ADR-0009: A $0 stack: Groq through an OpenAI-compatible provider, Vercel instead of Fly.io

Amended 2026-10-04: the API host is **Vercel Hobby** (one Vercel Function), not a Hugging Face Docker Space, and the
default free model is **`openai/gpt-oss-120b`**, not `llama-3.3-70b-versatile`. Both changes were forced by the
providers; the original decision text is kept below, marked where it no longer holds.

## Context

The plan (PLAN §2, §5) hosted `apps/api` on Fly.io (one always-on `shared-cpu-1x` Machine, about $2-5 per month)
and ran the playground and evals on the Anthropic API (`claude-haiku-4-5`, evals also on `claude-sonnet-5-5`) from a
workspace with a $15 spend cap. Both need a payment card.

New hard requirement from the owner (2026-10-03): **everything must be free**: no paid Anthropic API, no Fly.io, no
credit card anywhere. The reviewer journey (no-login playground with a live agent, public `/mcp/demo`, real Zoho
OAuth on prod) must still work.

Facts this decision relied on (checked 2026-10-03; free-tier numbers are approximate and change):

- **Groq** free tier needs no card and serves an OpenAI-compatible API with tool use. At the time,
  `llama-3.3-70b-versatile` was available to free keys (about 1,000 requests and 100K tokens per day).
- **Hugging Face Docker Spaces** built the Dockerfile at the Space repository root, ran containers as uid 1000 and
  gave free **CPU basic** hardware; a free Space slept after a period without traffic.
- **Neon** free (no card), **Upstash** free (500K commands per month, no card), **Vercel Hobby** (free,
  non-commercial use only), **Cloudflare Turnstile** (free), **GitHub Actions** (free for public repositories), and
  **Zoho Inventory** (14-day trial, then a Free plan with 1,000 API calls per day).
- **Render** free also runs Docker but sleeps after 15 minutes idle with a 30-50 s cold start.

What changed on 2026-10-04, while deploying:

- **Hugging Face** refused the free Docker Space with HTTP 402: "hosting Gradio and Docker Spaces on free cpu-basic
  requires a PRO subscription". PRO is paid, so Spaces no longer meet the requirement.
- **Groq** moved Llama 3.3 70B to Enterprise-only: free keys get HTTP 404 `model_not_found` for
  `llama-3.3-70b-versatile`. `openai/gpt-oss-120b` is available on the free tier and supports tool use.
- **Vercel** blocks a CLI deployment made from inside a git repository unless the commit author is a member of the
  Vercel team ("the commit author doesn't have permission to create deployments for this project").

## Decision

1. **LLM: provider-agnostic engine, Groq by default.** The playground and evals run through an OpenAI-compatible
   provider (`MB_LLM_PROVIDER=openai`, `MB_LLM_BASE_URL` default `https://api.groq.com/openai/v1`, key
   `MB_LLM_API_KEY`, model `MB_PLAYGROUND_MODEL`). The Anthropic path stays as an option (`MB_LLM_PROVIDER=anthropic`,
   `ANTHROPIC_API_KEY`, default `claude-haiku-4-5`) but is paid and off on the $0 path. Unset, the provider is
   `openai` when `MB_LLM_API_KEY` is set, else `anthropic` when `ANTHROPIC_API_KEY` is set, else the playground is
   disabled; it is enabled only with `MB_PLAYGROUND_ENABLED=true` and a key for the selected provider. Gemini's
   OpenAI-compatible endpoint, OpenRouter's free models and a local Ollama work through the same setting.
   - _Original default:_ `llama-3.3-70b-versatile`. **Amended 2026-10-04:** the default for `openai` (playground and
     the gated eval model) is `openai/gpt-oss-120b`; `openai/gpt-oss-20b` and the endpoints above remain a config
     change away.
2. **API host.** _Original:_ a public Hugging Face Docker Space (CPU basic), assembled and force-pushed by a GitHub
   workflow, kept awake by a scheduled ping. **Superseded 2026-10-04:** `apps/api` runs on **Vercel Hobby** as **one
   Vercel Function** (project `merchantbridge-api`). `apps/api/src/vercel.ts` builds the Fastify app once per function
   instance, hands each request to Fastify, waits for the response, then flushes the usage-event buffer;
   `apps/api/scripts/build-vercel.mjs` bundles it with esbuild into the Build Output API (`.vercel/output`,
   `nodejs22.x`, response streaming, `maxDuration` 300, every route to the function). `scripts/deploy-vercel.sh`
   builds both apps locally and deploys them prebuilt from git-free temp folders (which avoids the commit-author
   block); Git-integration auto-deploys are not set up. The Space files (`deploy/hf-space/`,
   `deploy-hf-space.yml`, `keep-warm.yml`, `scripts/setup-deploy.py`) were deleted. Migrations are run by the human
   from their machine with `apps/api/scripts/migrate.ts` against Neon's direct endpoint. The client-IP source is
   `MB_CLIENT_IP_SOURCE=xff-last` (UNVERIFIED until the probes in `docs/deploy.md` §6 pass).
3. **Everything else stays on free plans:** Neon (Postgres), Upstash (Redis), Vercel Hobby (`apps/web`, project
   `merchantbridge-web`), Turnstile (optional), GitHub Actions.
4. **Fly.io stays an optional, paid alternative.** `apps/api/fly.toml` and `deploy-api.yml` stay; the workflow skips
   while `FLY_API_TOKEN` is unset. The Docker image stays for self-hosting on any Docker host (Render free included).

## Consequences

- **Model quality is unmeasured at scale.** `openai/gpt-oss-120b` answered the COD card correctly on prod (one
  `zoho_get_item` call, about 8 s, about 7K input tokens), but the full eval suite has not run on it yet. The ≥90%
  eval gate runs on the free default model, so the published score will describe what visitors actually see;
  failures are fixed by sharpening tool descriptions first. Claude runs remain possible with
  `pnpm evals -- --provider anthropic` and a paid key.
- **Rate limits replace a spend cap.** Groq's free tier limits requests and tokens per minute and per day, per model
  (current numbers: console.groq.com/settings/limits). Each model turn resends the tool schemas and the
  conversation, so the daily allowance covers a limited number of playground questions. The cost guards (per-IP
  limit, optional Turnstile, daily cap, kill switch) remain; production sets `MB_PLAYGROUND_DAILY_CAP=40` so
  MerchantBridge's own cap answers before Groq's 429. A full eval run may need `--cases` splits. The `/tools` explorer
  and `/mcp/demo` need no model and are unaffected.
- **Serverless instead of a container.** No sleeping Space and no keep-warm job, but a new function instance pays a
  cold start, Neon's free compute still scales to zero, a single request (including an SSE stream) is capped at 300 s,
  and nothing may run after a response unless the invocation waits for it (hence the explicit usage-event flush).
  All shared state already lived in Redis and Postgres, so concurrent instances behave as one.
- **Manual deploys.** Deploys are a human running `bash scripts/deploy-vercel.sh`; enabling Git auto-deploys needs the
  owner's GitHub account (`jayasinghthakur`) connected to the Vercel account (`docs/deploy.md` §2).
- **Data handling.** Only demo data (FakeZoho) ever reaches the model, because the playground and evals are bound to
  the demo tenant (CLAUDE.md rule 6). That rule is what makes a third-party free model acceptable here.
- **Vercel Hobby is non-commercial**, which fits a take-home demo but not a paid merchant deployment.
- **Provider-agnostic engine paid off.** Both forced changes were configuration (model id, host), not code paths in
  the tool layer. The MCP surface is unchanged: `claude mcp add`, the Agent SDK, the Messages API MCP connector and
  Claude.ai custom connectors point at `/mcp` and `/mcp/demo`.
- **Still unverified:** Vercel's `X-Forwarded-For` behaviour for the per-IP limits (probes in `docs/deploy.md` §6).
  Resolved by the move: the Space readiness question (the API also answers 200 on `/` now) and the Space region.

## Status

Accepted (2026-10-03). Amended 2026-10-04: API host Hugging Face Space → Vercel Function (Hugging Face now requires
PRO for Docker Spaces); default model `llama-3.3-70b-versatile` → `openai/gpt-oss-120b` (Llama 3.3 70B is
Enterprise-only on Groq). Deployed and verified live on 2026-10-04 (https://merchantbridge-api.vercel.app,
https://merchantbridge-web.vercel.app; Neon, Upstash, Groq). Supersedes the hosting row and the LLM parts of PLAN §2
and §5 (Fly.io, the Anthropic workspace with a $15 cap, Claude models for the playground and the eval gate). Real
Zoho on prod and the full eval run are pending (`docs/STATUS.md`).
