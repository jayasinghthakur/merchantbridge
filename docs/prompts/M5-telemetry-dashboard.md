# M5 — Usage events, audit, dashboard

Read SPEC "Observability, usage analytics and the monitoring dashboard" and "Business model" (for billing page).

1. `packages/telemetry`: write the usage event (exact schema in SPEC) to Postgres `usage_events` (batched inserts),
   OTel span per tool call, Prometheus metrics at `/metrics` (calls_total, errors_total by code, latency histogram,
   zoho_budget_remaining gauge). Audit log rows with masked PII.
2. `scripts/seed-demo.ts`: generate 30 days of realistic usage for 6 fake merchants (varied tools, clients, error spikes,
   one merchant near quota, one needing reconnect) so the dashboard looks alive in a demo.
3. `apps/dashboard` (Next.js App Router, Tailwind, Recharts, MerchantBridge theme tokens from CLAUDE.md, light + dark):
   pages Overview, Usage, API budget, Errors, Connections, Conflicts, Agent quality, Billing — each panel exactly as the SPEC table.
   Billing page: plan, included vs used calls, overage at plan rate, GST 18%, projected invoice (match the SPEC sample math).
   Connect page: "Connect Zoho Inventory" with region picker (default India) → gateway OAuth start.
4. Alerts module: evaluate thresholds from SPEC every minute; send email (console transport in dev) + Slack webhook.

Done when: `pnpm dev` + `pnpm seed:demo` shows every page populated; a live call from MCP Inspector appears within 5 s.
