---
description: Verify the deployed MerchantBridge. Checks API health, the MCP tools/list on prod /mcp/demo, a Playwright smoke run, and screenshots at 390 and 1440 px in light and dark that are read back for defects.
argument-hint: '[api-base-url] [web-base-url]'
disable-model-invocation: true
---

# /verify-prod $ARGUMENTS

Read-only checks against production. Nothing here deploys, changes secrets or touches real Zoho data: `/mcp/demo`
is bound to the demo tenant and FakeZoho.

## 0. Resolve the URLs

- API base: `$0`, or else `$MB_API_URL`. Web base: `$1`, or else `$MB_WEB_URL`.
- If either is missing, ask the user for it. Never guess a host. Strip any trailing `/`.

## 1. API health

```bash
curl -sS --max-time 15 -w '\nHTTP %{http_code} in %{time_total}s\n' "$API/health/live"
curl -sS --max-time 15 -w '\nHTTP %{http_code} in %{time_total}s\n' "$API/health/ready"
```

Pass when both return 200 and `/health/ready` reports db and redis as ok. Quote the JSON, which holds no secrets.
Note the Upstash command count if it is present.

## 2. MCP on prod /mcp/demo

```bash
npx @modelcontextprotocol/inspector --cli "$API/mcp/demo" --transport http --method tools/list --format json
```

- Run it twice. Extract the tool names in order (`jq -r '.result.tools[].name'`). They must be identical both times
  and must match `docs/mcp-tools.json`, in the same order and with the same count.
- Run it once more with `--strict` added, and report any schema portability problems.
- Run one real call: `--method tools/call --tool-name zoho_get_item --tool-arg sku=CHAI-250 --format json`. Expect
  `structuredContent.data` with per-location stock and `meta.demo: true`.
- Run one bad call: `--tool-arg sku=` (empty). Expect `isError: true` with `INVALID_INPUT`, not a JSON-RPC error.

## 3. Web smoke (Playwright)

1. `curl -sS -o /dev/null -w 'HTTP %{http_code}\n' "$WEB"` must print 200. Do the same for `/playground`, `/tools`
   and `/docs`.
2. If `apps/web` has a prod Playwright config or project (look for `playwright.prod.config.ts`, or a
   `PLAYWRIGHT_BASE_URL` / `E2E_BASE_URL` switch in `playwright.config.ts`), run it against `$WEB` and quote the
   summary line. The default config runs `next dev` with a mocked API, so it is not a prod check. If no prod config
   exists, say so and continue with step 4.
3. If the Playwright MCP server is connected (see `.mcp.json.example`), use it on prod to click one scenario card.
   Confirm that at least one tool step appears and that an answer arrives. Run the card only once, because every
   run spends from the Anthropic budget.

## 4. Screenshots: capture and read back

Capture `/` and `/playground` at 390 px and 1440 px, in light and dark mode (8 files). Save them under the
scratchpad, not in the repo:

```bash
npx playwright screenshot --viewport-size "390, 844"  --color-scheme light --full-page --wait-for-timeout 1500 "$WEB/" <dir>/home-390-light.png
npx playwright screenshot --viewport-size "1440, 900" --color-scheme dark  --full-page --wait-for-timeout 1500 "$WEB/playground" <dir>/playground-1440-dark.png
# …and so on for all 8 combinations
```

If `npx playwright` reports a missing browser, run it from `apps/web` (`pnpm --filter @mb/web exec playwright …`).

**Read every PNG back** with the Read tool and list concrete defects, each with its file name. Check for:

- horizontal overflow or clipped text at 390 px;
- the **DEMO DATA** badge not visible;
- the not-affiliated footer missing;
- poor contrast in dark mode;
- broken loading, empty or error states;
- Razorpay logos or trade dress;
- gradients or emoji (the brand rules forbid both).

## Report

| Check                                           | Result                      | Evidence                 |
| ----------------------------------------------- | --------------------------- | ------------------------ |
| /health/live, /health/ready                     | PASS / FAIL                 | status + key fields      |
| tools/list stable + matches docs/mcp-tools.json | …                           | N tools, first/last name |
| tools/call good / bad                           | …                           | …                        |
| Web pages 200                                   | …                           | …                        |
| Playwright prod smoke                           | PASS / FAIL / NOT AVAILABLE | summary line             |
| Screenshots (8) read back                       | n defects                   | list                     |

Report only what you observed in this session. Do not mark a row PASS from memory or from an earlier run.
