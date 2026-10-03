## Summary

<!-- 2–5 bullets: what changed and why. Link the milestone prompt (docs/prompts/Mx.md). -->

-

## Checks run

<!-- Only commands you actually ran, with real output. Never "should pass". -->

| Check     | Command                                                                         | Result |
| --------- | ------------------------------------------------------------------------------- | ------ |
| Lint      | `pnpm lint`                                                                     |        |
| Typecheck | `pnpm typecheck`                                                                |        |
| Tests     | `pnpm test`                                                                     |        |
| Tool spec | `pnpm gen:tools && git diff --exit-code docs/mcp-tools.json`                    |        |
| Done-when | _(each command from the milestone prompt; human-only items as "pending human")_ |        |

<details><summary>Output excerpts</summary>

```text

```

</details>

## Screenshots

<!-- UI changes: 390px and 1440px, light and dark. Otherwise "n/a (no UI change)". -->

## Risk

<!-- Blast radius and rollback. Call out anything touching: tokens/secrets, PII, tenant isolation, demo isolation,
     the governor or Zoho quota, public routes, UNVERIFIED Zoho facts (probe added to scripts/smoke.ts?). -->

-

Closes #
