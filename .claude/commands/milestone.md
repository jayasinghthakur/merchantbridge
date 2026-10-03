---
description: Run one MerchantBridge milestone end to end. Plan with an approval gate, red tests first, build, run the Done-when commands, update docs/STATUS.md.
argument-hint: '<milestone id, e.g. M1>'
disable-model-invocation: true
---

# /milestone $ARGUMENTS

You are running milestone **$0** of MerchantBridge. CLAUDE.md's golden rules apply throughout.

## 1. Load context (read-only)

1. Find the prompt: `docs/prompts/$0.md`, or else the single match of `docs/prompts/$0-*.md`. If there is no match,
   list `docs/prompts/` and stop. Do not guess which milestone was meant.
2. Read the whole prompt, then `docs/STATUS.md` (if it is missing, say so; you will create it in step 6), then every
   file the prompt lists under **Read first**. Use `docs/notes/*.md` for Zoho, MCP v2 and Anthropic facts instead of
   re-researching them.
3. Run `git status --short` and `git branch --show-current`. If you are on `main`, propose a branch name
   `feat/$0-<slug>`, but create it only after the plan is approved.

## 2. Plan (no edits until approved)

Stay in plan mode. If the session is not in plan mode, do not edit anything: present the plan and wait. Present:

- **Goal**: one sentence, in the prompt's words.
- **Current state**: what already exists and works (from STATUS.md and the code), so you do not rebuild it.
- **Tests first**: each red test, the file it goes in, and the reason it fails today.
- **Build steps**: small and ordered, with the files each step touches.
- **Zoho facts used**: every endpoint, param, field or scope you will rely on, with its source in
  `docs/vendor/zoho/` or `docs/notes/zoho.md`. Anything else is marked `UNVERIFIED` and gets a probe in
  `scripts/smoke.ts`. For Zoho-facing work, offer to run the `zoho-verifier` subagent on the plan.
- **What I will NOT do**: the prompt's Out-of-scope list, plus anything you were tempted to add. This always
  includes: no `packages/core` contract change without an ADR, no reading `.env*`, no real Zoho calls, and no
  human-only commands (`pnpm smoke`, `fly secrets`, `vercel env`).
- **Done when**: the prompt's commands, copied verbatim. Mark each one _agent-run_ or _human-only_.
- **Risks and open questions**: ask at most 3 specific questions. Do not guess an API shape.
- **Commits**: the conventional-commit sequence, with the red-tests commit first.

Then stop and wait for explicit approval. If the user changes the plan, restate the changed parts before you start.

## 3. Red tests first

1. Create the agreed branch.
2. Write the tests. Run them and show the real failing output, which must fail for the reason the plan gave. A test
   that already passes is not a red test: say so and adjust it.
3. Commit them alone: `test(<scope>): <what> (red)`.

## 4. Build

- Implement in the planned order. After each step, run that package's tests
  (`pnpm --filter @mb/<pkg> test`) and typecheck.
- Follow CLAUDE.md's tool conventions. For a new tool, use the `add-tool` skill.
- If reality and the plan disagree (for example a Zoho shape or a library API), stop and explain. Write an ADR in
  `docs/adr/` if the plan has to change.
- Commit in small conventional commits (`feat(zoho): …`, `fix(api): …`).

## 5. Done-when gate

- Run every _agent-run_ Done-when command exactly as written. Quote the last relevant lines of real output for
  each. Never write "should pass" or "passes" for a command you did not run in this session.
- For _human-only_ items (prod deploys, `! pnpm smoke`, OAuth on prod, video), list exact instructions for the
  human and mark them **pending human**. Do not mark them done.
- Run `/verify`. Suggest `/code-review high`, and `/security-review` for auth, governor or public-route work.
  Offer the `security-reviewer` subagent for M2–M4 diffs.

## 6. Update docs/STATUS.md

Keep the file under about 60 lines and replace stale content instead of appending. Use these sections:

- **Done ($0)**: what shipped, with the commit hashes.
- **Evidence**: each Done-when command → PASS / FAIL / pending human, with a one-line excerpt.
- **Next**: the next milestone and its first step.
- **Open questions / UNVERIFIED**: anything smoke or the human still has to answer.

Commit it with `docs(status): update after $0`. Then suggest `/ship`.
