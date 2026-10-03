#!/usr/bin/env bash
# Unit tests for the Claude Code hooks: pipe sample hook payloads into each script and assert exit codes.
# Run: bash .claude/hooks/test-hooks.sh   (exit 0 = all passed)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/guard.sh"
stop="$here/stop-check.sh"
format="$here/format.sh"
pass=0
fail=0

# JSON payload builders (jq if present, node otherwise) so commands with quotes/newlines are encoded exactly.
json_bash() {
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg c "$1" '{hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {command: $c}}'
  else
    node -e 'process.stdout.write(JSON.stringify({hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {command: process.argv[1]}}))' "$1"
  fi
}

json_file() {
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg t "$1" --arg p "$2" '{hook_event_name: "PreToolUse", tool_name: $t, tool_input: {file_path: $p}}'
  else
    node -e 'process.stdout.write(JSON.stringify({hook_event_name: "PreToolUse", tool_name: process.argv[1], tool_input: {file_path: process.argv[2]}}))' "$1" "$2"
  fi
}

# check <expected-exit> <name> <payload> <command...>
check() {
  local want="$1" name="$2" payload="$3"
  shift 3
  local err got
  err="$(printf '%s' "$payload" | "$@" 2>&1 >/dev/null)"
  got=$?
  if [[ "$got" == "$want" ]] && { [[ "$want" != 2 ]] || [[ -n "$err" ]]; }; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s: expected exit %s, got %s\n      stderr: %s\n' "$name" "$want" "$got" "${err:0:300}"
  fi
}

# Runs every guard case with the jq parser and again with the node fallback parser.
guard_bash() {
  local want="$1" cmd="$2" payload
  payload="$(json_bash "$cmd")"
  check "$want" "guard[jq] bash: $cmd" "$payload" bash "$guard"
  check "$want" "guard[node] bash: $cmd" "$payload" env GUARD_JSON_PARSER=node bash "$guard"
}

guard_file() {
  local want="$1" tool="$2" path="$3" payload
  payload="$(json_file "$tool" "$path")"
  check "$want" "guard[jq] $tool $path" "$payload" bash "$guard"
  check "$want" "guard[node] $tool $path" "$payload" env GUARD_JSON_PARSER=node bash "$guard"
}

echo '== guard.sh: .env through file tools'
guard_file 2 Read /repo/.env
guard_file 2 Read /repo/apps/web/.env.local
guard_file 2 Edit /repo/.env.production
guard_file 2 Write /repo/.env
guard_file 2 MultiEdit /repo/packages/auth/.env.test
guard_file 0 Read /repo/.env.example
guard_file 0 Write /repo/apps/api/.env.example
guard_file 0 Read /repo/packages/core/src/env.ts
guard_file 0 Read /repo/.envrc
guard_file 0 Edit /repo/docs/notes/zoho.md
guard_file 0 Glob /repo/.env

echo '== guard.sh: .env named in Bash'
guard_bash 2 'cat .env'
guard_bash 2 'cat apps/web/.env.local'
guard_bash 2 'source .env && pnpm dev:api'
guard_bash 2 'node --env-file=.env scripts/x.mjs'
guard_bash 2 'cp .env /tmp/x'
guard_bash 2 'cat .env*'
guard_bash 2 "grep TOKEN '.env'"
guard_bash 0 'cat .env.example'
guard_bash 0 'cp .env.example apps/api/.env.example'
guard_bash 0 'grep -rn "process.env.ZOHO" packages'
guard_bash 0 "rg -n '\\.env' packages"
guard_bash 0 'echo $NODE_ENV'
guard_bash 0 'ls -la .envrc'

