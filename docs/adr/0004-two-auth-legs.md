# ADR-0004: Two separate auth legs

## Context

Two different parties need credentials:

1. MerchantBridge needs delegated, read-only access to the merchant's Zoho org.
2. The merchant's agents (Claude Code, Agent SDK, Messages API connector, Claude.ai) need to call MerchantBridge.

The MCP authorization spec forbids token passthrough: an MCP server must not accept or forward tokens issued for a
different audience. Agent Studio-style private connectors use a one-time OAuth connection shared by all of the
merchant's agents. Zoho limits: refresh token only with `access_type=offline`; access tokens live 1 h; 10 access
tokens per refresh token per 10 min; 20 refresh tokens per user (the 21st silently evicts the oldest); see
`docs/notes/zoho.md` section 3.

## Decision

**Leg 1, merchant -> Zoho:** OAuth 2.0 authorization code with a confidential server client.

- `/oauth/zoho/start?dc=..&invite=..` -> Zoho consent with all 8 READ scopes, `access_type=offline`,
  `prompt=consent`, HMAC-signed single-use `state` (10 min). No PKCE claim (documented for public clients only).
- Callback exchanges the code at the returned `accounts-server`, validates it and `api_domain` against the DC
  allow-list, stores the refresh token AES-256-GCM encrypted, caches the access token 55 min in Redis.
- Refresh is single-flight under `SET NX`; 401 -> refresh -> one retry -> `RECONNECT_REQUIRED`
  (`invalid_code` / `invalid_grant`). Disconnect revokes the refresh token.
- Separate **PROD** and **DEV** Zoho clients so local re-consents cannot evict the production refresh token.

**Leg 2, agent -> MerchantBridge:** per-tenant API key `mb_live_<random>`, shown once in the browser URL fragment,
stored as SHA-256, revocable, sent as `Authorization: Bearer`. It works with `claude mcp add --header`, Agent SDK
`headers`, and the Messages API `authorization_token`. Zoho tokens never leave the server.

OAuth 2.1 on leg 2 (RFC 9728 metadata, `WWW-Authenticate` discovery, hosted IdP) is Tier 3: it adds Claude.ai's
Connect card but nothing the assignment checks.

## Consequences

- A leaked agent key exposes read-only data for one org and is revocable without touching Zoho; a leaked database row
  is useless without the encryption key.
- The demo endpoint needs no key; it never sees real credentials.
- Claude.ai can use `/mcp/demo` ("No sign-in"); live tenants in Claude.ai wait for Tier 3.
- Token-request throttles (10/client/10 min per PLAN research) make single-flight refresh mandatory; tested with 20
  parallel calls -> exactly 1 token request.

## Status

Accepted.
