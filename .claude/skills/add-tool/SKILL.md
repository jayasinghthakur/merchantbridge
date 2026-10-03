---
name: add-tool
description: Step-by-step for adding or changing a MerchantBridge MCP tool (zoho_<verb>_<noun>). Covers Zod input/output with .describe(), a "Use when / Don't use when" description, a mapper with a field allow-list, the FakeZoho dataset and filter support, the contract test, at least one eval case, pnpm gen:tools and the docs/agent-capabilities.md row. Use when creating a new zoho_* tool, adding a filter or field to an existing one, or when a milestone prompt says "add tool".
when_to_use: Trigger phrases - "add a tool", "new zoho_ tool", "expose X over MCP", "add a filter to zoho_list_*", "tool for shipments/stock/payments".
---

# Add a MerchantBridge tool

Work through these steps in order. Tests come before the implementation (step 6 before step 7). The connector lives
in `packages/zoho-inventory`; read `CLAUDE.md` ("Tool conventions") and `docs/notes/zoho.md` first.

## 0. Decide and verify the upstream call

- Name: `zoho_<verb>_<noun>` (`get_`, `list_`, `search_`, `find_`, `check_`), matching `/^[a-z][a-z0-9_]{2,63}$/`.
  Do not overlap an existing tool. If the job is close to one, extend that tool instead.
- Find the Zoho endpoint, every query param and every response field you will use in `docs/vendor/zoho/<module>.yml`
  (look under `operationId` → `parameters` and `components.schemas`). Note the operation's `security` scope.
- A param or field that is not there, or appears only in prose ("Variants: …_contains"), is **UNVERIFIED**:
  - put `// UNVERIFIED: <what>` in the code that depends on it;
  - add a GET probe to `scripts/smoke.ts` and a row to ADR-0001;
  - give the tool a documented fallback (see ADR-0006 for sales orders).
- Run the `zoho-verifier` subagent on this list before writing code.

## 1. Scopes

Use the `SCOPE.*` constants from `src/scopes.ts`. Every scope a tool lists must already be in `ZOHO_SCOPES`, because
`defineConnector` throws otherwise. Adding a new scope forces every merchant to re-consent, which burns one of 20
refresh tokens, so that change needs an ADR.

## 2. Upstream schema (`src/upstream.ts`)

Add a lenient Zod schema for the wire shape, plus an `envelopes.<key>` entry, for example
`z.object({ packages: list(zPackage), page_context: pageContextSchema })`. Parse every body with
`parseUpstream(envelopes.x, res.body)`. Zoho sends numbers as strings in some places and `""` for "unknown", so model
what the docs say and coerce in the mapper.

## 3. Output schema (`src/schemas.ts`), which doubles as the field allow-list

- `z.object({...})` listing only the fields an agent needs. Give every field a `.describe()` that states its unit or
  format.
- Money is `moneySchema` (`{ amount_minor, currency }`). Dates are ISO strings. Ids are strings.
- Free text from Zoho (notes, descriptions, addresses) uses `untrustedSchema` (`{ untrusted_text }`).
- Email and phone are returned masked only.
- Unknown keys are stripped when the runtime parses `data` with this schema, so a field that is not listed never
  leaks.

## 4. Mapper (`src/mappers.ts`)

Write a pure function `toX(upstream, currency) → X`. Use `money()`/`toMoney()` for amounts, `isoDate()` for dates,
`maskEmail`/`maskPhone`, and `untrusted()`. Copy fields explicitly; never spread an upstream object. Cap nested
arrays the same way `MAX_LINE_ITEMS` does.

## 5. Input schema and description (`src/tools/<kebab-name>.ts`)

- Build inputs from `./shared`: `idInput`, `limitInput` (default 20, max 100), `cursorInput`, `dateInput`,
  `searchText`, and `exactlyOne([...])` for get-by-id-or-number. Give every field a `.describe()` with an example
  (`"Exact SKU, e.g. \"CHAI-250\""`). No input may be a URL, a path, or raw Zoho params.
- The description has four parts, in this order:
  1. what it returns;
  2. "Use when …", with the keywords users type (SO number, SKU, warehouse, `pay_`, UTR, tracking);
  3. "Don't use when … (use zoho_x instead)";
  4. its limits.
     End with `READ_ONLY`. Never promise a filter the handler does not apply.
- In the handler, use `defineTool({...})` from `./shared`. Every Zoho call goes through `ctx.client.get(path, query,
{ cacheTtlMs })`, never `fetch`. Throw `ConnectorError('NOT_FOUND' | 'INVALID_INPUT', message, { hint })` with an
  actionable `hint`. Return `{ data, page?, upstreamUrl: client.webUrl(kind, id) }`.
- Lists use the opaque cursor helpers in `./shared`. Any client-side scan has a hard page bound, and the result says
  when the bound was hit.
- Register the tool in `src/connector.ts`. `tools/list` order is sorted by name automatically.

## 6. Tests first (commit them red)

- `packages/zoho-inventory/test/contract.test.ts`: add a `CASES` entry with these keys:
  - `valid`: at least 2 arg sets, including one per filter;
  - `bad`: wrong types, out-of-range `limit`, a malformed id or date, and an extra-filter conflict;
  - `unknown`: an id that does not exist (expect `NOT_FOUND`);
  - `maxLimit`: `{ limit: 100 }` for lists (checks the 10K-token budget).
    The suite already checks that the schema is valid, that bad args give `isError`, that each call emits exactly one
    usage event, that email/phone are masked, and that injected text stays inside `untrusted_text`.
- Add focused tests for the mapper (money in minor units, string-number coercion, `""` → null) and for every filter.
  Use FakeZoho through `test/helpers.ts`. Never call real Zoho.
- Run `pnpm --filter @mb/zoho-inventory test`, confirm the new tests fail for the right reason, and commit
  `test(zoho): add <tool> contract cases (red)`.

## 7. FakeZoho (`src/fake/dataset.ts`, `src/fake/server.ts`)

- Add records to the demo dataset ("Chai & Co (DEMO)") so every scenario and eval that uses the tool has data. Keep
  `DEMO_IDS` (`packages/core/src/scenarios.ts`) resolvable.
- Add the route and **only the documented filters** in `server.ts`, using the existing helpers (text variants, date
  ranges, `filterBy`). Mark undocumented behaviour `// UNVERIFIED`, exactly as in the client.
- Keep the fake wire-accurate: `code ≠ 0` on errors, `page_context`, the response keys from the OpenAPI, 401, 429
  codes 44/45/1070, 5xx and malformed bodies. All of these work through the existing fault plumbing.

## 8. Implement until green

Run `pnpm --filter @mb/zoho-inventory test`, then `pnpm typecheck` and `pnpm lint`.

## 9. Evals (at least one per tool)

Add a case under `evals/` (follow the existing case format): a natural question, `expectedTools` containing the new
tool, and the key facts the answer must contain. For a tool that could be misused, add a refusal or don't-use case
(for example a write request must make zero calls). Scenario cards live in `SCENARIOS`, and each one is also an eval.

## 10. Generated spec and docs

- `pnpm gen:tools` regenerates `docs/mcp-tools.json`. Commit it; the staleness test fails otherwise.
- Add or update the row in `docs/agent-capabilities.md`, under CAN for the right tier, in plain language. Update
  LIMITS if the tool adds a bound.
- If an UNVERIFIED fact was added, check that ADR-0001 and `docs/notes/zoho.md` §9 list its probe.

## 11. Finish

Run `/verify` and report its real output. Run the `zoho-verifier` subagent on the diff. Use conventional commits:
`feat(zoho): add zoho_<verb>_<noun>`.
