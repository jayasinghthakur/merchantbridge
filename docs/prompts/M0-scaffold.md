# M0 — Scaffold the monorepo

Use plan mode. Show me the plan before writing files.

Goal: an empty but production-shaped monorepo that builds, lints, tests and runs locally.

Build:
- pnpm workspace + Turborepo with the exact layout in CLAUDE.md (apps/, connectors/, packages/, evals/, docs/, infra/).
- Shared `tsconfig.base.json` (strict, NodeNext), ESLint (typescript-eslint, no-floating-promises), Prettier.
- Vitest workspace config; one passing placeholder test per package.
- `infra/docker-compose.yml` with Postgres 16 and Redis 7 (healthchecks), and `pnpm dev` that starts them.
- `.env.example` with every variable name (no values): ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN,
  ZOHO_DC, ZOHO_ORG_ID, MB_ENCRYPTION_KEY, DATABASE_URL, REDIS_URL, MB_PUBLIC_URL, LOG_LEVEL.
- `packages/config`: Zod-validated env loader that fails fast with a readable message.
- GitHub Actions CI: install, lint, typecheck, test, build (cache pnpm store).
- `README.md` stub with the tagline "A universal, secure connector layer for merchant systems and AI agents."

Done when: `pnpm i && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass locally, and you show me the tree.
Commit as `chore: scaffold monorepo`.
