# M1 — Connector SDK, Zoho client, OAuth

Read SPEC sections "Architecture", "Authentication". Plan mode first. Write tests before implementation for auth refresh.

Build:
1. `packages/connector-sdk`: `defineConnector({ id, name, auth, scopes, rateLimitProfile, tools })` and
   `defineTool({ name, title, description, input: ZodSchema, output: ZodSchema, readOnly: true, handler })`.
   Handlers receive `ctx = { tenantId, orgId, http, log, emit }` — never raw tokens.
2. `packages/auth`:
   - Region map for all 8 Zoho DCs (accounts host + API host; Canada accounts host is zohocloud.ca).
   - Hosted OAuth: build auth URL (access_type=offline, prompt=consent, read-only scopes), signed single-use
     `state` (HMAC, 10-min expiry), callback exchange, revoke.
   - Self-client mode from env (client id/secret/refresh token).
   - Token vault: AES-256-GCM encrypt/decrypt of refresh tokens; store in Postgres `connections` table.
   - Refresh: in-memory + Redis cached access token; refresh 5 min before expiry under a Redis lock
     (only one refresher under concurrency — test this with 20 parallel calls).
   - `invalid_grant` → mark connection `needs_reconnect`, throw `RECONNECT_REQUIRED`.
3. `connectors/zoho-inventory/src/client.ts`: thin typed client over undici; adds `Authorization: Zoho-oauthtoken`,
   `organization_id`; treats non-zero body `code` as an error; maps HTTP/Zoho codes to our error codes.
4. `apps/gateway`: Fastify routes `GET /oauth/zoho/start`, `GET /oauth/zoho/callback`, `POST /connections/:id/disconnect`,
   `GET /connections/:id/organizations`.
5. `packages/db`: Drizzle schema — tenants, api_keys (hashed), connections, organizations, usage_events, audit_log. Migrations.

Done when: unit tests green, and `pnpm --filter gateway dev` + self-client env lets me hit an endpoint that lists my real
Zoho organizations (I will run that part). Commit per step.
