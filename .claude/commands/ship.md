---
description: Open the pull request for the current milestone branch, with evidence. Covers the branch check, a conventional commit, the push, and gh pr create with the checks run, screenshots and Closes #n.
argument-hint: '[issue-number]'
disable-model-invocation: true
---

# /ship $ARGUMENTS

## 1. Preconditions (stop on any failure)

1. Run `git branch --show-current`. If it prints `main` or `master`, or prints nothing (detached HEAD), stop and
   propose a branch name (`feat/<milestone>-<slug>`). Never ship from main.
2. Run `git status --short`. Run `git diff --cached --name-only` and `git ls-files --others --exclude-standard`.
   Abort if any path is a `.env` or `.env.*` file (other than `.env.example`), or looks like a key, a dump or a
   screenshot of real data.
3. Evidence: if `/verify` has not run in this session since the last code change, run it now. If anything is not
   PASS, stop and report it. Do not open a PR with known-red checks unless the user explicitly asks for a draft.

## 2. Commit

- Stage only the files that belong to this change, by name. Do not use `git add -A`.
- Use a conventional commit: `type(scope): summary`, imperative, at most 72 characters. Types: feat, fix, test,
  docs, chore, refactor, ci, perf. Scopes: core, zoho, governor, auth, db, api, web, evals, ci, smoke, claude.
- If the work is already committed, skip this step.

## 3. Push

`git push -u origin HEAD`. Never force-push: the settings deny it. If the push is rejected, stop and explain.

## 4. Resolve the issue number

Use `$0` if it was given. Otherwise take the number from the branch name, or from
`gh issue list --state open --search "<milestone id>"`. If it is still ambiguous, ask the user. Do not invent one.

## 5. Open the PR

Write the body to a temporary file in the scratchpad and pass it with `--body-file`. Follow
`.github/pull_request_template.md`:

```markdown
## Summary

- <2–5 bullets: what changed and why; link docs/prompts/<id>.md>

## Checks run

| Check     | Command                                                      | Result                       |
| --------- | ------------------------------------------------------------ | ---------------------------- |
| Lint      | `pnpm lint`                                                  | PASS — <excerpt>             |
| Typecheck | `pnpm typecheck`                                             | PASS — <excerpt>             |
| Tests     | `pnpm test`                                                  | PASS — <Test Files … passed> |
| Tool spec | `pnpm gen:tools && git diff --exit-code docs/mcp-tools.json` | PASS / SKIPPED (reason)      |
| Done-when | <each command from the milestone prompt>                     | PASS / pending human         |

## Screenshots

<390/1440 light/dark for UI changes (from /verify-prod or local Playwright), or "n/a (no UI change)">

## Risk

- <blast radius: tenant isolation, demo isolation, tokens/PII, Zoho quota, public routes>
- <UNVERIFIED Zoho facts touched + smoke probe added?>
- <rollback: revert this PR; data migrations?>

Closes #<n>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Then run `gh pr create --base main --title "<conventional title>" --body-file <file>`. Every result in the body must
be real output from this session. Write "not run" rather than invent one. Keep the
`🤖 Generated with [Claude Code](https://claude.com/claude-code)` line as the last line of the body.

## 6. After opening

Print the PR URL. Run `gh pr checks --watch` once and report the result. Do not merge: the human merges after
reviewing CI and the Vercel preview. After the merge (and the CD deploy), run `/verify-prod`.
