#!/usr/bin/env bash
# Stop hook: keep Claude working while the repo does not typecheck or a changed test fails.
# Exit 2 blocks the stop and shows stderr to Claude; exit 0 lets it stop.
# Docs: https://code.claude.com/docs/en/hooks
#
# - stop_hook_active=true means this hook already blocked once in this turn: always let Claude stop (no loops).
# - A clean git working tree means nothing changed since the last commit: skip the checks.
# - Fails open (exit 0 with a note) when the payload cannot be parsed or pnpm is missing: this hook must never
#   trap Claude because of its own problem.
# - MB_STOP_TYPECHECK_CMD / MB_STOP_TEST_CMD override the two commands (used by test-hooks.sh).
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

input="$(cat)"

read_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r "$1" 2>/dev/null
  else
    printf '%s' "$input" | node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const v = process.argv[1].split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), j);
      process.stdout.write(v === undefined || v === null ? "" : String(v));' "$2" 2>/dev/null
  fi
}

active="$(read_field '.stop_hook_active // false | tostring' 'stop_hook_active')" || {
  echo 'stop-check: could not parse hook input; skipping checks.' >&2
  exit 0
}
[[ "$active" == "true" ]] && exit 0

root="${CLAUDE_PROJECT_DIR:-}"
[[ -z "$root" ]] && root="$(read_field '.cwd // empty' 'cwd')"
[[ -z "$root" ]] && root="$PWD"
cd "$root" 2>/dev/null || exit 0

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [[ -z "$(git status --porcelain 2>/dev/null)" ]] && exit 0
fi

typecheck_cmd="${MB_STOP_TYPECHECK_CMD:-pnpm -s typecheck}"
# Playwright owns **/e2e/** (apps/web); a root vitest run would otherwise pick up its *.spec.ts files.
test_cmd="${MB_STOP_TEST_CMD:-pnpm -s exec vitest run --changed --passWithNoTests --exclude '**/e2e/**'}"

if [[ -z "${MB_STOP_TYPECHECK_CMD:-}${MB_STOP_TEST_CMD:-}" ]] && ! command -v pnpm >/dev/null 2>&1; then
  echo 'stop-check: pnpm not found on PATH; skipping typecheck and tests.' >&2
  exit 0
fi

log="$(mktemp "${TMPDIR:-/tmp}/mb-stop-check.XXXXXX")" || exit 0
trap 'rm -f "$log"' EXIT

run_check() {
  local name="$1" cmd="$2"
  if ! bash -c "$cmd" >"$log" 2>&1; then
    {
      printf 'Stop hook: %s failed (%s). Fix it before finishing, or explain why it cannot be fixed now.\n' \
        "$name" "$cmd"
      printf -- '--- last 40 lines ---\n'
      tail -n 40 "$log"
    } >&2
    exit 2
  fi
}

run_check 'typecheck' "$typecheck_cmd"
run_check 'changed tests' "$test_cmd"
exit 0
