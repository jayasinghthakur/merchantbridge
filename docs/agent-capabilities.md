# What an agent can and cannot do with MerchantBridge

MerchantBridge gives an AI agent **read-only** access to one merchant's Zoho Inventory organization over MCP (server
name `merchantbridge`, tools `zoho_*`, so agents see `mcp__merchantbridge__zoho_*`). This page is the contract; every
number below is taken from the code (file references inline). Exact schemas are generated into
[`mcp-tools.json`](mcp-tools.json) by `pnpm gen:tools`; if the two disagree, `mcp-tools.json` wins and this page is a
bug. Zoho facts come from [`notes/zoho.md`](notes/zoho.md).

Two endpoints serve the same 10 tools:

| Endpoint         | Who                               | Data                                                                                   |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /mcp`      | `Authorization: Bearer mb_live_…` | The key's tenant and its one connected Zoho organization.                              |
| `POST /mcp/demo` | Anyone, no key                    | "Chai & Co (DEMO)" served by FakeZoho; never a real connection. `meta.demo` is `true`. |

`tools/list` is the same for both endpoints, alphabetical, and fixed for a deploy: the server declares
`capabilities.tools.listChanged: false` and never sends a list-changed notification.

## CAN

| Tool                             | In plain language                                                                                                                                                                                                                                                                                                                                                                     | Bounds                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `zoho_get_connection_status`     | Which organization, currency, data center and plan is connected, the read scopes requested at connect (`scopes_requested`; Zoho does not report grants, so a missing grant surfaces as `SCOPE_NOT_GRANTED` from the tool that needs it), whether Zoho answers, calls left today and the circuit state. Call it after `RECONNECT_REQUIRED`, `RATE_LIMITED` or `DAILY_QUOTA_EXHAUSTED`. | 1 live call, never cached.                                                                                                                      |
| `zoho_search_items`              | Products by free text, exact SKU, name fragment, low stock only, active/inactive, or one location. Returns item_id, SKU, price, total stock on hand and available, reorder level, low-stock flag.                                                                                                                                                                                     | `limit` 1-100 (default 20), cursor.                                                                                                             |
| `zoho_get_item`                  | One product by `item_id` **or** exact SKU (case-insensitive): price, stock on hand and available **per warehouse**, reorder level, description.                                                                                                                                                                                                                                       | Exactly one of the two inputs.                                                                                                                  |
| `zoho_check_stock`               | Stock per warehouse, reorder level and price for several known items in one call; unknown ones listed in `not_found`.                                                                                                                                                                                                                                                                 | Exactly one of: 1-25 `item_ids`, or 1-5 exact `skus` (one lookup call per SKU).                                                                 |
| `zoho_list_sales_orders`         | Sales orders newest first: id, number, date, status, customer, total. Optional `customer_id`, `status` (`void` = cancelled), `date_from` / `date_to`.                                                                                                                                                                                                                                 | `limit` 1-100, cursor. With any filter: only the first 600 orders Zoho returns, believed newest first (`data.scan.order_verified`; see LIMITS). |
| `zoho_get_sales_order`           | One order with line items, shipments (package, carrier, tracking number, shipment date, delivered flag, courier status) and linked invoices (status, due date, balance), from one Zoho call.                                                                                                                                                                                          | Exactly one of `salesorder_id` or `salesorder_number`; by number = scan of the first 600 orders Zoho returns.                                   |
| `zoho_search_customers`          | Customers by free text, name, company, email or phone fragment (phone: at least 4 digits). Returns contact_id, name, city, masked email/phone, outstanding receivable.                                                                                                                                                                                                                | `limit` 1-100, cursor. Customer notes (as `untrusted_text`) only when there are 3 or fewer matches.                                             |
| `zoho_list_invoices`             | Invoices filtered in Zoho by `status` (`unpaid` includes overdue; also overdue, partially_paid, paid, sent, viewed, draft, void), `customer_id`, `due_from` / `due_to`, exact `invoice_number` or `reference_number`.                                                                                                                                                                 | `limit` 1-100, cursor.                                                                                                                          |
| `zoho_get_invoice`               | One invoice: status, dates, total, amount paid, balance due, line items, notes, linked sales order when Zoho provides it.                                                                                                                                                                                                                                                             | Exactly one of `invoice_id` or `invoice_number`.                                                                                                |
| `zoho_find_by_payment_reference` | From a Razorpay `pay_` / `order_` / `rfnd_` id, a 12-digit UPI UTR or any reference: the customer payment, the invoice(s) it paid, and that sales order with its shipments. Each match says `exact` or `partial`.                                                                                                                                                                     | At most 5 upstream calls and 5 matches; only the best match is fully resolved. Falls back to invoice `reference_number`.                        |

There is no shipment-list tool (`zoho_list_shipments` was planned and not built): shipment, carrier and tracking data
come from `zoho_get_sales_order` and `zoho_find_by_payment_reference`.

## CANNOT (and how that is enforced)

| The agent cannot...                                    | Enforced by                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create, update, cancel, void, delete or email anything | No write tools exist. `ZohoClient` issues GET only (no method parameter; tests assert every upstream request is a GET) on an allow-list of paths and query keys. The OAuth grant requests only the 8 `ZohoInventory.*.READ` scopes. MCP `readOnlyHint` is a hint for hosts, not the guarantee. |
| Call an arbitrary Zoho endpoint or URL                 | Tool inputs are ids (`^[0-9A-Za-z_-]{1,64}$`), filters and opaque cursors, never URLs or paths. Every Zoho call goes `ZohoClient -> Governor`; a test fails if any other file references `zohoapis`.                                                                                           |
| See another merchant's data                            | An API key maps to one tenant and its one organization; every DB row and cache key includes the tenant. The governor is keyed by Zoho organization: it shares a rate budget, never data. `/mcp/demo` is wired to a resolver built only from FakeZoho pieces and cannot load a connection.      |
| See or reuse Zoho credentials                          | Zoho tokens stay server-side (refresh token AES-256-GCM at rest, access token encrypted in Redis). MCP clients send only the `mb_live_` key and never receive a Zoho token.                                                                                                                    |
| Run unbounded scans or return huge results             | Page and scan sizes are capped (below); every result is held to 10,000 tokens.                                                                                                                                                                                                                 |
| Bypass the organization's rate limits                  | Every call is admitted by the governor (below).                                                                                                                                                                                                                                                |

Asked to change data, the agent should call no tool, say the connector is read-only and point the user to Zoho
Inventory. The playground card "Cancel sales order SO-00012 and mark its invoice as paid" and three more eval cases
expect zero tool calls.

## LIMITS

| Limit                 | Value (source)                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List page size        | `limit` default 20, min 1, max 100; continue with `next_cursor` while `has_more` (`tools/shared.ts`)                                                             | A page may hold fewer rows than `limit` to stay under the size cap; the cursor then resumes inside the same upstream page.                                                                                                                                                                                                                                                                                                                         |
| Cursor                | Opaque, at most 512 chars, bound to the filters it came with                                                                                                     | Reusing it with different filters returns `INVALID_INPUT` ("The cursor belongs to a different query").                                                                                                                                                                                                                                                                                                                                             |
| Zoho page size        | 200 records per upstream call                                                                                                                                    | Zoho's documented default; the maximum is undocumented.                                                                                                                                                                                                                                                                                                                                                                                            |
| Sales-order filters   | Applied by MerchantBridge over **the first 600 orders Zoho returns** (3 pages x 200; `SCAN_MAX_PAGES`, `SCAN_PAGE_SIZE`), believed newest first                  | Zoho documents no `/salesorders` filters and no sort order (UNVERIFIED, smoke probe P-16). `data.scan` reports `scanned`, `max_scanned`, `more_beyond_scan` and `order_verified` (true when the scanned orders' dates never increase, i.e. they came newest first; false means unchecked orders may be newer). Each filtered page costs up to 3 upstream calls. Older orders: open them by `salesorder_id`, or go through the customer's invoices. |
| Sales order by number | Same 600-order scan                                                                                                                                              | Not found beyond it says so; pass `salesorder_id` when known.                                                                                                                                                                                                                                                                                                                                                                                      |
| Batch stock           | 25 item ids or 5 SKUs per `zoho_check_stock` call                                                                                                                | Upstream maximum undocumented.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Line items            | At most 50 per order or invoice (`MAX_LINE_ITEMS`); `line_items_truncated` says when more exist                                                                  | Keeps one large order inside the size cap.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Payment reference     | 3-64 chars of `A-Za-z0-9_-./`; at most 5 upstream calls and 5 matches                                                                                            | `pay_` / `order_` / `rfnd_` ids and 12-digit UTRs are classified; anything else is searched as a plain reference.                                                                                                                                                                                                                                                                                                                                  |
| Result size           | <= 10,000 tokens per result, estimated at 4 chars/token (`MAX_RESULT_TOKENS`, test-enforced per tool at max `limit`)                                             | Lists trim rows to fit; anything still too large returns `INVALID_INPUT` with a hint to narrow. Claude hosts warn above 10K tokens.                                                                                                                                                                                                                                                                                                                |
| Per-minute rate       | 80 admitted upstream requests per minute per Zoho organization (Zoho's hard limit: 100 per org)                                                                  | Headroom for the merchant's own UI and other integrations.                                                                                                                                                                                                                                                                                                                                                                                         |
| Concurrency           | 4 in flight on the free plan, 8 on paid plans (Zoho: 5 / 10); leases expire after 30 s                                                                           | Avoids Zoho code 1070. Unknown plans are treated as free.                                                                                                                                                                                                                                                                                                                                                                                          |
| Daily share           | 50% of the plan's daily quota (free 1,000 -> 500; standard 2,000 -> 1,000; professional 5,000 -> 2,500; premium/enterprise 10,000 -> 5,000)                      | Shared with everything else the merchant runs. Resets at 00:00 UTC (assumption, ADR-0005).                                                                                                                                                                                                                                                                                                                                                         |
| Queueing              | At most 10 s waiting for a minute slot or a lease, then `RATE_LIMITED` with `retry_after_s`                                                                      | Agents get a fast, actionable answer instead of a hang.                                                                                                                                                                                                                                                                                                                                                                                            |
| Retries               | 429 code 1070 (and unclassified 429): up to 3 with full jitter. 5xx, timeout, network: up to 2. Code 45: never. Per-attempt timeout 10 s.                        | An upstream `Retry-After` above 10 s is passed to the agent as `retry_after_s` instead of slept on.                                                                                                                                                                                                                                                                                                                                                |
| Circuit               | Code 44 (org blocked): open 60 s. 5 consecutive failures after retries: open 30 s, then one half-open probe                                                      | Stops agents from extending a Zoho block or hammering an outage.                                                                                                                                                                                                                                                                                                                                                                                   |
| Free text             | Zoho notes and descriptions truncated to 500 chars inside `untrusted_text`                                                                                       | Size and injection surface.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Request body          | 64 KB per MCP request                                                                                                                                            | `/mcp` and `/mcp/demo`.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| HTTP rate limits      | `/mcp`: 600 requests/min per key. `/mcp/demo`: 60/min per caller IP (IPv6 per /64; trusted egress ranges share 300/min). Both answer HTTP 429 with `Retry-After` | These are transport limits in front of the tools, separate from the Zoho governor.                                                                                                                                                                                                                                                                                                                                                                 |

The live governor key is `zoho:{dc}:{organization_id}`: one budget (per-minute window, concurrency leases, daily
share, circuit) per Zoho organization, shared by every tenant and key connected to it, because Zoho's limits are per
organization. In v1 each connect still creates a new tenant and key
([ADR-0008](adr/0008-tenant-per-connect-and-disconnect.md)); those tenants now share the organization's budget. The
cache stays per tenant (`zoho:{tenant_id}:{organization_id}:`). Demo sessions use `demo:{session}`.

### The public demo

- Each caller gets an isolated demo session: its own FakeZoho instance, governor key (`demo:{session}`), cache prefix
  and budget (free-plan profile: 80/min, 4 concurrent, 500/day). Sessions come from the `X-MB-Session` header
  (8-64 chars of `A-Za-z0-9_-`); without it the server derives an `ip-…` session from the caller's IP bucket, and
  clients cannot claim an `ip-` id.
- `X-MB-Faults` (comma list of `rate_limit_44`, `expired_token`, `daily_quota_45`, `concurrency_1070`, `server_5xx`,
  `malformed`) simulates Zoho failures, and applies only together with a valid client `X-MB-Session`, so one caller
  cannot break the shared IP session of everyone behind the same NAT or egress range. The header is never silently
  ignored: an unknown fault name, or faults without a valid `X-MB-Session` (missing, malformed or a reserved `ip-`
  id), get **HTTP 400** with a message naming the problem and the valid values. The faults actually applied are
  echoed in the `X-MB-Applied-Faults` response header (`none` when there are none).
- An empty `X-MB-Faults` means no faults. `X-MB-Applied-Faults` is exposed to browsers by CORS on `/mcp/demo`.
- Demo results carry the governor trace in `_meta["dev.merchantbridge/trace"]` (the demo session id, the faults
  applied, decisions, upstream calls, retries, cache hits); `/mcp` never sends it. With `expired_token`, Zoho answers
  401, the client refreshes the access token once (single-flight) and the trace shows a `token_refreshed` decision
  followed by one `retried` decision (reason `token_refreshed`, no backoff); the explorer and playground chips read
  "token refreshed" and "retried after token refresh".
- The dataset is rebuilt each UTC day so relative due dates stay true; ids such as `pay_DEMO8xK2`, `CHAI-250`,
  `SO-00012` are stable.

## DATA HANDLING

- **PII masking.** Email `r***@example.com`, phone/mobile `***1234`. Emails and 10+ digit phone numbers embedded in
  customer and company names and in free text are masked the same way; reference numbers, UTRs and tracking numbers
  are not. Customers come back with a city only, never a street address.
- **Untrusted text.** Anything a merchant or customer typed in Zoho (item descriptions, order and invoice notes,
  customer notes) is returned as `{ "untrusted_text": "..." }`. It is data, never instructions. The demo dataset plants
  a prompt injection in an item description; a contract test and an eval check that it stays inside `untrusted_text`
  and is not obeyed.
- **Audit trail.** Exactly one `usage_event` per tool call, success or error: time, request id, tenant, organization,
  tool, client name (an unauthenticated telemetry label), status, error code, duration, upstream calls, cache hits,
  retries, result size, and arguments restricted to the tool's declared argument names with free text replaced.
  No result data, no tokens. Kept 30 days, deleted by a daily job.
- **No mirroring.** Zoho data is not stored in our database. The only copy is the short-TTL cache: items and item details
  60 s; organization data 300 s. Orders, invoices, payments and customers are always fetched fresh.
  Cache keys include tenant and organization (or the demo session).
- **Secrets.** Refresh tokens encrypted at rest; access tokens encrypted in Redis for at most 55 min; API keys stored
  as SHA-256 and shown once. Logs carry paths without query strings and never tokens, auth codes, SQL parameters or
  unmasked contact details.

## ERRORS

Errors are ordinary tool results with `isError: true` and
`{ "error": { "code", "message", "retryable", "retry_after_s"?, "hint"? } }`. Messages are safe to show to a model:
no upstream bodies, URLs or tokens. JSON-RPC errors are used only for an unknown tool name or a malformed request.

| Code                    | Means                                                                                                                        | Retryable      | What the agent should do                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`         | Bad or missing arguments, a cursor from another query, Zoho rejected a parameter (HTTP 400), or the result is too large      | no             | Fix the arguments per `hint`: pass ids and cursors exactly as returned, dates as `YYYY-MM-DD`, exactly one of the alternative inputs; lower `limit` or narrow filters.              |
| `NOT_FOUND`             | No record with that id, number, SKU or reference                                                                             | no             | Tell the user; search (`zoho_search_*`, `zoho_list_*`) instead of guessing ids. For sales-order numbers, the hint says whether only the first 600 orders Zoho returns were checked. |
| `RATE_LIMITED`          | Our per-minute ceiling or concurrency queue timed out, or Zoho blocked the org (code 44) or rejected concurrency (code 1070) | yes            | Wait `retry_after_s`, make fewer calls in parallel, then retry once. Do not loop; prefer one list call over many get calls.                                                         |
| `DAILY_QUOTA_EXHAUSTED` | Today's 50% share is used, or Zoho returned code 45                                                                          | no             | Stop calling tools today; answer from what was already retrieved and say the limit resets at 00:00 UTC (`retry_after_s` is the time left).                                          |
| `RECONNECT_REQUIRED`    | No active Zoho connection for this key: revoked at Zoho, refresh token expired or evicted, or the merchant disconnected      | no             | Tell the user the merchant must reconnect Zoho Inventory at `/connect` (which issues a new key). Optionally call `zoho_get_connection_status` once to confirm.                      |
| `SCOPE_NOT_GRANTED`     | Zoho refused the data for this connection (HTTP 403 or code 57)                                                              | no             | Tell the user which data is unavailable; reconnecting grants all 8 read scopes.                                                                                                     |
| `UPSTREAM_ERROR`        | Zoho 5xx, timeout or network failure after retries, a paused circuit, an unreadable response, or another Zoho error          | if `retryable` | If `retryable`, retry once after `retry_after_s` (when present); otherwise report what could not be retrieved and call `zoho_get_connection_status`.                                |