echo '== guard.sh: human-only commands'
guard_bash 2 'fly secrets set ZOHO_CLIENT_SECRET=x'
guard_bash 2 'flyctl secrets list -a merchantbridge-api'
guard_bash 2 'fly -a merchantbridge-api secrets list'
guard_bash 2 'vercel env add NEXT_PUBLIC_API_URL production'
guard_bash 2 'pnpm smoke'
guard_bash 2 'pnpm -s smoke'
guard_bash 2 'pnpm run smoke'
guard_bash 2 'cd /repo && pnpm smoke'
guard_bash 2 'pnpm exec tsx scripts/smoke.ts'
guard_bash 2 'npx tsx scripts/smoke.ts'
guard_bash 0 'pnpm exec eslint scripts/smoke.ts'
guard_bash 0 'pnpm exec tsc -p tsconfig.json'
guard_bash 0 'fly deploy --remote-only'
guard_bash 0 'fly status -a merchantbridge-api'
guard_bash 0 'vercel deploy --prebuilt'
guard_bash 0 'pnpm test'

echo '== guard.sh: mutating requests to Zoho hosts'
guard_bash 2 'curl -X POST https://accounts.zoho.in/oauth/v2/token -d grant_type=refresh_token'
guard_bash 2 'curl -sS -XPOST "https://www.zohoapis.in/inventory/v1/items?organization_id=1"'
guard_bash 2 "curl -sX 'PUT' https://www.zohoapis.com/inventory/v1/items/1"
guard_bash 2 'curl --request DELETE https://www.zohoapis.com/inventory/v1/items/1'
guard_bash 2 'curl --request=PATCH https://www.zohoapis.eu/inventory/v1/items/1'
guard_bash 2 'curl -d "a=b" https://accounts.zoho.com/oauth/v2/token'
guard_bash 2 'curl -sd @body.txt https://accounts.zoho.com.au/oauth/v2/token'
guard_bash 2 'curl --data-urlencode token=x https://accounts.zohocloud.ca/oauth/v2/revoke/token'
guard_bash 2 'curl -F file=@x.csv https://www.zohoapis.in/inventory/v1/items'
guard_bash 2 'curl --json "{}" https://www.zohoapis.in/inventory/v1/salesorders'
guard_bash 2 'wget --method=PUT https://www.zohoapis.eu/inventory/v1/items/1'
guard_bash 2 'wget --post-data="a=b" https://accounts.zoho.eu/oauth/v2/token'
guard_bash 2 'http POST https://www.zohoapis.in/inventory/v1/items name=x'
guard_bash 2 'http https://accounts.zoho.in/oauth/v2/token grant_type=refresh_token'
guard_bash 2 'xh --form https://accounts.zoho.in/oauth/v2/token a=b'
guard_bash 2 "node -e \"fetch('https://accounts.zoho.in/oauth/v2/token', { method: 'POST' })\""
guard_bash 2 "python3 -c \"import requests; requests.delete('https://www.zohoapis.in/inventory/v1/items/1')\""
guard_bash 2 $'node --input-type=module <<\'EOF\'\nawait fetch("https://accounts.zoho.in/oauth/v2/token", { method: "POST" });\nEOF'
guard_bash 2 'Z=accounts.zoho.in; curl -X POST "https://$Z/oauth/v2/token"'
guard_bash 0 'curl -s "https://www.zohoapis.in/inventory/v1/items?organization_id=1"'
guard_bash 0 'curl -sS -X GET https://www.zohoapis.in/inventory/v1/organizations'
guard_bash 0 'curl -sSfL --max-time 10 https://accounts.zoho.com/oauth/serverinfo'
guard_bash 0 'http GET https://www.zohoapis.in/inventory/v1/items organization_id==1'
guard_bash 0 "curl -X POST http://localhost:8787/mcp/demo -d '{}'"
guard_bash 0 'grep -rn "zohoapis" packages | cut -d: -f1'
guard_bash 0 'grep -rn "POST" packages/auth/src | grep accounts.zoho'
guard_bash 0 'git commit -m "feat(auth): POST the refresh to accounts.zoho.in"'
guard_bash 0 'pnpm --filter @mb/auth test'

