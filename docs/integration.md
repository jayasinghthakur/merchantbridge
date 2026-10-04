# Integration: merchant onboarding in 10 minutes

Who this is for: a merchant (or the FDE helping them) who wants their AI agents (Claude Code, the Claude Agent SDK,
Claude.ai or any other MCP host) to read Zoho Inventory. The result
is one read-only connection per Zoho organization, shared by every agent the merchant runs through one API key (v1
issues exactly one key per connect).

Placeholders: `API` = the MerchantBridge API origin, `WEB` = the site. On the hosted deployment they are
`https://merchantbridge-api.vercel.app` and `https://merchantbridge-web.vercel.app`; the public demo MCP endpoint is
`https://merchantbridge-api.vercel.app/mcp/demo`. Self-hosters use their own origins (no trailing slash).

## 0. Before you start (1 min)

- A Zoho Inventory organization and a Zoho user who can approve API access for it.
- An invite code (connect is invite-gated during the pilot).
- Want to try first without Zoho? Skip to step 3 and use `https://merchantbridge-api.vercel.app/mcp/demo` (fake
  "Chai & Co (DEMO)" data, no key).
- Hosted deployment status (2026-10-04): the demo endpoint is live, but `WEB/connect` reports `connect_disabled`
  until the production Zoho client is configured ([STATUS](STATUS.md)); steps 1-2 need that, or your own deployment
  ([Self-host](#self-host)).

## 1. Connect Zoho (3 min)

1. Open `WEB/connect`, enter the invite code, pick your Zoho data center (India, US, EU, Australia, Japan, Canada,
   Saudi Arabia; UK, China, UAE and Singapore are not supported because Zoho documents no Inventory API host /
   accounts server pair for them).
2. Zoho shows the consent screen with **eight READ-only scopes** (settings, items, sales orders, invoices, contacts,
   packages, shipment orders, customer payments). Approve.
3. MerchantBridge connects the Zoho user's **default organization** (the first one if none is marked default). There is
   no organization picker yet; to connect another organization, make it the default in Zoho first.
4. You land on `WEB/connect/success` with a key `mb_live_…`. **It is shown once.** It travels in the URL fragment,
   which browsers never send to servers, so it is not in any log. Copy it into your secret manager.

What happened: MerchantBridge created a tenant for this organization, stored an encrypted Zoho refresh token for it
and minted one key (only its SHA-256 hash is stored). Zoho tokens never leave the server; agents only ever hold the
`mb_live_` key. **Connect each organization once and share the key across agent hosts:** every connect creates a
new tenant, key and Zoho refresh token. Tenants of one organization share one rate budget (the governor is keyed by
organization, `zoho:<dc>:<org>`), so a second connect does not raise your limits; it only adds another refresh token
toward Zoho's 20-per-user cap and another key to retire ([ADR-0008](adr/0008-tenant-per-connect-and-disconnect.md)).
If a connect fails after Zoho issued a refresh token, MerchantBridge revokes that token before showing the error.

## 2. Check it (30 s)

```sh
curl -s -X POST API/mcp \
  -H "Authorization: Bearer $MB_API_KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"zoho_get_connection_status","arguments":{}}}'
```

Expect your organization name, data center, plan, the read scopes requested at connect (`scopes_requested`; Zoho
does not report grants) and `budget_remaining_today`. Or use the Inspector:
`npx @modelcontextprotocol/inspector --cli API/mcp --transport http --method tools/list --header "Authorization: Bearer $MB_API_KEY"`
(the `--header` flag spelling for the Inspector CLI is UNVERIFIED; the curl above is authoritative).

## 3. Add it to your agent (2 min per host)

Use the server name `merchantbridge` everywhere so tools appear as `mcp__merchantbridge__zoho_*`.

**Claude Code**

```sh
claude mcp add --transport http merchantbridge API/mcp --header "Authorization: Bearer $MB_API_KEY"
# demo, no key (hosted):
claude mcp add --transport http mb-demo https://merchantbridge-api.vercel.app/mcp/demo
```

Then `/mcp` inside a session should show the server connected and its tools.

**Claude Agent SDK (TypeScript)** — option names from the Agent SDK docs (not vendored in this repo):

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const msg of query({
  prompt: 'Is CHAI-250 in stock in Bengaluru, and at what price?',
  options: {
    mcpServers: {
      merchantbridge: {
        type: 'http',
        url: 'API/mcp',
        headers: { Authorization: `Bearer ${process.env.MB_API_KEY}` },
      },
    },
    allowedTools: ['mcp__merchantbridge__*'],
  },
})) {
  /* stream messages */
}
```

Python: `ClaudeAgentOptions(mcp_servers={"merchantbridge": {"type": "http", "url": "API/mcp", "headers": {...}}},
allowed_tools=["mcp__merchantbridge__*"])` (not run here). To see the raw wire from Python with only the standard
library, [`examples/python/mcp_demo_client.py`](../examples/python/mcp_demo_client.py) lists the tools and looks up a
SKU: `MB_MCP_URL=API/mcp MB_API_KEY=mb_live_… python3 examples/python/mcp_demo_client.py` (without `MB_API_KEY` it
uses `API/mcp/demo`).

**Messages API (MCP connector beta)** — Anthropic calls the endpoint for you:

```ts
const res = await anthropic.beta.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  betas: ['mcp-client-2025-11-20'],
  mcp_servers: [
    {
      type: 'url',
      url: 'API/mcp',
      name: 'merchantbridge',
      authorization_token: process.env.MB_API_KEY,
    },
  ],
  tools: [{ type: 'mcp_toolset', mcp_server_name: 'merchantbridge' }],
  messages: [{ role: 'user', content: 'Which invoices are unpaid and due this week?' }],
});
```

Both `mcp_servers` and the matching `mcp_toolset` are required. Details: [`notes/anthropic-mcp.md`](notes/anthropic-mcp.md) §7.

**Claude.ai** — add a custom connector with URL `https://merchantbridge-api.vercel.app/mcp/demo` (or your own
`API/mcp/demo`) and no sign-in. This works for the demo only: live
tenants need OAuth on the MCP leg, which is Tier 3 (ADR-0004). Menu wording in Claude.ai is not documented here.