Transport-level failures are not tool results: `/mcp` answers HTTP 401 for a missing, malformed or revoked key and
429 (with `Retry-After`) when its per-key or per-IP limit is hit.

## DISCONNECT

The merchant can switch the connector off without visiting Zoho:

```sh
curl -X POST API/api/connection/disconnect -H "Authorization: Bearer mb_live_…"
# 200 {"revoked_locally":true,"revoked_at_zoho":true,"had_connection":true}
```

It revokes the Zoho refresh token at Zoho, drops the cached access token, marks the connection revoked and revokes
the calling key. If Zoho cannot be reached, the local revocation still happens and `revoked_at_zoho` is `false`.
Afterwards the key gets HTTP 401 everywhere. Revoking from the Zoho side instead (Zoho Accounts, Connected Apps) makes
tool calls return `RECONNECT_REQUIRED` once Zoho rejects the token; the key itself stays valid until disconnected.

## FRESHNESS AND PROVENANCE

Every successful result carries `meta`:

- `as_of`: when MerchantBridge produced the result (ISO 8601). `cached: true` means it came from the short-TTL cache
  (at most 60 s old for items and stock, 300 s for organization data).
- `zoho_url`: a link into the Zoho Inventory web app for single-record results (item, sales order, invoice, payment,
  a single matching customer, organization); `null` for lists. The hash routes are UNVERIFIED against a real org.
- `organization_id`, `budget_remaining_today` (governor calls left today), and `demo` (`true` only on `/mcp/demo`).

Agents should quote `as_of` for stock and balances, which change minute to minute, and should not present cached
stock as live.
