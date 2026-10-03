# M3 — The 12 tools and the MCP server

Read SPEC "v1 scope" and "MCP tool specification". Plan mode; show me all 12 tool descriptions for review before coding handlers.

1. Record fixtures: write `scripts/record-fixtures.ts` (human-run against my trial org) that saves responses for each endpoint,
   scrubbing emails/phones/addresses. Until I run it, hand-write realistic fixtures from Zoho's documented shapes.
2. Implement in `connectors/zoho-inventory/src/tools/` (one file per tool, each with mapper + tests):
   zoho_list_organizations, zoho_list_items, zoho_get_item, zoho_check_stock (bulk fetch, ≤25 SKUs),
   zoho_list_sales_orders, zoho_get_sales_order (with packages, shipments, invoices), zoho_list_invoices, zoho_get_invoice,
   zoho_search_customers, zoho_search (cross-entity), zoho_find_by_payment_reference, zoho_get_usage.
3. Envelope, opaque cursors, field allow-lists, `untrusted_text` wrapping, error codes + hints — exactly per CLAUDE.md.
4. `apps/mcp-server`: official MCP TS SDK; register tools from the connector manifest with annotations;
   transports: stdio (`--stdio`) and Streamable HTTP (`/mcp`, auth via `Authorization: Bearer mb_…` tenant key).
   Capture `clientInfo.name` from initialize for telemetry.
5. `pnpm gen:tools` → `docs/mcp-tools.json` from the live tools/list. Add a test that fails if it is stale.
6. Write `docs/agent-capabilities.md` (can / cannot, from SPEC) and example Claude Desktop + Agent Studio config snippets.

Done when: MCP Inspector lists 12 tools, each call works against fixtures, and I can ask Claude Desktop
"Is SKU X in stock?" against my real org.
