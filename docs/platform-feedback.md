# Platform feedback: what generalizes to connector #2

Razorpay's Agent Studio guardrails post (30 Mar 2026) says "new connectors typically take about one week". This page
is our view of how to keep it at a week or less: which parts of MerchantBridge are platform (written once) and which
are connector (written per vendor), plus what a platform team could provide.

## Platform: reused unchanged

| Piece                                            | Where                                                             | Why it transfers                                                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineConnector` / `defineTool` / `ToolRuntime` | `packages/core/src/tool.ts`, `runtime.ts`                         | Zod in/out, envelope, `isError` bodies, field allow-list by output schema, 10K-token cap, exactly one usage event. A connector only writes handlers.                     |
| Error taxonomy                                   | `packages/core/src/errors.ts`                                     | Seven agent-facing codes with retry semantics; vendor errors map into them. Agents and evals learn one vocabulary.                                                       |
| Formatting                                       | `packages/core/src/format.ts`                                     | Money in minor units, masking, `untrusted_text`, opaque cursors: identical needs in any merchant system.                                                                 |
| Governor + cache                                 | `packages/governor`, `RateProfile` in core                        | Per-org shared budgets, leases, circuit, retries; a new vendor is a new profile (`freshdeskRateProfile()`), not new code.                                                |
| Fake-upstream pattern                            | ADR-0003, `packages/zoho-inventory/src/fake/`                     | A fetch transport speaking the vendor's wire format runs the real client in demos and tests; faults are data.                                                            |
| Contract suite                                   | `packages/zoho-inventory/test/contract*` (to be lifted into core) | Valid -> schema-valid, bad -> `INVALID_INPUT`, unknown -> `NOT_FOUND`, size cap, allow-list, one usage event, in both MCP eras. Connector #2 must pass it **unchanged**. |
| Agent auth leg + tenancy                         | `packages/auth` keys, `packages/db` stores                        | API keys, tenant isolation, audit table do not depend on the vendor.                                                                                                     |
| MCP serving                                      | `apps/api` (`createMcpHandler`, pass-through registration)        | Mount one more connector's runtime; same Host checks, rate limits, `/mcp` auth.                                                                                          |
| Playground, explorer, evals                      | `apps/web`, `apps/api` playground, `evals/`                       | Scenario cards and evals are data (`SCENARIOS`).                                                                                                                         |
| Docs kit                                         | `notes/<vendor>.md`, smoke probes, ADR template, CAN/CANNOT       | The verification discipline (vendored spec, UNVERIFIED tags, human-run smoke) is the main reason a week is enough.                                                       |

## Connector: written per vendor

- OAuth specifics (DCs/regions, scopes, token limits, refresh quirks) and its smoke probes.
- Endpoint mapping, pagination, error-code mapping; rate profile values and their ADR.
- Tool set and descriptions ("use when / don't use when"), field allow-lists, mappers.
- Demo dataset and wire-accurate fake, recorded fixtures, 2+ evals per tool.

## A one-week plan for connector #2 (e.g. Freshdesk, Tier 3 stub)

| Day | Work                                                                         | Exit check                             |
| --- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 1   | Vendor OpenAPI vendored; `notes/<vendor>.md`; smoke probes; rate-profile ADR | human smoke run filed                  |
| 2   | Client + error mapping + fake upstream wire tests                            | wire tests green                       |
| 3   | Tools + mappers; contract suite unchanged                                    | contract suite green on fake           |
| 4   | OAuth leg 1 for the vendor; tenant connection; governor profile              | 20-parallel refresh test, live connect |
| 5   | Evals, CAN/CANNOT, `mcp-tools.json`, recorded fixtures, review               | evals >= 90% on Sonnet                 |

Measured on this project (fill at M5): days spent on platform pieces vs Zoho-specific pieces: `TODO`.

## What would make it faster (requests to a platform team)

1. **A published connector contract** (tool envelope, error codes, audit event schema, auth leg 2). Today it is an
   inference from the Agent SDK and MCP; every connector team would otherwise reinvent `ToolRuntime`.
2. **Shared per-vendor quotas across connectors and agents.** Zoho's limits are per organization; two independent
   connectors (or ours plus Zoho's own MCP) can block each other. A platform-level governor keyed by vendor + org would
   remove the biggest operational risk (runbook: code 44).
3. **A fake-upstream registry** so demos and CI never need vendor sandboxes, which expire (Zoho trial: 14 days).
4. **OAuth 2.1 on the MCP leg as a platform service** (RFC 9728 metadata, hosted IdP), so connectors only implement
   the vendor leg.
5. **Tool-description linting + evals as the acceptance gate** for every connector, with published pass rates.
6. **A payments-context layer**: Razorpay ids and amounts in paise are the join key across inventory, CRM, support and
   accounting connectors; resolving them once (our `find_by_payment_reference`) should be shared.
