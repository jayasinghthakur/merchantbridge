# What an agent can and cannot do with MerchantBridge

MerchantBridge gives an AI agent **read-only** access to one merchant's Zoho Inventory organization over MCP (server
name `merchantbridge`, tools `zoho_*`). This page is the contract. The exact schemas are generated into
[`mcp-tools.json`](mcp-tools.json) by `pnpm gen:tools`; if the two disagree, `mcp-tools.json` wins and this page is a
bug. Zoho facts cited here come from [`notes/zoho.md`](notes/zoho.md).

## CAN

Tier 1 (the submission):

| Tool                             | In plain language                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zoho_get_connection_status`     | Which Zoho organization and data center you are connected to, its plan, which scopes were granted, how much of today's API budget is left, and whether the connection or circuit breaker needs attention. Call it first when anything fails. |
| `zoho_search_items`              | Find products by name, SKU fragment or free text, optionally only low-stock items or one warehouse. Returns ids, SKUs, prices, reorder levels.                                                                                               |
| `zoho_get_item`                  | One product by item id or exact SKU, with stock on hand and available stock **per warehouse**, selling price and reorder level.                                                                                                              |
| `zoho_list_sales_orders`         | Sales orders, newest first, optionally for one customer, status or date range. See the sales-order limit below.                                                                                                                              |
| `zoho_get_sales_order`           | One sales order with its line items, packages, carrier, tracking number, delivery status and linked invoices, from a single Zoho call.                                                                                                       |
| `zoho_search_customers`          | Find customers by name, company, email or phone fragment. Email and phone come back masked.                                                                                                                                                  |
| `zoho_list_invoices`             | Invoices filtered by status (unpaid, overdue, paid...), customer, due-date window or exact reference number. Amounts in minor units (paise).                                                                                                 |
| `zoho_get_invoice`               | One invoice with balance, due date, line items and recorded payments including their reference numbers.                                                                                                                                      |
| `zoho_find_by_payment_reference` | Given a Razorpay id (`pay_`, `order_`, `rfnd_`) or a reference string, find the matching customer payment(s) and the invoice(s) they settled. The start of a dispute evidence pack.                                                          |

Tier 2 (shipped only if time allows; absent from `tools/list` until then):

| Tool                  | In plain language                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `zoho_check_stock`    | Stock for up to 25 item ids in one call (takes item ids, not SKUs).                                |
| `zoho_list_shipments` | Packages that are shipped or delivered, with shipment dates; detail includes carrier and tracking. |

## CANNOT (and how that is enforced)

| The agent cannot...                                    | Enforced by                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create, update, cancel, void, delete or email anything | No write tools exist. The Zoho client issues **GET only** (it has no method parameter; a security test asserts every upstream request is a GET). The OAuth grant requests only `ZohoInventory.*.READ` scopes, so even a bug could not write. MCP `readOnlyHint` annotations are hints for hosts, not the guarantee. |
| Call an arbitrary Zoho endpoint or URL                 | Tools take ids, filters and opaque cursors, never URLs or paths. Every Zoho call goes `ZohoClient -> Governor`; a test fails if anything else references `zohoapis`.                                                                                                                                                |
| See another merchant's data                            | Every API key maps to one tenant and one organization; every DB row, cache key and governor key includes the tenant. The public demo endpoint is hard-wired to fake data and cannot load a real connection.                                                                                                         |
| See or reuse Zoho credentials                          | Zoho tokens stay server-side (refresh token AES-256-GCM encrypted at rest); MCP clients authenticate with our own key and never receive or send a Zoho token.                                                                                                                                                       |
| Run unbounded scans                                    | Page sizes are capped and multi-page scans have a hard bound (below); results over 10K tokens are refused with a hint.                                                                                                                                                                                              |
| Bypass the merchant's rate limits                      | All agents of a merchant share one governor per Zoho organization (below).                                                                                                                                                                                                                                          |

Asked to change data, the agent should say it is read-only and point the user to Zoho Inventory (playground scenario
"Cancel SO-00012" expects zero tool calls).

## LIMITS

| Limit               | Value                                                                                            | Why                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List page size      | `limit` default 20, max 100; continue with the opaque `next_cursor`                              | Keeps results small and readable for the model.                                                                                                                                                                      |
| Zoho page size      | 200 records per upstream call (Zoho default; documented max unknown)                             | One upstream call per page.                                                                                                                                                                                          |
| Sales-order filters | Zoho documents **no** search, customer, status or date filters on `/salesorders`                 | Only verified filters are used; see ADR-0006.                                                                                                                                                                        |
| Sales-order scan    | At most **3 pages x 200 = the 600 most recent orders** when a filter must be applied on our side | Bounds cost to 3 upstream calls (of a 500/day share on the free plan) and latency to a few seconds. Older orders: search by customer/invoice first, or open the order by id. The result says when the bound was hit. |
| Batch stock         | 25 item ids per `zoho_check_stock` call                                                          | Upstream max not documented; 25 is a safe cap.                                                                                                                                                                       |
| Result size         | <= 10,000 tokens per tool result (estimated at 4 chars/token, test-enforced)                     | Claude Code and the Agent SDK warn at 10K and replace results over 25K with a file reference. Oversize -> `INVALID_INPUT` with a hint to narrow.                                                                     |
| Per-minute rate     | 80 requests/min per Zoho organization (Zoho's hard limit is 100)                                 | Headroom for the merchant's own UI and other integrations.                                                                                                                                                           |
| Concurrency         | 4 in flight (free plan) / 8 (paid) per organization (Zoho: 5 / 10)                               | Avoids Zoho code 1070.                                                                                                                                                                                               |
| Daily share         | 50% of the plan's daily quota (free 1000 -> 500/day for MerchantBridge)                          | The quota is shared with everything else the merchant runs; resets at UTC midnight (assumption, ADR-0005).                                                                                                           |
| Queueing            | A call waits at most 10 s for a slot, then returns `RATE_LIMITED` with `retry_after_s`           | Agents get a fast, actionable answer instead of a hang.                                                                                                                                                              |
| Retries             | 429 (code 1070): up to 3 with jitter. 5xx/timeout: 2. Code 45: never. Per-attempt timeout 10 s.  |                                                                                                                                                                                                                      |
| Circuit             | Zoho code 44 (org blocked): circuit open 60 s. 5 consecutive failures: open 30 s.                | Stops agents from extending a Zoho block.                                                                                                                                                                            |
| Free text           | Zoho notes/descriptions truncated to 500 chars                                                   | Size and injection surface.                                                                                                                                                                                          |

## DATA HANDLING

- **PII masking.** Customer email `r***@example.com`, phone/mobile `***1234`. Addresses are not returned by list
  tools.
- **Untrusted text.** Anything a merchant or customer typed in Zoho (item descriptions, order notes, terms) is
  returned as `{ "untrusted_text": "..." }`. It is data, never instructions; the demo dataset contains a planted
  prompt injection in an item note to prove this (eval).
- **Audit trail.** Exactly one `usage_event` per tool call, success or error: time, request id, tenant, organization,
  tool, client name (unauthenticated label), status, error code, duration, upstream calls, cache hits, retries,
  result size and **masked** arguments (ids, SKUs and `pay_` refs kept; free text replaced by `<text:N>`). No result
  data, no free text, no tokens. Retained 30 days.
- **No mirroring.** Zoho data is not copied into our database. The only copy is a short-TTL cache: items and stock
  60 s, organization/connection status 300 s; orders, invoices, payments and customers are always fetched fresh.
  Cache keys include tenant and organization.
- **Secrets.** Zoho refresh tokens are encrypted at rest; access tokens live only in the cache (55 min); API keys are
  stored as SHA-256 hashes and shown once. Logs never contain tokens, auth codes or unmasked contact details.

## ERRORS

Errors are normal tool results with `isError: true` and a body
`{ "error": { "code", "message", "retryable", "retry_after_s"?, "hint"? } }`. JSON-RPC errors are used only for an
unknown tool name or a malformed request.

| Code                    | Means                                                                       | Retryable      | What the agent should do                                                                                       |
| ----------------------- | --------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`         | Bad arguments, bad cursor, or result too large                              | no             | Fix the arguments per `hint` (pass ids/cursors exactly as returned; use a smaller `limit` or narrower filter). |
| `NOT_FOUND`             | No record with that id/SKU/reference                                        | no             | Tell the user; try a search tool instead of a guessed id.                                                      |
| `RATE_LIMITED`          | Our per-minute budget, concurrency queue or Zoho's minute block (code 44)   | yes            | Wait `retry_after_s`, then retry once. Do not loop.                                                            |
| `DAILY_QUOTA_EXHAUSTED` | Today's share of the Zoho daily quota is used up (or Zoho returned code 45) | no             | Stop calling tools; tell the user it resets at UTC midnight.                                                   |
| `RECONNECT_REQUIRED`    | The Zoho connection was revoked or expired                                  | no             | Tell the user the merchant must reconnect Zoho at /connect.                                                    |
| `SCOPE_NOT_GRANTED`     | The merchant did not grant the needed Zoho scope                            | no             | Tell the user which data is unavailable; reconnect grants all scopes.                                          |
| `UPSTREAM_ERROR`        | Zoho failed or returned an unexpected shape                                 | if `retryable` | Retry once if `retryable`; otherwise report and call `zoho_get_connection_status`.                             |

## FRESHNESS AND PROVENANCE

Every successful result carries `meta`:

- `as_of`: when MerchantBridge produced the result (ISO 8601). `cached: true` means it came from the short-TTL cache
  (at most 60 s old for items/stock, 300 s for organization data).
- `zoho_url`: a deep link so a human can verify the record in Zoho (null until the link format is confirmed against a
  real org).
- `organization_id`, `budget_remaining_today`, and `demo: true` on the public demo (fake data, "Chai & Co (DEMO)").

Agents should quote `as_of` for stock and balances, which change minute to minute, and should not present cached
stock as live.
