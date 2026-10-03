# ADR-0006: Sales-order search fallback

## Context

`GET /salesorders` documents only `page`, `per_page` and a bulk-delete artifact `salesorder_ids`; no search, customer,
status, date or sort parameters (salesorders.yml#list_sales_orders and the HTML page agree). Default ordering is
undocumented. Two scenarios need filtered orders: RTO Shield ("has this customer cancelled before?") and lookups by
SO number. Related documented paths: `/items/transactions/salesorders` (requires `item_id`; supports `customer_id`,
`status`), `/invoices?customer_id=`, `/packages?customer_id=` / `salesorder_number_contains` (only orders that have a
package), and `GET /salesorders/{id}` (full detail).

## Decision

v1 ships the simplest honest option and keeps the richer chain as future work.

**Built (v1):**

- Unfiltered `zoho_list_sales_orders` pages straight through `/salesorders` with `page`/`per_page`.
- Any filter (customer, status, date range) triggers a **bounded scan**: at most 3 pages x 200 of `/salesorders`
  (the first 600 orders Zoho returns), filtered on our side. Zoho documents no sort order, so these are the most
  recent orders only if Zoho lists newest first (UNVERIFIED, probe P-16). Every scan checks the order it actually
  got: the result carries `data.scan: { bounded, scanned, max_scanned, more_beyond_scan, order_verified }`, where
  `order_verified` is true when the scanned orders' dates never increase (newest first, across page boundaries) and
  false when unchecked orders may be newer. The agent can then say "not found in the first 600 orders Zoho returned"
  instead of "not found", and knows whether that window really was the most recent one. Tool descriptions say "the
  first 600 orders Zoho returns (believed newest first; see data.scan.order_verified)".
- `zoho_get_sales_order` takes `salesorder_id` (direct `GET /salesorders/{id}`) or `salesorder_number` (same bounded
  scan, then the detail call).
- Server-side filters sit behind `SERVER_SIDE_SO_FILTERS = false` in
  `packages/zoho-inventory/src/tools/list-sales-orders.ts`, marked UNVERIFIED; flip it only after `pnpm smoke` proves
  Zoho honours them (ADR-0001 P-14).

**Not built (planned, in order):**

1. Verified server filters (the flag above) once smoke passes.
2. Customer -> related documents: `/invoices?customer_id=` and `/packages?customer_id=` (both documented) to reach
   orders beyond the scan window; `/items/transactions/salesorders` only when the item is known.
3. `/packages?salesorder_number_contains=` for number lookups (finds only orders that already have a package).

## Consequences

- Correct answers for merchants with up to 600 orders in total (the scan then sees everything,
  `more_beyond_scan: false`, whatever the order); explicit, honest bounds for larger ones, documented in
  `docs/agent-capabilities.md`. If smoke shows Zoho does not list newest first, `order_verified` is false on every
  scan and the window is not "recent" at all; tier 2 below becomes the priority.
- Worst case 3 upstream calls per filtered list request (plus 1 for a number lookup's detail call), counted against
  the daily share like everything else.
- If smoke shows server-side filters work, flipping the flag removes the scan cost and the bound disappears from the
  docs.
- FakeZoho ignores undocumented `/salesorders` params (as the real API is assumed to), so tests prove the scan rather
  than a filter that may not exist.

## Status

Accepted. v1 = bounded scan; server filters pending smoke; tiers 2-3 not built.
