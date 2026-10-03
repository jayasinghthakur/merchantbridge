# MerchantBridge — Claude Code starter kit

Drop these files into an empty `merchantbridge/` repo:

```
merchantbridge/
├── CLAUDE.md                 # rules Claude Code reads every session
├── .claude/settings.json     # permissions + auto-format hook
└── docs/
    ├── SPEC.md               # export the "MerchantBridge — Product & Engineering Spec" doc as Markdown, save here
    └── prompts/
        ├── 00-kickoff.md     # paste first; Claude summarizes and flags gaps, writes no code
        ├── M0-scaffold.md
        ├── M1-sdk-client-auth.md
        ├── M2-rate-governor.md
        ├── M3-tools-mcp.md
        ├── M4-payments-evals.md
        ├── M5-telemetry-dashboard.md
        └── M6-ship.md
```

## How to run a milestone
1. `cd merchantbridge && claude`
2. Press Shift+Tab for plan mode, then: `Read docs/prompts/M1-sdk-client-auth.md and follow it.`
3. Review the plan, correct it, approve. Let it build and test.
4. Review the diff, commit, `/clear`, next milestone.

## Before M1
- Zoho Inventory trial org on the India DC (inventory.zoho.in), with ~20 items, ~10 sales orders, ~5 invoices.
  Put fake Razorpay ids like `pay_TEST123abc` in a few invoice reference numbers.
- Zoho API console (api-console.zoho.in) → Self Client → generate a code with the read scopes → exchange for a
  refresh token → put values in `.env` yourself (Claude Code is blocked from reading it).

Note: permission-rule and hook syntax evolves; if Claude Code warns about `.claude/settings.json`, check the current
settings docs and adjust.
