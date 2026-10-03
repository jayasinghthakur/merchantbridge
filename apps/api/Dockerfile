# syntax=docker/dockerfile:1
#
# MerchantBridge API (apps/api). The build context is the pnpm WORKSPACE ROOT:
#   docker build -f apps/api/Dockerfile .           (CI, local; context = repo root)
#   flyctl deploy . --config apps/api/fly.toml       (optional paid alternative; fly.toml's [build] points here)
# The hosted $0 deployment does not use this image: it runs apps/api as a Vercel Function (scripts/deploy-vercel.sh).
# The image is for self-hosting on any container platform. What enters the context is decided by the allow-list in
# /.dockerignore (no .env*, docs, apps/web, evals, tests).
#
# Host contract: listens on $PORT (default 8787 below) on 0.0.0.0 (server.ts binds 0.0.0.0 whenever
# NODE_ENV=production), runs as non-root uid 1000, keeps no state on disk (data lives in Postgres and Redis; only
# tsx's transform cache goes to /tmp), so an ephemeral disk is fine, and reads all configuration from environment
# variables.
#
# There is no compile step: the API and the workspace packages run as TypeScript source under tsx (a runtime
# dependency of @mb/api; packages export ./src/index.ts). The build stage only installs production dependencies for
# @mb/api and its workspace packages; the runtime stage copies the result and runs as the non-root `node` user.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build

# pnpm 12 is a native (Rust) binary that verifies TLS against the system trust store, which the slim image does not
# ship. Build stage only: the runtime uses Node's bundled CA store (fetch, postgres.js, ioredis).
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm comes from Corepack at the exact version in package.json "packageManager" (pnpm@12.8.1).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable pnpm

WORKDIR /app

# Fetch pnpm (and its native binary) in its own layer; it only changes when package.json does.
COPY package.json ./
RUN pnpm --version

COPY pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# Production dependencies of @mb/api and the workspace packages it depends on ("@mb/api..."), exactly as locked.
# pnpm-workspace.yaml is present, so its allowBuilds list (esbuild, used by tsx) still governs install scripts.
# The store lives in a BuildKit cache mount, so it never lands in an image layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@mb/api..." --fail-if-no-match install --frozen-lockfile --prod --store-dir /pnpm/store

# ---------------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

LABEL org.opencontainers.image.title="merchantbridge-api" \
      org.opencontainers.image.description="MerchantBridge API: MCP server for Zoho Inventory (read-only)"

# PORT must match the platform's routing port (Space card `app_port`, fly.toml `internal_port`); a PORT set in the
# platform's environment overrides this default.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

# Only what the server needs at runtime. Files stay owned by root, so the app user cannot modify its own code.
# node_modules holds relative symlinks into node_modules/.pnpm; copying the trees keeps them intact.
COPY --from=build /app/package.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api

# Non-root user that ships with the official Node images (uid/gid 1000); CI asserts `id -u` = 1000.
USER node
WORKDIR /app/apps/api

EXPOSE 8787

# Docker-level liveness for local runs and CI (hosting platforms use their own probes). The slim image has no curl, so
# this uses Node's fetch. /health/* is exempt from the MCP Host allow-list (apps/api/src/app.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The @mb/api "start" script (`tsx src/server.ts`), run as ONE process: Node with tsx's loader (`--import tsx`
# resolves from this WORKDIR). Not the tsx CLI: it runs the app as a child and SIGKILLs it when the child does not
# acknowledge a relayed SIGTERM within 30 ms (measured: a busy event loop loses its graceful shutdown). Here Node is
# PID 1 and server.ts's own SIGTERM handler drains requests and flushes usage events, then force-exits after 15 s.
# Migrations never run on boot: apps/api/scripts/migrate.ts applies them before a deploy (by hand against Neon, or as
# fly.toml's release_command on Fly; docs/deploy.md).
CMD ["node", "--import", "tsx", "src/server.ts"]
