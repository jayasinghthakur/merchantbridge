# Vendored reference material (do not edit)

- `zoho/*.yml` — official Zoho Inventory OpenAPI 3.0 specs (subset of `https://www.zoho.com/inventory/api/v1/openapi-all.zip`, downloaded 2026-10-03). Source of truth for endpoints, params, scopes and response shapes.
- `zoho/accounts/*.txt` — text captures of Zoho Accounts OAuth docs (authorization, token, refresh, revoke, multi-DC, limits) and the Inventory errors page.
- `mcp/*.md` — MCP TypeScript SDK v2 docs (serving over HTTP/Fastify, legacy clients, authorization, testing) and `anthropic-mcp.ts` (the `@anthropic-ai/sdk` MCP helper source), captured 2026-10-03.

Anything not covered here is UNVERIFIED and must get a probe in `scripts/smoke.ts`.
