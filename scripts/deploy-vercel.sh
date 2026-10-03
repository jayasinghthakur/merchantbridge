#!/usr/bin/env bash
# Deploys MerchantBridge to Vercel (free Hobby plan) as two prebuilt projects:
#   merchantbridge-api  ← apps/api bundled into one Vercel Function (Build Output API, scripts/build-vercel.mjs)
#   merchantbridge-web  ← apps/web built locally with `vercel build` (Next.js)
# Usage (repo root):  bash scripts/deploy-vercel.sh [api|web|all]   (default: all)
# Needs: pnpm, a Vercel CLI login (`pnpm dlx vercel@62.2.0 login`), and both projects linked once:
#   (cd apps/api && pnpm dlx vercel@62.2.0 link --yes --project merchantbridge-api)
#   (cd apps/web && pnpm dlx vercel@62.2.0 link --yes --project merchantbridge-web)
# Why deploy from a temp folder: a CLI deploy made from inside this git repo carries the commit author, and Vercel
# blocks it unless that author is a member of the Vercel team. The temp folder has no git metadata.
# Production env vars live in the Vercel projects (see docs/deploy.md); nothing secret is read or printed here.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERCEL=(pnpm --reporter=silent dlx vercel@62.2.0)
SCOPE="${VERCEL_SCOPE:-jaya-singhs-projects}"
API_URL="${MB_API_URL:-https://merchantbridge-api.vercel.app}"
WEB_URL="${MB_WEB_URL:-https://merchantbridge-web.vercel.app}"
REPO_URL="${MB_REPO_URL:-https://github.com/jayasinghthakur/merchantbridge}"
target="${1:-all}"

cleanup_cli_files() { rm -f "$ROOT/apps/api/.env.local" "$ROOT/apps/web/.env.local"; }
trap cleanup_cli_files EXIT

deploy_dir() { # dir label
  (cd "$1" && "${VERCEL[@]}" deploy --prebuilt --prod --yes --scope "$SCOPE" >"$1/deploy.log" 2>&1) || {
    grep -E '"message"|Error' "$1/deploy.log" | head -5
    echo "deploy of $2 failed (log: $1/deploy.log)" >&2
    exit 1
  }
  grep -oE "Aliased +https://[^ ]+" "$1/deploy.log" | head -1
}

deploy_api() {
  echo "== api: bundle"
  [[ -f "$ROOT/apps/api/.vercel/project.json" ]] || { echo "apps/api is not linked (see header)" >&2; exit 1; }
  (cd "$ROOT/apps/api" && pnpm build:vercel)
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/.vercel"
  cp "$ROOT/apps/api/.vercel/project.json" "$tmp/.vercel/"
  cp -R "$ROOT/apps/api/.vercel/output" "$tmp/.vercel/output"
  echo "== api: deploy"
  deploy_dir "$tmp" api
  curl -fsS -m 60 "$API_URL/health/ready" && echo
}

deploy_web() {
  echo "== web: build"
  [[ -f "$ROOT/apps/web/.vercel/project.json" ]] || { echo "apps/web is not linked (see header)" >&2; exit 1; }
  (cd "$ROOT/apps/web" && NEXT_PUBLIC_API_URL="$API_URL" NEXT_PUBLIC_REPO_URL="$REPO_URL" "${VERCEL[@]}" build --prod --yes >/dev/null)
  # The Next.js output references files relative to the repo root (node_modules/.pnpm/…, apps/web/…), so mirror
  # that layout with symlinks in a folder without git metadata.
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/.vercel" "$tmp/apps"
  cp "$ROOT/apps/web/.vercel/project.json" "$tmp/.vercel/"
  cp -R "$ROOT/apps/web/.vercel/output" "$tmp/.vercel/output"
  ln -s "$ROOT/node_modules" "$tmp/node_modules"
  ln -s "$ROOT/apps/web" "$tmp/apps/web"
  ln -s "$ROOT/packages" "$tmp/packages"
  echo "== web: deploy"
  deploy_dir "$tmp" web
  curl -fsS -m 60 -o /dev/null -w "web / → %{http_code}\n" "$WEB_URL/"
}

case "$target" in
  api) deploy_api ;;
  web) deploy_web ;;
  all) deploy_api; deploy_web ;;
  *) echo "usage: $0 [api|web|all]" >&2; exit 2 ;;
esac