echo '== guard.sh: other tools and bad input'
check 0 'guard: unrelated tool' '{"tool_name":"Grep","tool_input":{"pattern":"x"}}' bash "$guard"
check 0 'guard: empty bash command' '{"tool_name":"Bash","tool_input":{}}' bash "$guard"
check 2 'guard[jq]: malformed JSON fails closed' 'not json' bash "$guard"
check 2 'guard[node]: malformed JSON fails closed' 'not json' env GUARD_JSON_PARSER=node bash "$guard"
check 2 'guard: empty input fails closed' '' bash "$guard"

echo '== stop-check.sh'
tmp="$(mktemp -d "${TMPDIR:-/tmp}/mb-hook-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/nogit" "$tmp/cleangit"
git -C "$tmp/cleangit" init -q
active='{"hook_event_name":"Stop","stop_hook_active":true}'
inactive='{"hook_event_name":"Stop","stop_hook_active":false}'

check 0 'stop: stop_hook_active=true always allows stopping' "$active" \
  env CLAUDE_PROJECT_DIR="$tmp/nogit" MB_STOP_TYPECHECK_CMD='exit 1' MB_STOP_TEST_CMD='exit 1' bash "$stop"
check 0 'stop: passing checks allow stopping' "$inactive" \
  env CLAUDE_PROJECT_DIR="$tmp/nogit" MB_STOP_TYPECHECK_CMD='true' MB_STOP_TEST_CMD='true' bash "$stop"
check 2 'stop: typecheck failure blocks' "$inactive" \
  env CLAUDE_PROJECT_DIR="$tmp/nogit" MB_STOP_TYPECHECK_CMD='echo "TS2322 boom"; exit 1' MB_STOP_TEST_CMD='true' bash "$stop"
check 2 'stop: changed-test failure blocks' "$inactive" \
  env CLAUDE_PROJECT_DIR="$tmp/nogit" MB_STOP_TYPECHECK_CMD='true' MB_STOP_TEST_CMD='echo "1 failed"; exit 1' bash "$stop"
check 0 'stop: clean git tree skips checks' "$inactive" \
  env CLAUDE_PROJECT_DIR="$tmp/cleangit" MB_STOP_TYPECHECK_CMD='exit 1' MB_STOP_TEST_CMD='exit 1' bash "$stop"
check 0 'stop: malformed input fails open' 'not json' \
  env CLAUDE_PROJECT_DIR="$tmp/nogit" MB_STOP_TYPECHECK_CMD='exit 1' MB_STOP_TEST_CMD='exit 1' bash "$stop"
check 2 'stop: cwd from payload when CLAUDE_PROJECT_DIR is unset' \
  "{\"hook_event_name\":\"Stop\",\"stop_hook_active\":false,\"cwd\":\"$tmp/nogit\"}" \
  env -u CLAUDE_PROJECT_DIR MB_STOP_TYPECHECK_CMD='exit 1' MB_STOP_TEST_CMD='true' bash "$stop"
err="$(printf '%s' "$inactive" | env CLAUDE_PROJECT_DIR="$tmp/nogit" MB_STOP_TYPECHECK_CMD='echo "TS2322 boom"; exit 1' \
  MB_STOP_TEST_CMD='true' bash "$stop" 2>&1 >/dev/null)"
if [[ "$err" == *"TS2322 boom"* ]]; then pass=$((pass + 1)); else
  fail=$((fail + 1))
  echo "FAIL  stop: stderr should carry the failing output tail, got: ${err:0:300}"
fi

echo '== format.sh'
check 0 'format: non-project file is ignored' '{"tool_name":"Write","tool_input":{"file_path":"/nonexistent/x.ts"}}' \
  env CLAUDE_PROJECT_DIR="$tmp/nogit" bash "$format"
check 0 'format: malformed input never blocks' 'not json' env CLAUDE_PROJECT_DIR="$tmp/nogit" bash "$format"

for f in "$guard" "$stop" "$format"; do
  if [[ -x "$f" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL  $f is not executable"
  fi
done

echo
echo "hook tests: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
