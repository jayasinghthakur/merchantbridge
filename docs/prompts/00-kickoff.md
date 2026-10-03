# 00 Kickoff (paste into a fresh session, plan mode)

**Goal:** load context and surface gaps before any milestone. Write no code and edit no files.

**Read first:** `CLAUDE.md`, `docs/PLAN.md`, `docs/STATUS.md`, `docs/notes/zoho.md`, `docs/notes/mcp-v2.md`,
`docs/notes/anthropic-mcp.md`, `docs/agent-capabilities.md`, `docs/adr/*`, every file in `packages/core/src/`.

**Then reply with:**

1. In <= 12 bullets: what MerchantBridge is, the two auth legs, the tool list, and the 10 golden rules.
2. Current state from `docs/STATUS.md` and `git log --oneline -20`: what exists, what is next.
3. Every conflict you see between PLAN, CLAUDE.md, notes, ADRs and the code, each with a proposed resolution.
4. Every UNVERIFIED fact the next milestone depends on, and which smoke probe (P-n) settles it.
5. The milestone you recommend next and why.

**Rules for this session:** do not run `pnpm smoke`; do not read `.env*`; do not install packages; ask one specific
question if anything blocks you. Wait for `/milestone Mx` (or the M-prompt pasted) before planning code.

**Loop every milestone follows:** `/clear` -> branch -> plan mode -> prompt -> approve -> red tests committed first ->
implementation -> `/verify` -> `/code-review high` (+ `/security-review` on M2-M4) -> `/simplify` -> `/ship` ->
update `docs/STATUS.md`.
