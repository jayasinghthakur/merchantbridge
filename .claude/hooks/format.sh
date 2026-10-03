#!/usr/bin/env bash
# PostToolUse formatter (matcher: Edit|Write|MultiEdit): `eslint --fix` on .ts/.tsx, then Prettier on
# .ts/.tsx/.json/.md (the Prettier step is the kit's original hook, unchanged in effect).
# One script instead of two hook entries because all hooks matching an event run in parallel, and two writers on
# the same file would race. Never blocks: always exits 0; leftover lint errors surface in /verify and CI.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
  file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
else
  file="$(printf '%s' "$input" | node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.stdout.write(String((j.tool_input && j.tool_input.file_path) || ""));
    } catch {}' 2>/dev/null)"
fi
[[ -z "${file:-}" ]] && exit 0

root="${CLAUDE_PROJECT_DIR:-$PWD}"
[[ "$file" == /* ]] || file="$root/$file"
[[ -f "$file" ]] || exit 0
# Only files inside this project, and never secrets files.
case "$file" in "$root"/*) ;; *) exit 0 ;; esac
base="${file##*/}"
[[ "$base" == ".env" || "$base" == .env.* ]] && exit 0

cd "$root" || exit 0
case "$file" in
  *.ts | *.tsx) npx --no-install eslint --fix --no-warn-ignored "$file" >/dev/null 2>&1 || true ;;
esac
case "$file" in
  *.ts | *.tsx | *.json | *.md) npx --no-install prettier --write --log-level silent "$file" >/dev/null 2>&1 || true ;;
esac
exit 0
