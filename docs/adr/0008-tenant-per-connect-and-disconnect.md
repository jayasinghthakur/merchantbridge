# ADR-0008: One tenant per connect in v1, and what disconnect does

## Context

The OAuth callback (`apps/api/src/routes/oauth.ts`) must decide which MerchantBridge tenant a new Zoho connection
belongs to. `/oauth/zoho/start` signs `state` as `{ dc, purpose: 'connect' }` plus a nonce and expiry
(`packages/auth/src/state.ts` already allows an optional `tenantId`, but the route never sets it and the callback
never reads it). There is no merchant login, so the callback does not know who the caller is beyond "a browser that
presented a valid invite code". The connection, the governor key and the cache keys are all tenant-scoped (CLAUDE.md
rule 5):

- governor scope `zoho:{tenant_id}:{organization_id}` (`apps/api/src/runtime.ts`), Redis keys `gov:zoho:{tenant}:{org}:*`;
- cache prefix `zoho:{tenant_id}:{organization_id}:`;
- `connections` rows and `api_keys` rows reference `tenant_id`.

Zoho limits are per organization, not per app or token: 100 requests/min (code 44 blocks the whole org), a daily
quota by plan (code 45), 5/10 concurrent calls (code 1070). Zoho also keeps at most 20 refresh tokens per user per
client; the 21st consent silently deletes the oldest (`docs/notes/zoho.md` §3).

Merchants need an off switch that does not depend on finding the Zoho Accounts "Connected Apps" page.

## Decision

**Tenant per connect.** Every successful callback creates a new `tenants` row (named after the organization), upserts
one `connections` row for it (encrypted refresh token, DC, `accounts-server`, `api_domain`, organization id, plan,
scopes) and mints one `mb_live_` key whose SHA-256 hash is stored. The key is returned once, in the URL fragment of
`WEB/connect/success`. Connecting the same organization again does not find or reuse the earlier tenant. The
organization is Zoho's default organization for that user (`is_default_org`), else the first returned; there is no
organization picker yet.

**Disconnect.** `POST /api/connection/disconnect` with `Authorization: Bearer mb_live_…` (the same key guard as
`/mcp`, including the per-IP failed-key limiter; 5 requests per key per minute):

1. Load the tenant's active connection. If there is one and Zoho OAuth is configured on this server: decrypt the
   refresh token and `POST {accounts-server}/oauth/v2/revoke/token` (Basic client auth). Zoho's `invalid_token`
   answer counts as revoked (the goal is met). Any failure (network, decrypt) is logged by error name only.
2. Drop the cached access token for that connection.
3. Mark the connection `revoked`.
4. Revoke the calling key.

Steps 2-4 run even when step 1 fails, so local revocation never depends on Zoho being reachable. The response is
`{ revoked_locally: true, revoked_at_zoho, had_connection }` with `Cache-Control: no-store`. The key is then rejected
with 401 on `/mcp` and on a second disconnect. Other methods on the route answer 405. The public demo is unaffected.

## Consequences

- **Rate-limit risk (accepted for v1, must fix before onboarding more than one key-holder per org).** If one Zoho
  organization is connected twice (two people at the merchant, or one person reconnecting), it gets two tenants and
  therefore two independent governor keys. Each allows 80/min and a 50% daily share, so together they can exceed
  Zoho's per-org 100/min (triggering code 44 for the whole org, including the merchant's own UI) and spend 100% of
  the daily quota. Concurrency leases (4/8) are likewise per tenant.
- **Refresh-token churn.** Every connect is a new consent and a new refresh token. Repeated reconnects by the same
  Zoho user with the PROD client evict the oldest refresh token after 20, which surfaces as `RECONNECT_REQUIRED` on
  the oldest tenant.
- **Reconnect issues a new key.** After `RECONNECT_REQUIRED`, reconnecting does not repair the old tenant: the
  merchant gets a new key, must update every agent host, and should disconnect the old key so its connection and
  refresh token do not linger.
- **Key rotation = connect again + disconnect the old key.** There is no "mint another key for this tenant" endpoint.
- **Disconnect revokes only the calling key.** In v1 a tenant has exactly one key, so this is "all keys". If more
  keys per tenant are added later, the others would get `RECONNECT_REQUIRED` (no active connection), not 401.
- **Usage history** stays attached to the old tenant id (30-day retention), so a per-org audit view must join on
  `connections.organization_id`.
- Revoke at Zoho uses the merchant's DC `accounts-server`; Zoho's revoke page says the accounts host is where the
  app is registered, so a cross-DC client could need the other host (UNVERIFIED, tagged in
  `packages/auth/src/oauth-client.ts`). Local revocation is unaffected either way.

**Planned fix (v1.1).** Either bind the tenant into the flow (a signed-in merchant, or the existing optional
`tenantId` in the HMAC-signed `state`, set only for an authenticated reconnect) or look up an existing active tenant by
`(provider, organization_id)` in the callback and attach the new connection and key to it. Independently, key the
governor by organization (`zoho:org:{organization_id}`) so every tenant and key of one org shares one budget, which
is what CLAUDE.md's "per-org governor" already promises. Either change needs a migration note and tests for "second
connect of the same org shares the governor".

## Status

Accepted for v1 (implemented in `apps/api/src/routes/oauth.ts` and `apps/api/src/routes/connection.ts`, tested in
`apps/api/test/oauth.test.ts` and `apps/api/test/disconnect.test.ts`). The governor-key fix is open (`docs/STATUS.md`).
