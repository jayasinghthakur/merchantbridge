#!/usr/bin/env bash
# Assembles the Hugging Face Space repository for apps/api into <out-dir>.
#
#   bash deploy/hf-space/assemble.sh <out-dir>        (out-dir must be new or empty)
#
# The Space builds the Dockerfile at its repository root with that root as the build context. apps/api/Dockerfile
# already expects the pnpm workspace root as its context, so the Space root mirrors the workspace layout:
#
#   Dockerfile       copy of apps/api/Dockerfile (unchanged)
#   .dockerignore    copy of /.dockerignore (the same context filter as CI and local builds)
#   README.md        deploy/hf-space/README.md: the Space card (sdk: docker, app_port: 8787); its @WEB_URL@ token
#                    becomes $WEB_URL when set, else a pointer to the GitHub README
#   everything else  the files /.dockerignore lets into the build context: package.json, pnpm-lock.yaml,
#                    pnpm-workspace.yaml, tsconfig.base.json, packages/, apps/api/ (no tests, docs, configs for
#                    dev tools, fly.toml, or scripts other than apps/api/scripts/migrate.ts)
#
# Only files git knows about are considered (tracked, plus untracked-but-not-ignored ones so a local dry run sees
# work in progress; a CI checkout has no untracked files). Gitignored files (.env*, node_modules, build output) can
# therefore never be copied, and the .dockerignore excludes below are applied on top as a second filter.
#
# Used by .github/workflows/deploy-hf-space.yml, which then builds the result with Docker before pushing it.
# Bash 3.2 (macOS) and GNU (Ubuntu runners) compatible. Never reads or prints secrets.
set -euo pipefail

REPO_URL='https://github.com/jayasinghthakur/merchantbridge'

out_arg="${1:-}"
if [ -z "$out_arg" ]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi

# Resolve both paths (physically) relative to the caller's directory, before anything is created or cd'd into.
root="$(cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" && pwd -P)"
parent="$(dirname "$out_arg")"
if [ ! -d "$parent" ]; then
  echo "assemble: the parent directory of $out_arg does not exist" >&2
  exit 2
fi
out="$(cd "$parent" && pwd -P)/$(basename "$out_arg")"
case "$out" in
  "$root" | "$root"/*)
    echo "assemble: the output directory must be outside the repository ($out)" >&2
    exit 2
    ;;
esac
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then
  echo "assemble: $out exists and is not empty; refusing to mix deploys" >&2
  exit 2
fi
mkdir -p "$out"
cd "$root"

# The re-included roots of /.dockerignore ("!package.json", "!packages/", ...). Keep in sync with that file.
INCLUDE_ROOTS='package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages apps/api'

# Mirror of the exclude lines of /.dockerignore (later lines win there, so migrate.ts is re-included before the
# scripts/* exclude). In `case` patterns `*` also matches '/', so `*/test/*` is the `**/test` of .dockerignore.
excluded() {
  case "$1" in
    node_modules/* | */node_modules/*) return 0 ;;
    .env | .env.* | */.env | */.env.*) return 0 ;;
    *.pem | *.key | *.log | *.tsbuildinfo) return 0 ;;
    .DS_Store | */.DS_Store) return 0 ;;
    dist/* | */dist/* | coverage/* | */coverage/*) return 0 ;;
    test/* | */test/* | tests/* | */tests/* | *.test.ts) return 0 ;;
    vitest.config.* | */vitest.config.*) return 0 ;;
    *.md) return 0 ;;
    packages/db/drizzle.config.ts) return 0 ;;
    apps/api/scripts/migrate.ts) return 1 ;;
    apps/api/scripts/*) return 0 ;;
    apps/api/fly.toml | apps/api/Dockerfile) return 0 ;;
  esac
  return 1
}

copied=0
# shellcheck disable=SC2086 # INCLUDE_ROOTS is a fixed word list
while IFS= read -r -d '' f; do
  excluded "$f" && continue
  # A tracked file deleted in the working tree (local dry runs only).
  [ -f "$f" ] || continue
  mkdir -p "$out/$(dirname "$f")"
  cp -p "$f" "$out/$f"
  copied=$((copied + 1))
done < <(git ls-files -z --cached --others --exclude-standard -- $INCLUDE_ROOTS | sort -zu)

cp -p apps/api/Dockerfile "$out/Dockerfile"
cp -p .dockerignore "$out/.dockerignore"

# The card's web-app link: $WEB_URL (the GitHub repository variable) when it is a plain https URL.
web_url="${WEB_URL:-}"
web_url="${web_url%/}"
if printf '%s' "$web_url" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'; then
  web_link="$web_url"
else
  [ -n "$web_url" ] && echo "assemble: WEB_URL is not a plain https URL; the card links the GitHub README instead" >&2
  web_link="linked at the top of the [GitHub README]($REPO_URL)"
fi
sed "s|@WEB_URL@|$web_link|g" deploy/hf-space/README.md >"$out/README.md"

# ---------- self-checks: fail here rather than in the Space build ----------
fail=0

# Every source of a COPY from the build context (not --from=<stage>) must exist in the Space.
copy_sources="$(awk '/^COPY / && !/--from=/ { for (i = 2; i < NF; i++) if ($i !~ /^--/) print $i }' "$out/Dockerfile")"
for src in $copy_sources; do
  if [ ! -e "$out/$src" ]; then
    echo "assemble: the Dockerfile copies '$src', which is missing from the Space" >&2
    fail=1
  fi
done

# Files the image needs at runtime.
for need in apps/api/package.json apps/api/src/server.ts apps/api/scripts/migrate.ts packages/db/package.json; do
  if [ ! -f "$out/$need" ]; then
    echo "assemble: missing $need" >&2
    fail=1
  fi
done
if ! ls "$out"/packages/db/drizzle/*.sql >/dev/null 2>&1; then
  echo "assemble: missing the SQL migrations in packages/db/drizzle/" >&2
  fail=1
fi

# Nothing that must never ship: env files, keys, dependencies, tests, docs (other than the card), dev configs.
leaked="$(
  cd "$out" && find . -type f \( \
    -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -path '*/node_modules/*' \
    -o -path '*/test/*' -o -path '*/tests/*' -o -name '*.test.ts' -o -name 'vitest.config.*' \
    -o -name 'fly.toml' -o -name 'drizzle.config.ts' -o \( -name '*.md' ! -path './README.md' \) \
    \) -print
)"
if [ -n "$leaked" ]; then
  echo "assemble: files that must not ship were assembled:" >&2
  printf '%s\n' "$leaked" >&2
  fail=1
fi
if [ "$(head -n 1 "$out/README.md")" != '---' ] || ! grep -q '^sdk: docker$' "$out/README.md" ||
  ! grep -q '^app_port: 8787$' "$out/README.md"; then
  echo "assemble: README.md must start with the Space frontmatter (sdk: docker, app_port: 8787)" >&2
  fail=1
fi
if ! grep -q '^ENV .*PORT=8787' "$out/Dockerfile" && ! grep -Eq '^[[:space:]]+PORT=8787' "$out/Dockerfile"; then
  echo "assemble: the Dockerfile no longer defaults PORT to 8787; update app_port in the Space card to match" >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1

total="$(cd "$out" && find . -type f | wc -l | tr -d ' ')"
size="$(du -sk "$out" | cut -f1)"
echo "assemble: $total files (${copied} from the workspace + Dockerfile, .dockerignore, README.md), ${size} KiB -> $out"
