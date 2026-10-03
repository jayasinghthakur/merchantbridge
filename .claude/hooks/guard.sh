#!/usr/bin/env bash
# PreToolUse guard for MerchantBridge (matcher: Bash|Edit|Write|MultiEdit|Read).
# Reads the hook payload (JSON) on stdin; exit 2 blocks the tool call and stderr is the reason Claude sees.
# Docs: https://code.claude.com/docs/en/hooks
#
# Blocks:
#   (a) .env / .env.* through Read/Edit/Write/MultiEdit, or named in a Bash command (.env.example is allowed)
#   (b) Bash commands that send POST/PUT/PATCH/DELETE to Zoho API or accounts hosts
#   (c) human-only commands: fly secrets, vercel env, pnpm smoke (the human runs these with the ! prefix)
#
# Bash 3.2 compatible (macOS /bin/bash): no mapfile, no ${var,,}, no associative arrays.
# Set GUARD_JSON_PARSER=node to force the node fallback parser (used by test-hooks.sh).
set -uo pipefail

input="$(cat)"

block() {
  printf 'Blocked by .claude/hooks/guard.sh: %s\n' "$1" >&2
  exit 2
}

use_jq() {
  [[ "${GUARD_JSON_PARSER:-}" != "node" ]] && command -v jq >/dev/null 2>&1
}

# Fail closed: a guard that cannot read its input must not wave the tool call through.
if use_jq; then
  printf '%s' "$input" | jq -e 'type == "object"' >/dev/null 2>&1 ||
    block 'could not parse the hook input as a JSON object.'
elif command -v node >/dev/null 2>&1; then
  printf '%s' "$input" |
    node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); if (j === null || typeof j !== "object") process.exit(1);' \
      >/dev/null 2>&1 || block 'could not parse the hook input as a JSON object.'
else
  block 'neither jq nor node is available to parse the hook input.'
fi

# Prints tool_name, tool_input.command and tool_input.file_path, each terminated by a NUL byte.
extract_fields() {
  if use_jq; then
    printf '%s' "$input" | jq -j '
      (.tool_name // "" | tostring), "\u0000",
      (.tool_input.command // "" | tostring), "\u0000",
      (.tool_input.file_path // "" | tostring), "\u0000"'
  else
    printf '%s' "$input" | node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const t = j.tool_input && typeof j.tool_input === "object" ? j.tool_input : {};
      const s = (v) => (v === undefined || v === null ? "" : String(v));
      process.stdout.write([s(j.tool_name), s(t.command), s(t.file_path)].join("\0") + "\0");'
  fi
}

tool_name=''
command_text=''
file_path=''
{
  IFS= read -r -d '' tool_name
  IFS= read -r -d '' command_text
  IFS= read -r -d '' file_path
} < <(extract_fields)

ENV_MSG='.env files hold real secrets and are off-limits (CLAUDE.md rule 7). Only .env.example may be read or edited; ask the human to change real values.'

# ---------- (a) file tools ----------

is_env_file() {
  local base="${1##*/}"
  [[ "$base" == ".env.example" ]] && return 1
  [[ "$base" == ".env" || "$base" == .env.* ]]
}

case "$tool_name" in
  Read | Edit | Write | MultiEdit)
    if [[ -n "$file_path" ]] && is_env_file "$file_path"; then
      block "$ENV_MSG"
    fi
    exit 0
    ;;
  Bash) ;;
  *) exit 0 ;;
esac

cmd="$command_text"
[[ -z "$cmd" ]] && exit 0

# ---------- (a) .env named in a Bash command ----------
# A `.env` token that is not part of a longer word (process.env, import.meta.env, .envrc and a regex-escaped
# '\.env' do not match). Any token other than exactly .env.example blocks, including globs like .env*.
env_tokens="$(
  printf '%s\n' "$cmd" |
    grep -oE '(^|[^-A-Za-z0-9_.$\])\.env(\.[-A-Za-z0-9_]+)*([^-A-Za-z0-9_]|$)' |
    grep -oE '\.env(\.[-A-Za-z0-9_]+)*'
)"
if [[ -n "$env_tokens" ]]; then
  while IFS= read -r tok; do
    [[ -n "$tok" && "$tok" != ".env.example" ]] && block "$ENV_MSG"
  done <<<"$env_tokens"
fi

# ---------- helpers for per-segment checks ----------

# First command word of a segment, skipping env assignments and common wrappers; basename only.
first_word() {
  local s="$1" w
  s="${s#"${s%%[![:space:]]*}"}"
  while [[ -n "$s" ]]; do
    w="${s%%[[:space:]]*}"
    case "$w" in
      *=* | sudo | env | command | exec | time | nohup | '!' | '{' | '(' | then | do | else | if | while)
        s="${s#"$w"}"
        s="${s#"${s%%[![:space:]]*}"}"
        ;;
      *) break ;;
    esac
  done
  w="${s%%[[:space:]]*}"
  w="${w#\(}"
  printf '%s' "${w##*/}"
}

matches() { printf '%s\n' "$1" | grep -Eq -- "$2"; }
matches_i() { printf '%s\n' "$1" | grep -Eiq -- "$2"; }

