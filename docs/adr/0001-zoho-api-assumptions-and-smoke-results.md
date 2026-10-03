# ADR-0001: Zoho API assumptions and smoke results

## Context

The Zoho Inventory OpenAPI files and Accounts pages vendored in `docs/vendor/zoho/` leave gaps that change our design:
no documented filters on `/salesorders`, an undocumented `serverinfo` shape, unknown `api_domain` values, no
`Retry-After` or block-duration semantics for 429s, no documented field for Razorpay payment references, and two
conflicting authorization-code lifetimes (60 s vs 2 min). Claude Code cannot verify these: tests never call real
Zoho, and `pnpm smoke` (GET-only probes against the trial org with the DEV OAuth client) is run by the human only.
The probe list and the evidence for each assumption are in `docs/notes/zoho.md` section 9 (P-1 ... P-23).

## Decision

1. Build against the documented surface only. Every undocumented parameter, field or behaviour is tagged
   `// UNVERIFIED` in code and has a probe in `scripts/smoke.ts`.
2. Until a probe says otherwise, use the conservative default:
   - auth code: exchange immediately (assume 60 s);
   - `api_domain`: accept only if it matches the static DC table, else use the table;
   - `/salesorders`: no server-side filters; bounded scan (ADR-0006);
   - per-module "not found" detection: HTTP 404 or a body `code` whose message says "does not exist";
   - payment references: search `reference_number` on customer payments, then invoices (exact);
   - deep links: `zoho_url: null`;
   - plan detection: `free` unless `plan_name` maps cleanly.
3. The human runs `! pnpm smoke` once on day 0 and after any Zoho-facing change, pastes sanitized output (no tokens,
   no customer PII), and Claude fills the table below and amends PLAN.md / notes / code where reality differs.

## Results (fill after `! pnpm smoke`)

Run date: `____` · Org DC: `in` · Client: DEV · Smoke commit: `____`

| Probe | Question                                                                                                                    | Observed | Decision / follow-up |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------- |
| P-1   | `serverinfo` JSON shape                                                                                                     |          |                      |
| P-2   | callback `location` for IN                                                                                                  |          |                      |
| P-3   | token `api_domain` for IN                                                                                                   |          |                      |
| P-4   | authorize at user DC accounts server                                                                                        |          |                      |
| P-5   | revoke DC (app home vs user)                                                                                                |          |                      |
| P-6   | bad refresh token: status + body                                                                                            |          |                      |
| P-7   | `/organizations` `plan_name` / `plan_type`                                                                                  |          |                      |
| P-8   | `page_context` on each list; `per_page=201`                                                                                 |          |                      |
| P-9   | location stock fields: string or number                                                                                     |          |                      |
| P-10  | SO detail embeds without packages/invoices scope                                                                            |          |                      |
| P-11  | missing scope: status + code                                                                                                |          |                      |
| P-12  | non-zero `code` with HTTP 200                                                                                               |          |                      |
| P-13  | `/itemdetails` with 25 ids                                                                                                  |          |                      |
| P-14  | `/salesorders` filters honoured? (`search_text`, `customer_id`, `status`, `date_start`, `salesorder_number`, `sort_column`) |          |                      |
| P-15  | `/salesorders?salesorder_ids=` batch                                                                                        |          |                      |
| P-16  | default `/salesorders` order                                                                                                |          |                      |
| P-17  | where `pay_TEST…` refs land; `reference_number_contains` / `search_text` match                                              |          |                      |
| P-18  | invoice -> sales order linkage field                                                                                        |          |                      |
| P-19  | `/packages?salesorder_number_contains=` with string                                                                         |          |                      |
| P-20  | `/packages` list response key                                                                                               |          |                      |
| P-21  | web-app deep-link pattern                                                                                                   |          |                      |
| P-22  | not-found status/code per module                                                                                            |          |                      |
| P-23  | rate-limit headers on normal responses                                                                                      |          |                      |

## Consequences

- Day-0 risk is contained: wrong guesses fail in smoke, not in the reviewer's demo (the public demo runs on FakeZoho
  and never depends on these answers).
- FakeZoho must mirror whatever smoke observes (error codes, response keys, string-typed numbers), so the contract
  suite keeps proving both backends.
- Some features may shrink after smoke (e.g. tier 1 of the sales-order fallback); the CAN/CANNOT doc changes with them.

## Status

Accepted (assumptions). Results pending the human smoke run.