**Agent Studio-style platforms** — any host that accepts a remote Streamable HTTP MCP server with a bearer header:
URL `API/mcp`, header `Authorization: Bearer mb_live_…`.

## 4. First questions to ask (1 min)

- "Check the MerchantBridge connection status."
- "Is <SKU> in stock in <warehouse>, and at what price?"
- "Which invoices are unpaid and due in the next 7 days?"
- "Find the invoice and order for Razorpay payment pay_…"

Read-only: requests to cancel, edit or email are refused by design ([agent-capabilities.md](agent-capabilities.md)).

## 5. Disconnect, rotate, revoke

**Disconnect (the merchant's off switch).** Call it with the key you want to retire:

```sh
curl -X POST API/api/connection/disconnect -H "Authorization: Bearer $MB_API_KEY"
# 200 {"revoked_locally":true,"revoked_at_zoho":true,"had_connection":true}
```

In this order it revokes the Zoho refresh token at Zoho, drops the cached access token, marks the connection revoked
and revokes the key. If Zoho cannot be reached, everything local still happens and `revoked_at_zoho` is `false`
(the merchant can finish the job under Zoho Accounts -> Connected Apps). Afterwards the key gets HTTP 401 on `/mcp`
and on a second disconnect. Limits: 5 disconnects per key per minute; only `POST` (other methods answer 405). The
`/docs` page shows the same command with your API host filled in.

**Rotate a key.** There is no "mint another key" endpoint in v1. Connect again at `WEB/connect` (you get a new
tenant and a new key), switch every agent host to the new key, then disconnect with the **old** key so its refresh
token and connection are revoked too.

**Merchant-side revoke at Zoho.** Removing MerchantBridge under Zoho Accounts -> Connected Apps makes tool calls
return `RECONNECT_REQUIRED` once Zoho rejects the token. The key itself stays valid until disconnected: reconnect for a
new key, then disconnect the old one.

**Re-consent sparingly.** Zoho keeps at most 20 refresh tokens per user per client and silently drops the oldest, so
repeated connects can disable an older connection ([runbook](runbook.md)).

## Self-host

**Local demo, no credentials (2 min):**

```sh
pnpm i
pnpm dev:api   # Fastify on http://localhost:8787, /mcp/demo on FakeZoho, in-memory stores and Kv
pnpm dev:web   # Next.js on http://localhost:3000
claude mcp add --transport http mb-demo http://localhost:8787/mcp/demo
```

The explorer at `/tools` works without any key. The playground needs a model key and `MB_PLAYGROUND_ENABLED=true`
in the environment of `pnpm dev:api` (apps/api loads no `.env` file): `MB_LLM_API_KEY` for the free default (Groq's
OpenAI-compatible API, `openai/gpt-oss-120b`; `MB_LLM_BASE_URL` for any other OpenAI-compatible endpoint), or
`ANTHROPIC_API_KEY` with `MB_LLM_PROVIDER=anthropic` (paid). Without the Zoho
variables below, `/oauth/zoho/start` redirects to `/connect/error?reason=connect_disabled`.

**Local live leg against a fake Zoho (2 min):** `pnpm dev:api:fake-live` (`MB_DEV_FAKE_ZOHO=true`) runs steps 1-5 of
this page locally with no credentials: it seeds a tenant "Local dev merchant" connected to an in-process FakeZoho
organization, prints its `mb_live_` key with ready-to-paste `/mcp` and disconnect commands, and serves a fake Zoho
consent page so `/connect` (invite code `local-dev`, data center India) completes and mints a new key. Missing Zoho
client, vault, state and invite variables get ephemeral dev-only values; Zoho Accounts and the IN Inventory API are
answered in-process and any other outbound host is refused. It is refused with `NODE_ENV=production` or with
`DATABASE_URL`/`REDIS_URL` set. Details: [README](../README.md#fake-live-mode-the-authenticated-leg-without-zoho).

**Your own deployment (live Zoho):**

1. Zoho API console (`api-console.zoho.<your dc>`): create a **Server-based** client; redirect URI
   `API/oauth/zoho/callback`; Settings -> enable the data centers you serve and select "use the same OAuth credentials
   for all data centers". Create a second client for local development so local re-consents cannot evict production
   tokens.
2. Postgres (Neon or any) and Redis (Upstash or any); production refuses to start without `DATABASE_URL` and
   `REDIS_URL`. Apply `packages/db/drizzle/*.sql` with
   `DATABASE_URL_UNPOOLED=... pnpm --filter @mb/api exec tsx scripts/migrate.ts` (Neon's direct string; plain
   `DATABASE_URL` elsewhere), by hand before each deploy that adds a migration (on Fly it is the `release_command`).
3. Environment (names from `apps/api/src/config.ts`):

| Variable                                                                  | Purpose                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MB_PUBLIC_API_URL`, `MB_PUBLIC_WEB_URL`                                  | public origins; API host is added to the MCP Host allow-list                                                                                                                                     |
| `MB_ALLOWED_HOSTS`, `MB_CORS_ORIGINS`                                     | extra hostnames for the Host check; browser origins for `/api/*`                                                                                                                                 |
| `DATABASE_URL`, `REDIS_URL`                                               | stores and governor/cache/locks                                                                                                                                                                  |
| `MB_ENCRYPTION_KEY`                                                       | base64 of 32 random bytes (`openssl rand -base64 32`); encrypts refresh tokens                                                                                                                   |
| `MB_STATE_SECRET`                                                         | HMAC key for OAuth `state`                                                                                                                                                                       |
| `MB_CONNECT_INVITE_CODE`                                                  | gate for `/connect`                                                                                                                                                                              |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`               | the PROD Zoho client                                                                                                                                                                             |
| `MB_LLM_PROVIDER`, `MB_LLM_BASE_URL`, `MB_LLM_API_KEY`                    | playground and evals model: `openai` (any OpenAI-compatible endpoint; default Groq's free tier) or `anthropic`; see [deploy.md](deploy.md#3-environment-variables-merchantbridge-api-production) |
| `ANTHROPIC_API_KEY`                                                       | optional, paid: only with `MB_LLM_PROVIDER=anthropic`                                                                                                                                            |
| `MB_PLAYGROUND_ENABLED`, `MB_PLAYGROUND_MODEL`, `MB_PLAYGROUND_DAILY_CAP` | playground switch, model (default `openai/gpt-oss-120b` for `openai`), questions per UTC day                                                                                                     |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`                              | bot check on the first playground message                                                                                                                                                        |
| `MB_TRUSTED_EGRESS_CIDRS`                                                 | CIDRs (e.g. Anthropic MCP egress) that share a larger `/mcp/demo` bucket                                                                                                                         |
| `MB_CLIENT_IP_SOURCE`                                                     | `socket`, `fly-client-ip` (default on Fly) or `xff-last` (Vercel); source of the caller IP for per-IP limits                                                                                     |
| `MB_METRICS_TOKEN`                                                        | bearer token for `/metrics` (404 in production without it)                                                                                                                                       |

`/connect` is disabled unless all Zoho, encryption, state and invite variables are set.

4. Deploy `apps/api` (one Vercel Function on Vercel Hobby; the Docker image or Fly.io are optional alternatives)
   and `apps/web` (Vercel Hobby) with `bash scripts/deploy-vercel.sh`; the full $0 procedure is
   [deploy.md](deploy.md). Verify `API/health/ready`, then repeat steps 1-3 above against your URLs.

## Seeding your own trial org (demo data)

`scripts/seed-zoho.py` fills an empty Zoho Inventory trial organization with the same demo story the public demo uses
(items such as CHAI-250, customers including Rohan Mehta with voided orders, sales orders with Delhivery/Blue Dart
shipments, invoices due this week and overdue, and payments referenced `pay_DEMO8xK2`, `order_DEMO7Hk2` and a UPI UTR).
It is the only code in the repository that writes to Zoho: it is run by the org owner, with a separate 10-minute
Self Client code (`python3 scripts/seed-zoho.py --print-scopes` prints the scope string), asks for the org name before
writing, and skips records that already exist, so re-running is safe. The connector itself never writes.
`--dry-run` prints every planned request without network access; `--self-test` runs the flow against a local fake.
