# ADR-0002: TypeScript end to end on MCP TypeScript SDK v2

## Context

Two inputs disagreed: the starter kit (TypeScript, `@modelcontextprotocol/sdk` v1, Turborepo, separate gateway /
mcp-server / dashboard apps) and a Python/FastAPI plan. The job description asks for Python plus one of
Java/Go/TypeScript. The playground needs Anthropic's `mcpTools()` + `toolRunner` helpers and a Next.js site. MCP spec
2026-07-28 made Streamable HTTP per-request and stateless; SDK v2 (`@modelcontextprotocol/server|client|fastify|node`)
implements it and still serves 2025-era clients statelessly (`legacy: 'stateless'`). v1 (`@modelcontextprotocol/sdk`
1.32) is the maintenance line. v2 is newer than Claude's training data.

## Decision

- TypeScript 6 strict on Node 22 for every package and app; one pnpm workspace, one test runner (Vitest), one CI.
  A small Python Agent SDK client in `examples/python/` runs in CI to show the server from Python.
- MCP SDK **v2, exact-pinned**: server 2.3.0, client 2.3.0, fastify 2.0.1, node 2.1.1, Zod 4.6.5.
- One Fastify service (`apps/api`) mounts `createMcpHandler` at `/mcp` and `/mcp/demo` with `legacy: 'stateless'`
  (never `'reject'`), plus OAuth, playground SSE and explorer routes. `apps/web` is Next.js 16.
- Usage of v2 is grounded in `docs/notes/mcp-v2.md` (runtime-probed), not memory.
- **Fallback:** if v2 blocks a host we must support, swap the transport layer to v1 `@modelcontextprotocol/sdk@1.32`
  (`McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request). Tools, ToolRuntime
  and the contract suite are SDK-agnostic (they live in `packages/core` and take/return plain objects), so the swap
  is confined to `apps/api/src/mcp/*` and the test harness.

## Consequences

- One language for server, site, evals and playground; `handler.fetch` gives no-socket integration tests of the exact
  server we deploy.
- v2 gotchas we must code around (all in mcp-v2.md): the SDK validates Zod input schemas before our handler (we
  register a pass-through `fromJsonSchema` so ToolRuntime stays the single validator and audit point); v2 types
  `structuredContent` as `unknown`, so Anthropic's `mcpTools` needs a small adapter; `RequestMetaEnvelope` is typed
  `{}`; `createMcpFastifyApp` accepts no Fastify options (no logger/trustProxy).
- Minor-version churn risk: exact pins, Dependabot PRs reviewed by hand, day-0 compatibility probe with the Inspector,
  Claude Code and one Messages API connector call.

## Status

Accepted.
