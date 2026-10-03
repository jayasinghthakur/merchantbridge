# packages/zoho-inventory

The connector: `src/client.ts` (the only file here that talks to Zoho), `src/tools/*` (one tool per file),
`src/mappers.ts` + `src/schemas.ts` (field allow-lists), `src/fake/*` (FakeZoho: wire-accurate fake upstream, demo
dataset, fault injection).

- Params and response shapes come from `docs/vendor/zoho/*.yml` only; anything else is `// UNVERIFIED` and gets a probe
  in `scripts/smoke.ts`. Use the `zoho-verifier` subagent on any diff that touches requests.
- Adding or changing a tool: follow the `add-tool` skill (`.claude/skills/add-tool/SKILL.md`).
- The output Zod schema is the allow-list: ToolRuntime parses `data` with it and strips unknown keys. Money via
  `toMoney`, free text via `untrusted()`, email/phone via `maskEmail`/`maskPhone`.
- `/salesorders` filters are UNVERIFIED: `SERVER_SIDE_SO_FILTERS` stays `false` until smoke proves them (ADR-0006).
  Filtered queries use the bounded 3 x 200 scan and must report `data.scan`.
- FakeZoho must keep matching Zoho's wire format (body `code` != 0 on HTTP 200 is an error, `page_context`, 429 codes
  44/45/1070, 401 for bad tokens). Every identifier in `packages/core/src/scenarios.ts` (`DEMO_IDS`) and in
  `evals/cases` must exist in `src/fake/dataset.ts`; dates are relative to `now`.
- Tests: `pnpm --filter @mb/zoho-inventory test`. The contract suite runs every tool through ToolRuntime on FakeZoho;
  `test/zohoapis-literal.test.ts` fails if the API host literal appears outside the client and the auth DC map.
