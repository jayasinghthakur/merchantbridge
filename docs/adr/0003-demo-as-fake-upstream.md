# ADR-0003: The public demo is a fake upstream, not a fake app

## Context

Reviewers must be able to try the connector in 3 minutes without logging in, and the demo must never touch a real
merchant's data or spend a real Zoho quota. A common shortcut is a separate "demo mode" with canned responses inside
the tools. That proves nothing about the real client, mappers, governor, error handling or MCP server, and drifts
from production code.

## Decision

FakeZoho is a **fetch transport that speaks Zoho's wire format**: `code != 0` bodies, `page_context`, HTTP 401 for an
expired token, 429 with codes 44/45/1070, 5xx, malformed JSON, and the documented response keys (including quirks such
as string-typed stock numbers). The real `ZohoClient`, mappers, tools, governor, `ToolRuntime` and MCP server run
unchanged on top of it. The demo tenant ("Chai & Co (DEMO)": ~40 items in 2 locations, 25 sales orders with tracking,
15 invoices, 10 payments with `pay_DEMO…` refs, 12 customers, one planted prompt injection) is data for the fake
transport.

- `/mcp/demo` and the playground are bound to the demo tenant + FakeZoho by construction; their factory has no code
  path that loads a live connection.
- Fault toggles (`rate_limit_44`, `expired_token`, `daily_quota_45`, `concurrency_1070`, `server_5xx`,
  `malformed`) inject wire-level failures per session; governor and fault state are keyed `demo:{session}` so one
  reviewer cannot break another's demo.
- One contract suite runs every tool against FakeZoho and against PII-scrubbed recorded fixtures from the trial org.

## Consequences

- The public demo exercises exactly what live tenants get, including 429 backoff and token refresh; the trace pane
  shows real governor decisions.
- FakeZoho must track reality: smoke results (ADR-0001) and recorded fixtures are the source; a fixture diff test
  catches drift.
- The same pattern is the template for connector #2 (`docs/platform-feedback.md`).
- Zoho trial expiry (14 days) never breaks the demo.

## Status

Accepted.
