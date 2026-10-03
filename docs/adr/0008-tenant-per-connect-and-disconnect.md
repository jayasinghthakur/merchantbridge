# ADR-0008: One tenant per connect in v1, an org-keyed governor, and what disconnect does

Amended 2026-10-03: the governor is now keyed per Zoho organization (was per tenant), and the callback revokes the
refresh token it was issued whenever the connect fails afterwards. Tenant-per-connect is unchanged.

## Context

The OAuth callback (`apps/api/src/routes/oauth.ts`) must decide which MerchantBridge tenant a new Zoho connection
belongs to. `/oauth/zoho/start` signs `state` as `{ dc, purpose: 'connect' }` plus a nonce and expiry
(`packages/auth/src/state.ts` already allows an optional `tenantId`, but the route never sets it and the callback
never reads it). There is no merchant login, so the callback does not know who the caller is beyond "a browser that
presented a valid invite code". Data is tenant-scoped (CLAUDE.md rule 5):

- cache prefix `zoho:{tenant_id}:{organization_id}:`;
- `connections` rows and `api_keys` rows reference `tenant_id`.

The original v1 also scoped the governor per tenant (`zoho:{tenant_id}:{organization_id}`), which is what the amendment
below changes.

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

**Governor per organization (amended).** The live governor scope is `zoho:{dc}:{organization_id}`
(`apps/api/src/runtime.ts`; Redis keys `gov:zoho:{dc}:{org}:*`): one per-minute window, one set of concurrency leases,
one daily share and one circuit per Zoho organization, shared by every tenant and key connected to it. Zoho's limits
are per organization, so this is the only key that keeps the sum of our traffic under them. The data center is part
of the key so organization ids from different DCs can never collide (cross-DC uniqueness is not documented). The cache stays per tenant. The scope
carries no data and no credentials: tenants still read only through their own connection and token.

**Abandoned connects revoke their refresh token (amended).** Once the code exchange has produced a refresh token, any
later failure in the callback (organizations lookup, no organization, store errors) revokes that token at Zoho
(best effort, never logged) before redirecting to `/connect/error`. Zoho keeps at most 20 refresh tokens per user per
client and silently drops the oldest, so a failed connect must not hold one that could evict the token behind the
merchant's working connection.

## Consequences

- **Rate-limit risk: fixed by the amendment.** If one Zoho organization is connected twice (two people at the
  merchant, or one person reconnecting), it still gets two tenants and two keys, but they share one governor scope, so
  together they stay within 80/min, 4/8 concurrent calls and the 50% daily share. Budgets are not split per tenant:
  one busy key can use the organization's whole share, and a code-44 circuit opened by one tenant pauses all of them
  (which is what Zoho does to the organization anyway). Changing the key resets the counters once on deploy; with a
  single always-on machine and minute windows this is harmless.
- **Refresh-token churn.** Every successful connect is a new consent and a new refresh token. Repeated reconnects by
  the same Zoho user with the PROD client evict the oldest refresh token after 20, which surfaces as
  `RECONNECT_REQUIRED` on the oldest tenant. Failed connects no longer add to this (their token is revoked).
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

**Still planned (v1.1): tenant reuse.** Either bind the tenant into the flow (a signed-in merchant, or the existing
optional `tenantId` in the HMAC-signed `state`, set only for an authenticated reconnect) or look up an existing active
tenant by `(provider, organization_id)` in the callback and attach the new connection and key to it. That would make
reconnect repair the old tenant instead of minting a new one; it needs a migration note and its own tests.

## Status

Accepted for v1 (implemented in `apps/api/src/routes/oauth.ts`, `apps/api/src/routes/connection.ts` and
`apps/api/src/runtime.ts`, tested in `apps/api/test/oauth.test.ts`, `apps/api/test/disconnect.test.ts` and
`apps/api/test/live-mcp.test.ts`). Amended 2026-10-03: org-keyed governor and revoke on abandoned connect are in;
tenant reuse on reconnect is open (`docs/STATUS.md`).
