# Integration: merchant onboarding in 10 minutes

Who this is for: a merchant (or the FDE helping them) who wants their Claude agents to read Zoho Inventory. The result
is one read-only connection, shared by every agent the merchant runs, with one API key per agent host.

Placeholders: `API` = the MerchantBridge API origin (e.g. `https://<app>.fly.dev`), `WEB` = the site.

## 0. Before you start (1 min)

- A Zoho Inventory organization and a Zoho user who can approve API access for it.
- An invite code (connect is invite-gated during the pilot).
- Want to try first without Zoho? Skip to step 3 and use `API/mcp/demo` (fake "Chai & Co (DEMO)" data, no key).

## 1. Connect Zoho (3 min)

1. Open `WEB/connect`, enter the invite code, pick your Zoho data center (India, US, EU, Australia, Japan, Canada,
   Saudi Arabia; UK and China are not supported because Zoho documents no Inventory API host / accounts server for
   them).
2. Zoho shows the consent screen with **eight READ-only scopes** (settings, items, sales orders, invoices, contacts,
   packages, shipment orders, customer payments). Approve.
3. Pick the organization if you have several.
4. You land on `WEB/connect/success` with a key `mb_live_…`. **It is shown once.** It travels in the URL fragment,
   which browsers never send to servers, so it is not in any log. Copy it into your secret manager.

What happened: MerchantBridge stored an encrypted Zoho refresh token for this organization. Zoho tokens never leave
the server; agents only ever hold the `mb_live_` key.

## 2. Check it (30 s)

```sh
curl -s -X POST API/mcp \
  -H "Authorization: Bearer $MB_API_KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"zoho_get_connection_status","arguments":{}}}'
```

Expect your organization name, data center, plan, granted scopes and `budget_remaining_today`. Or use the Inspector:
`npx @modelcontextprotocol/inspector --cli API/mcp --transport http --method tools/list --header "Authorization: Bearer $MB_API_KEY"`
(the `--header` flag spelling for the Inspector CLI is UNVERIFIED; the curl above is authoritative).

## 3. Add it to your agent (2 min per host)

Use the server name `merchantbridge` everywhere so tools appear as `mcp__merchantbridge__zoho_*`.

**Claude Code**

```sh
claude mcp add --transport http merchantbridge API/mcp --header "Authorization: Bearer $MB_API_KEY"
# demo, no key:
claude mcp add --transport http mb-demo API/mcp/demo
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
allowed_tools=["mcp__merchantbridge__*"])`. A runnable Python example lives in `examples/python/` (M5).

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

**Claude.ai** — add a custom connector with URL `API/mcp/demo` and no sign-in. This works for the demo only: live
tenants need OAuth on the MCP leg, which is Tier 3 (ADR-0004). Menu wording in Claude.ai is not documented here.

**Agent Studio-style platforms** — any host that accepts a remote Streamable HTTP MCP server with a bearer header:
URL `API/mcp`, header `Authorization: Bearer mb_live_…`.

## 4. First questions to ask (1 min)

- "Check the MerchantBridge connection status."
- "Is <SKU> in stock in <warehouse>, and at what price?"
- "Which invoices are unpaid and due in the next 7 days?"
- "Find the invoice and order for Razorpay payment pay_…"

Read-only: requests to cancel, edit or email are refused by design ([agent-capabilities.md](agent-capabilities.md)).

## 5. Rotate, revoke, disconnect

- **Rotate a key:** mint a new key on `WEB/connect`, update the agent host, revoke the old key. Revoked keys get 401
  immediately.
- **Disconnect Zoho:** `WEB/connect` -> Disconnect revokes the Zoho refresh token at Zoho and marks the connection
  revoked; all keys for the tenant stop working.
- **Merchant-side revoke:** the Zoho user can also remove access under Zoho Accounts -> Sessions -> Connected Apps;
  agents then get `RECONNECT_REQUIRED`.
- Re-consent sparingly: Zoho keeps at most 20 refresh tokens per user and silently drops the oldest (runbook).

## Self-host

**Local demo, no credentials (2 min):**

```sh
pnpm i
pnpm dev:api   # Fastify on http://localhost:8787, /mcp/demo on FakeZoho, in-memory Kv
pnpm dev:web   # Next.js on http://localhost:3000
claude mcp add --transport http mb-local http://localhost:8787/mcp/demo
```

The playground needs `ANTHROPIC_API_KEY` and `MB_PLAYGROUND_ENABLED=true`; everything else works without keys.

**Your own deployment (live Zoho):**

1. Zoho API console (`api-console.zoho.<your dc>`): create a **Server-based** client; redirect URI
   `API/oauth/zoho/callback`; Settings -> enable the data centers you serve and select "use the same OAuth credentials
   for all data centers". Create a second client for local development so local re-consents cannot evict production
   tokens.
2. Postgres (Neon or any) and Redis (Upstash or any); production refuses to start without `DATABASE_URL` and
   `REDIS_URL`. Apply `packages/db/drizzle/*.sql` (e.g. `pnpm --filter @mb/db exec drizzle-kit migrate`).
3. Environment (names from `apps/api/src/config.ts`):

| Variable                                                                                       | Purpose                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `MB_PUBLIC_API_URL`, `MB_PUBLIC_WEB_URL`                                                       | public origins; API host is added to the MCP Host allow-list                   |
| `MB_ALLOWED_HOSTS`, `MB_CORS_ORIGINS`                                                          | extra hostnames for the Host check; browser origins for `/api/*`               |
| `DATABASE_URL`, `REDIS_URL`                                                                    | stores and governor/cache/locks                                                |
| `MB_ENCRYPTION_KEY`                                                                            | base64 of 32 random bytes (`openssl rand -base64 32`); encrypts refresh tokens |
| `MB_STATE_SECRET`                                                                              | HMAC key for OAuth `state`                                                     |
| `MB_CONNECT_INVITE_CODE`                                                                       | gate for `/connect`                                                            |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`                                    | the PROD Zoho client                                                           |
| `ANTHROPIC_API_KEY`, `MB_PLAYGROUND_ENABLED`, `MB_PLAYGROUND_MODEL`, `MB_PLAYGROUND_DAILY_CAP` | playground (use a spend-capped workspace key)                                  |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`                                                   | bot check on the first playground message                                      |
| `MB_TRUSTED_EGRESS_CIDRS`                                                                      | CIDRs (e.g. Anthropic MCP egress) that share a larger `/mcp/demo` bucket       |

`/connect` is disabled unless all Zoho, encryption, state and invite variables are set. 4. Deploy `apps/api` (Fly.io, `min_machines_running = 1`, so SSE and MCP stay warm) and `apps/web` (Vercel). Verify
`API/health/ready`, then repeat steps 1-3 above against your URLs.