# Segments split on shell separators (; | & and newlines). Deliberately naive about quotes: splitting inside a
# quoted string can only produce more segments to inspect, never hide one.
segments="$(printf '%s\n' "$cmd" | tr ';|&' '\n\n\n')"

# ---------- (c) human-only commands ----------

HUMAN_MSG='this command is human-only (secrets / real-Zoho probes). Ask the user to run it themselves with the ! prefix, e.g. `! pnpm smoke`, and paste the sanitized output.'

while IFS= read -r seg; do
  [[ -z "${seg//[[:space:]]/}" ]] && continue
  fw="$(first_word "$seg")"
  case "$fw" in
    fly | flyctl)
      matches "$seg" '(^|[[:space:]])secrets([[:space:]]|$)' && block "\`fly secrets\`: $HUMAN_MSG"
      ;;
    vercel)
      matches "$seg" '(^|[[:space:]])env([[:space:]]|$)' && block "\`vercel env\`: $HUMAN_MSG"
      ;;
    pnpm | npm | yarn)
      matches "$seg" '(^|[[:space:]])smoke([[:space:]]|$)' && block "\`pnpm smoke\`: $HUMAN_MSG"
      ;;
  esac
  # Running scripts/smoke.ts directly (tsx/node/...); linting or type-checking it stays allowed.
  if matches "$seg" 'smoke\.ts' && matches "$seg" '(^|[[:space:]/])(tsx|node|ts-node|bun|deno)([[:space:]]|$)'; then
    block "scripts/smoke.ts: $HUMAN_MSG"
  fi
done <<<"$segments"

# ---------- (b) mutating requests to Zoho hosts ----------

ZOHO_HOST_RE='(zohoapis|zohocloud)\.[a-z]|(^|[^a-z0-9-])([a-z0-9-]+\.)*zoho\.(com|in|eu|jp|sa|uk|ca)([^a-z0-9]|$)'
matches_i "$cmd" "$ZOHO_HOST_RE" || exit 0

ZOHO_MSG='this command would send a POST/PUT/PATCH/DELETE to a Zoho API or accounts host. MerchantBridge is read-only: OAuth token calls live in packages/auth (tested against fakes) and real-Zoho probes are GET-only and human-run (`! pnpm smoke`).'

HTTP_CLIENT_RE='(^|[[:space:]/(`])(curl|wget|http|https|xh|xhs)([[:space:]]|$)'
METHOD_WORD_RE='(^|[^A-Za-z0-9_])(post|put|patch|delete)([^A-Za-z0-9_]|$)'
# curl/wget/httpie flags that send a body (and therefore a POST/PUT by default).
BODY_FLAG_RE='(^|[[:space:]])(--data[-a-z]*|--json|--form[-a-z]*|--upload-file|--post-data|--post-file|--body-data|--body-file)([[:space:]=]|$)'
# curl short body/upload flags, possibly combined (-d, -F, -T; e.g. -sd).
CURL_SHORT_RE='(^|[[:space:]])-[A-Za-z]*[dFT]'
# curl -X with the method glued on or quoted (-XPOST, -sX 'PUT'); `-X POST` is also caught by METHOD_WORD_RE.
CURL_X_RE="(^|[[:space:]])-[A-Za-z]*X[[:space:]]*['\"]?(post|put|patch|delete)"
# httpie request items that imply a body (key=value, key:=json, field@file) but not query items (key==value).
HTTPIE_ITEM_RE='[[:space:]][A-Za-z_][-A-Za-z0-9_.]*(:=|=[^=]|=$|@)'
SAFE_WORDS=' grep egrep rg ag git gh echo printf cat sed awk jq head tail ls find wc sort uniq diff less more '

while IFS= read -r seg; do
  [[ -z "${seg//[[:space:]]/}" ]] && continue
  if matches "$seg" "$HTTP_CLIENT_RE"; then
    matches_i "$seg" "$METHOD_WORD_RE" && block "$ZOHO_MSG"
    matches "$seg" "$BODY_FLAG_RE" && block "$ZOHO_MSG"
    if matches "$seg" '(^|[[:space:]/(`])curl([[:space:]]|$)'; then
      matches "$seg" "$CURL_SHORT_RE" && block "$ZOHO_MSG"
      matches_i "$seg" "$CURL_X_RE" && block "$ZOHO_MSG"
    fi
    if matches "$seg" '(^|[[:space:]/(`])(http|https|xh|xhs)([[:space:]]|$)'; then
      matches "$seg" "$HTTPIE_ITEM_RE" && block "$ZOHO_MSG"
      matches "$seg" '(^|[[:space:]])(-f|--form)([[:space:]]|$)' && block "$ZOHO_MSG"
    fi
    continue
  fi
  # Inline scripts (node -e, python -c, heredocs): an upper-case method word (fetch's { method: 'POST' }) or a
  # client method call (requests.post(, axios.delete(, got.put() next to a Zoho host.
  fw="$(first_word "$seg")"
  case "$SAFE_WORDS" in *" $fw "*) continue ;; esac
  matches "$seg" '(^|[^A-Za-z0-9_])(POST|PUT|PATCH|DELETE)([^A-Za-z0-9_]|$)' && block "$ZOHO_MSG"
  matches_i "$seg" '\.(post|put|patch|delete)[[:space:]]*\(' && block "$ZOHO_MSG"
done <<<"$segments"

exit 0
