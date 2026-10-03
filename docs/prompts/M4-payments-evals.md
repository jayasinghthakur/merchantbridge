# M4 — Payments linker, conflict checks, evals

1. `packages/payments-linker`: extract and classify Razorpay ids from any string — pay_, order_, rfnd_, sub_, plink_, inv_,
   plus 12-digit UPI UTRs (label as `upi_utr`, low confidence). Pure functions, table-driven tests incl. false positives.
   Apply to invoice/payment `reference_number`, notes and custom fields; expose `payment_refs[]` on outputs.
2. `zoho_find_by_payment_reference` uses Zoho search params where available, else scans recent invoices/payments
   (bounded pages; respect the governor). Document the bound.
3. Conflict checks (run on get/list outputs, emit `conflict` events, never block): paid invoice with no reference;
   same Razorpay ref on 2+ invoices; shipped order with negative available stock; duplicate SKUs; repeated code 45.
4. `evals/`: 25 questions (see SPEC "Testing") as YAML: question, expected tool calls (order-insensitive where sensible),
   answer assertions. Harness runs Claude via the Anthropic API against the MCP server on fixtures; prints a score table.
   Include refusal cases (delete/update requests must not be attempted).

Done when: `pnpm evals` ≥ 90% and the report is saved to `evals/reports/`.
