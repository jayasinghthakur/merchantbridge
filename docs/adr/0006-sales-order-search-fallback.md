# ADR-0006: Sales-order search fallback

## Context

`GET /salesorders` documents only `page`, `per_page` and a bulk-delete artifact `salesorder_ids`; no search, customer,
status, date or sort parameters (salesorders.yml#list_sales_orders and the HTML page agree). Default ordering is
undocumented. Two scenarios need filtered orders: RTO Shield ("has this customer cancelled before?") and lookups by
SO number. Related documented paths: `/items/transactions/salesorders` (requires `item_id`; supports `customer_id`,
`status`), `/invoices?customer_id=`, `/packages?customer_id=` / `salesorder_number_contains` (only orders that have a
package), and `GET /salesorders/{id}` (full detail).

## Decision

`zoho_list_sales_orders` resolves filters through this chain and reports which tier answered (`data.source`):

1. **Verified server filters.** Only parameters that `pnpm smoke` proves Zoho honours (ADR-0001 P-14). Until then this
   tier is disabled.
2. **Customer -> related documents.** For a customer filter: `zoho_search_customers` gives `customer_id`; invoices for
   that customer come from `/invoices?customer_id=` (documented), and packages from `/packages?customer_id=`, each
   carrying `salesorder_id`/`salesorder_number` where available. `/items/transactions/salesorders` is used only when
   the item is also known.
3. **Packages by SO number.** `/packages?salesorder_number_contains=` for number lookups; finds only orders that
   already have a package.
4. **Bounded scan.** At most 3 pages x 200 of `/salesorders` (the 600 most recent if the default order is newest
   first, P-16), filtered on our side by customer, status, date or number. The result includes
   `scan: { pages, scanned, bound_hit }` so the agent can say "not found in the 600 most recent orders".

Exact SO ids always go straight to `GET /salesorders/{id}`.

## Consequences

- Correct answers for small and mid-size merchants (most have < 600 recent orders); explicit, honest bounds for larger
  ones, documented in `docs/agent-capabilities.md`.
- Worst case 3 upstream calls per list request; counted against the daily share like everything else.
- If smoke shows server-side filters work, tier 1 removes the scan cost and the bound disappears from the docs.
- FakeZoho ignores undocumented `/salesorders` params by default (like the real API is assumed to), so tests prove the
  fallback rather than a filter that may not exist.

## Status

Accepted. Tier 1 pending smoke.
