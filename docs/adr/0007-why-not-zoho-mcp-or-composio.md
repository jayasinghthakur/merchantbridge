# ADR-0007: Why not Zoho's own MCP server or a hosted aggregator (Composio)

## Context

Zoho shipped an official Zoho Inventory MCP server in July 2026 with read **and write** tools (the vendored OpenAPI
files already carry `x-mcp-group` tags). Hosted aggregators such as Composio expose Zoho through generic tool
catalogs with their own auth. A reviewer will reasonably ask why build a connector at all. Razorpay's Agent Studio
positions "private connectors scoped exclusively to the organization", one-time OAuth shared by all of a merchant's
agents, and "new connectors typically take about one week" (30 Mar 2026 guardrails post).

## Decision

Build MerchantBridge as a private, Agent Studio-style connector, and state the differentiators plainly:

| Need               | Zoho MCP / generic aggregator                                             | MerchantBridge                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least privilege    | Read and write tools; read-only depends on how the merchant configures it | READ-only scopes, GET-only client, no write tools (three independent guards, not configuration)                                                                      |
| Shared daily quota | Each client spends the org's 100/min and daily quota independently        | One governor per org for all agents: 80/min, 50% daily share, 60 s circuit on code 44                                                                                |
| Payments context   | No notion of Razorpay ids                                                 | `zoho_find_by_payment_reference` reconciles `pay_`/`order_`/`rfnd_` refs to payments, invoices, orders and shipments; money in paise                                 |
| Audit              | Vendor-side logs, if any                                                  | One `usage_event` per call with masked args, tenant, client, decisions; 30-day retention                                                                             |
| Agent ergonomics   | 1:1 endpoint wrappers                                                     | Task-shaped tools with "use when / don't use when", envelope with `as_of` and `zoho_url`, results <= 10K tokens, `isError` bodies with retry hints, `untrusted_text` |
| Platform fit       | Vendor-specific                                                           | ToolRuntime + contract suite + fake-upstream pattern reusable for connector #2                                                                                       |

We do not claim Zoho's MCP is insecure or worse in general; it targets a different job (full app automation by the
merchant).

## Consequences

- We maintain mappers for Zoho's API ourselves; vendored OpenAPI + smoke probes + the `zoho-verifier` subagent keep
  that honest.
- If a merchant already runs Zoho's MCP, both share the same per-org Zoho limits; our governor protects only our share.
  The runbook covers diagnosing a code-44 block caused by another client.
- If Razorpay standardizes a connector contract, ToolRuntime is the adaptation point.

## Status

Accepted.
