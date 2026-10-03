---
description: Run MerchantBridge's local checks (lint, typecheck, tests including the contract suite, mcp-tools.json staleness) and report each command's real output. Use before committing, before /ship, or whenever asked whether the build is green.
allowed-tools: Bash(pnpm lint) Bash(pnpm typecheck) Bash(pnpm test) Bash(pnpm gen:tools) Bash(git diff *) Bash(git status *)
---

# /verify

Run each check below in its own Bash call, in order. Do not hide the exit status: avoid pipes such as `| tail`, and
keep going after a failure so that the report is complete.

| #   | Check                                                 | Command                                                                                                                  |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Lint                                                  | `pnpm lint`                                                                                                              |
| 2   | Typecheck                                             | `pnpm typecheck`                                                                                                         |
| 3   | Tests (unit, failure and contract suites on FakeZoho) | `pnpm test`                                                                                                              |
| 4   | Tool spec staleness                                   | `pnpm gen:tools`, then `git diff --exit-code -- docs/mcp-tools.json` and `git status --porcelain -- docs/mcp-tools.json` |

Notes:

- For check 4, the spec is stale if the diff exits non-zero or `git status` shows the file as untracked or
  modified. If the `gen:tools` script does not exist yet (before M1), report the check as **SKIPPED**, give the
  reason, and do not count it as a pass.
- Do not run `pnpm smoke`, `pnpm evals` or anything that calls real Zoho or Anthropic. Those are human-run or
  cost money.

## Report

End with this table. Fill it only from output you saw in this session.

| Check          | Result                 | Evidence                                                                    |
| -------------- | ---------------------- | --------------------------------------------------------------------------- |
| Lint           | PASS / FAIL            | the last 1–3 lines of real output, e.g. the error count or the summary line |
| Typecheck      | …                      | …                                                                           |
| Tests          | …                      | `Test Files  N passed` / the first failing test name                        |
| mcp-tools.json | PASS / STALE / SKIPPED | …                                                                           |

Then add one line:

- If every row is PASS: `All checks passed (ran: lint, typecheck, test, gen:tools)`.
- Otherwise: `NOT green`, followed by the failing checks and the first concrete error of each, quoted verbatim, and
  a one-line next step.

Never write "passes", "green" or "should pass" for a check whose output you did not see in this session.
