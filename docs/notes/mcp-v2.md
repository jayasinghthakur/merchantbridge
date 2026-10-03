# MCP TypeScript SDK v2: how MerchantBridge serves and tests MCP

Sources: `docs/vendor/mcp/*.md` (SDK v2 docs captured 2026-10-03) and the installed packages:
`@modelcontextprotocol/server@2.3.0`, `@modelcontextprotocol/client@2.3.0`, `@modelcontextprotocol/fastify@2.0.1`,
`@modelcontextprotocol/node@2.1.1` (`node_modules/.pnpm/@modelcontextprotocol+*/.../dist/*.d.mts`).

Status legend: **[types]** read from the installed `.d.mts`; **[run]** executed against the installed packages in a
scratch probe on 2026-10-03 (snippets below are the probe code, trimmed); **[docs]** vendored docs only;
**UNVERIFIED** not confirmed.

## 1. Packages and import paths

| Import                                                                                                                                                                                         | From                                 | Notes                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `createMcpHandler`, `McpServer`, `fromJsonSchema`, `CLIENT_INFO_META_KEY`, `ProtocolError`, types `AuthInfo`, `McpServerFactory`, `CreateMcpHandlerOptions`, `CallToolResult`, `ServerContext` | `@modelcontextprotocol/server`       | [types]                                                                                     |
| `serveStdio`                                                                                                                                                                                   | `@modelcontextprotocol/server/stdio` | package `exports` has `./stdio` [types]                                                     |
| `createMcpFastifyApp`, `hostHeaderValidation`, `originValidation`                                                                                                                              | `@modelcontextprotocol/fastify`      | [types]                                                                                     |
| `toNodeHandler`, `toWebRequest`                                                                                                                                                                | `@modelcontextprotocol/node`         | [types]                                                                                     |
| `Client`, `StreamableHTTPClientTransport`, `InMemoryTransport`                                                                                                                                 | `@modelcontextprotocol/client`       | [types]                                                                                     |
| `z`                                                                                                                                                                                            | `zod` (4.6.5)                        | Zod 4 schemas implement Standard Schema + JSON Schema, which `registerTool` accepts [types] |

The v1 monolith `@modelcontextprotocol/sdk` is not installed and must not be imported (ADR-0002). TypeScript 6 does
not auto-include `@types/*`: keep `"types": ["node"]` in each tsconfig (server/client READMEs).

## 2. Handler: `createMcpHandler(factory, options)`

```ts
declare function createMcpHandler(
  factory: McpServerFactory,
  options?: CreateMcpHandlerOptions,
): McpHttpHandler;
type McpServerFactory = (
  ctx: McpRequestContext,
) => McpServer | Server | Promise<McpServer | Server>;
interface McpRequestContext {
  era: 'legacy' | 'modern';
  authInfo?: AuthInfo;
  requestInfo?: Request;
}
interface McpHttpHandler {
  fetch(req: Request, opts?: { authInfo?: AuthInfo; parsedBody?: unknown }): Promise<Response>;
  close(): Promise<void>;
  notify: ServerNotifier;
  bus: ServerEventBus;
}
```

[types]. Options we care about: `legacy: 'stateless' | 'reject'` (default `'stateless'`), `responseMode:
'auto' | 'json' | 'sse'` (default `'auto'`), `onerror`, `keepAliveMs` (SSE comment keepalive, default 15000),
`maxRequestBodySize` (default 4 MiB).

- The factory runs **once per HTTP request**; keep it cheap and side-effect free; build pools/caches at module scope
  [docs serving_http.md].
- `legacy: 'stateless'` (default) answers 2025-era clients (they open with `initialize` and send no `_meta`
  envelope) from a fresh instance per request; legacy `GET`/`DELETE` return 405. `'reject'` returns HTTP 400 /
  JSON-RPC `-32022` to every 2025 client [docs serving_legacy-clients.md]. **Never set `'reject'`**: Claude.ai,
  Claude Code and the Messages API connector may still speak 2025-era MCP (era per client UNVERIFIED; log `era`).
- `era` reaches the factory: we log it per request [run: factory saw `legacy` for a default client and `modern` for
  `versionNegotiation: { mode: 'auto' }`].

## 3. Registering tools from `ToolRuntime`

`registerTool` signature (non-deprecated overload) [types]:

```ts
registerTool<O extends StandardSchemaWithJSON, I extends StandardSchemaWithJSON | undefined = undefined>(
  name: string,
  config: { title?: string; description?: string; inputSchema?: I; outputSchema?: O;
            annotations?: ToolAnnotations; icons?: Icon[]; scopeChallenge?: ScopeChallengeHandler;
            _meta?: Record<string, unknown> },
  cb: (args: InferOutput<I>, ctx: ServerContext) => CallToolResult | Promise<CallToolResult>,
): RegisteredTool;
```

**Input validation gotcha [run].** If `inputSchema` is a real Zod schema, the SDK validates arguments _before_ our
callback and on failure returns `{ isError: true, content: [{ type: 'text', text: 'Input validation error: ...' }] }`
with no `structuredContent`. Our callback never runs, so no `usage_event` is written and the agent never sees our
`{ error: { code: 'INVALID_INPUT', hint } }` body. That breaks golden rule 4 and the error contract.

Fix: advertise the real JSON Schema but let every argument through to `ToolRuntime`, which is the single validator.
`fromJsonSchema(schema, validator)` takes a custom `jsonSchemaValidator` [types]:

```ts
import { McpServer, fromJsonSchema, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  JsonSchemaValidator,
  jsonSchemaValidator,
  ServerContext,
} from '@modelcontextprotocol/server';
import type { CallOptions, ToolRuntime } from '@mb/core';

// tools/list still shows the real schema; ToolRuntime.callTool does the validation.
const passThrough: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

// RequestMetaEnvelope is emitted as `{}` in the 2.3.0 .d.mts, so narrow by hand.
function clientNameOf(ctx: ServerContext): string | null {
  const env = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = env?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined;
  return typeof info?.name === 'string' ? info.name : null;
}

export function buildServer(
  runtime: ToolRuntime,
  opts: Omit<CallOptions, 'requestId' | 'clientName'>,
): McpServer {
  const server = new McpServer({ name: 'merchantbridge', version: '0.1.0' });
  for (const t of runtime.listTools()) {
    // already sorted by name: deterministic tools/list
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: fromJsonSchema(t.inputJsonSchema, passThrough),
        outputSchema: t.output, // Zod envelope schema (StandardSchemaWithJSON)
        annotations: t.annotations, // READ_ONLY_ANNOTATIONS: hints only
      },
      async (args, ctx): Promise<CallToolResult> => {
        const r = await runtime.callTool(t.name, args, {
          ...opts,
          requestId: crypto.randomUUID(),
          clientName: clientNameOf(ctx),
        });
        return {
          isError: r.isError,
          structuredContent: r.structuredContent as unknown as Record<string, unknown>,
          content: [{ type: 'text', text: r.text }],
        };
      },
    );
  }
  return server;
}
```

[run] (probe registered one tool this way): `tools/list` returned the real schema (`required: ['sku']`, `minLength`)
in both eras; a call with `{ sku: 42 }` reached the callback and returned our `isError` + `structuredContent` body.
[types] the snippet (with `@mb/core` types stubbed) passes `tsc` 6.0.3 strict against the installed `.d.mts`. Gotcha:
`RequestMetaEnvelope` is declared as `{}` in the published types, so `ctx.mcpReq.envelope?.[CLIENT_INFO_META_KEY]`
does not typecheck directly; use the narrowing helper.

Other verified behaviour:

- **Unknown tool** -> JSON-RPC error, not a result: client `callTool` threw `ProtocolError`, code `-32602`
  (InvalidParams), message `Tool nope not found` [run; `tools/call` handler in `mcp-*.mjs`]. Note it is -32602, not
  -32601. Our `UnknownToolError` in ToolRuntime is therefore unreachable over MCP (only registered names route).
- **Output validation**: the SDK validates `structuredContent` against `outputSchema` only when `isError` is not true;
  an object result missing `structuredContent` fails with "Output validation error" [types + source]. Error bodies
  (`ToolErrorBody`) are exempt, which is what we want.
- **Text copy**: for object-shaped `structuredContent` the SDK adds **no** text block (it only auto-appends text for
  non-object values, SEP-2106) [source `appendTextFallbackForNonObject`]. Always send `content: [{ type: 'text',
text: r.text }]` ourselves; Anthropic's `mcpTools` helper forwards `content`, not `structuredContent`
  (see anthropic-mcp.md).
- **Annotations** pass through unchanged to `tools/list` [run].
- `outputSchema` JSON in `tools/list` is produced by the SDK (`standardSchemaToJsonSchema(..., 'output')`). Generate
  `docs/mcp-tools.json` from a real `tools/list` over an in-process client, not from `ToolDescriptor`, so the file is
  byte-for-byte what hosts see.

## 4. Per-request client info (`_meta`)

- 2026-07-28 ("modern") requests carry reserved keys in `params._meta`; the SDK lifts them into
  `ctx.mcpReq.envelope` [types `BaseContext`]. Client info is at key `CLIENT_INFO_META_KEY`
  (`'io.modelcontextprotocol/clientInfo'`) -> `{ name, version }` [run: got `{ name: 'probe-client', version:
'9.9.9' }`]. Read it through `clientNameOf()` in section 3 (the envelope type is `{}` in the published `.d.mts`).
- 2025-era requests under `legacy: 'stateless'` carry **no** client info on `tools/call` (the `initialize` was a
  different request on a different instance) [run: `null`]. Fallback label: `User-Agent` from
  `ctx.http?.req?.headers` (type `ServerContext.http.req?: Request`) [types]. Telemetry only; never authz.

## 5. Mounting on Fastify (`/mcp` and `/mcp/demo`)

```ts
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';

const app = createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: config.allowedHosts });
const demoNode = toNodeHandler(createMcpHandler(demoFactory));
const liveNode = toNodeHandler(createMcpHandler(liveFactory));

app.all('/mcp/demo', async (request, reply) => {
  // per-IP limit (60/min) runs before this line
  reply.hijack(); // we write reply.raw ourselves
  await demoNode(request.raw, reply.raw, request.body);
});

app.all('/mcp', async (request, reply) => {
  const auth = await verifyApiKey(request.headers.authorization); // sha256 lookup in ApiKeyStore
  if (!auth)
    return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'invalid_api_key' });
  reply.hijack();
  await liveNode(Object.assign(request.raw, { auth }), reply.raw, request.body);
});
```

[run with `app.inject`]: allowed Host -> 200 `text/event-stream` with one `event: message`; `Host:
evil.example.net` -> **403** `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: evil.example.net"}}`;
`/mcp` without the key -> our 401; with the key -> `ctx.http.authInfo.clientId` reached the tool. Without
`reply.hijack()` the inject results were identical; we keep it because Fastify must not also try to send a reply.

What `createMcpFastifyApp` actually does [source `fastify/dist/index.mjs`]:

- `Fastify()` with **no options**: no logger, no `trustProxy`, default body limit. It accepts no Fastify options.
- With `allowedHosts`, adds an app-wide `onRequest` Host check (every route: `/health/*`, `/oauth/*`, `/api/*` too).
- Origin validation is only added if `allowedOrigins` is passed (or for a localhost bind). Requests without `Origin`
  always pass; browsers calling `/api/*` send `Origin`, so do **not** pass `allowedOrigins` app-wide; use
  `@fastify/cors` with the Vercel allow-list for `/api/*`.

Consequence for apps/api: we need Pino and `trustProxy` (per-IP limits behind Fly's proxy). Equivalent, verified-by-
source construction: `const app = Fastify({ loggerInstance, trustProxy: true }); app.addHook('onRequest',
hostHeaderValidation(allowedHosts));` (`hostHeaderValidation` is exported by `@modelcontextprotocol/fastify`).
CLAUDE.md's `createMcpFastifyApp` instruction is satisfied in spirit; record the choice in the apps/api PR.

`allowedHosts` must contain every hostname the API is reached by: the Fly app host, any custom domain, and
`localhost`/`127.0.0.1` for dev (apps/api/src/config.ts builds this list). The Host header that Fly's own health
checks send is UNVERIFIED; if machines flap, check for `Invalid Host` 403s on `/health/*` (runbook).

`toNodeHandler` forwards `req.auth` as `authInfo` and accepts the pre-parsed body as the 3rd argument [types]. Its
`onerror` option reports adapter-level 500s.

## 6. Auth placement for our two endpoints

- **`/mcp`** (live tenants): verify `Authorization: Bearer mb_live_…` in the Fastify route (SHA-256 the key, look up
  `ApiKeyStore.findActiveByHash`, reject revoked). Pass `{ token: 'redacted', clientId: tenantId, scopes: [], extra: {
keyId } }` as `auth`; never put the real key in `AuthInfo.token` (it would reach handler contexts and logs). The
  factory reads `ctx.authInfo.clientId`, resolves the tenant's connection and builds a server bound to it.
- We do **not** use the SDK's `requireBearerAuth`: it is an OAuth resource-server gate that answers `401
invalid_token` when `expiresAt` is unset [docs serving_authorization.md], and our API keys do not expire. OAuth 2.1
  on the MCP leg (RFC 9728 metadata via `mcpAuthMetadataRouter`/`oauthMetadataResponse`) is Tier 3.
- **`/mcp/demo`**: no auth. The factory is hard-wired to the demo tenant + FakeZoho; it has no code path that can load
  a live connection (golden rule 6). Governor/fault scope is `demo:{session}`: the playground and explorer pass a
  session header; external clients fall back to a per-IP-hash session (design choice, not SDK behaviour).
- Zoho tokens never enter MCP: MCP clients authenticate to us; we hold Zoho credentials server-side (ADR-0004).

## 7. Testing in-process

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const handler = createMcpHandler(factory);
const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
  fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo }),
});
const client = new Client(
  { name: 'contract-suite', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(transport);
const { tools } = await client.listTools();
const res = await client.callTool({ name: 'zoho_get_item', arguments: { sku: 'CHAI-250' } });
// res.isError, res.structuredContent (typed unknown in v2), res.content
await client.close(); // client first
await handler.close(); // then handler
```

[run] in both modes. Notes:

- `Client` defaults to `versionNegotiation: 'legacy'` (2025 handshake); `{ mode: 'auto' }` probes `server/discover`
  and uses 2026-07-28 [types]. Run the contract suite in **both** modes (`describe.each(['legacy', 'auto'])`) because
  real hosts use both.
- Tool failures resolve as `isError: true` results; protocol failures throw `ProtocolError` [types, run].
- `client.callTool` validates `structuredContent` against the listed `outputSchema` (call `listTools()` first; it
  populates the cache) [types].
- `InMemoryTransport.createLinkedPair()` pairs 2025-era instances only; `handler.fetch` is the only in-process path
  for 2026-07-28 coverage [docs testing.md].
- Route-level tests (Host check, 401, rate limits) use Fastify `app.inject` [run].
- stdio: `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`; `legacy` defaults to `'serve'` [types].
  Test it by spawning with `StdioClientTransport` from `@modelcontextprotocol/client/stdio` [docs]. stdout is the
  protocol channel: log to stderr only [docs get-started_real-host.md].

## 8. Response shape on the wire

- `responseMode: 'auto'` returns one JSON body unless a handler emits a notification first, then upgrades to SSE
  [docs]. In the Fastify probe the default answer to a 2025-era POST was `text/event-stream` with a single
  `event: message` frame [run]. Clients handle both; our tools emit no progress notifications.
- `curl` probe: `curl -s -X POST $URL -H 'Content-Type: application/json' -H 'Accept: application/json,
text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` [docs serving_fastify.md].

## 9. Not confirmed from installed code

- Which protocol era Claude Code, Claude.ai custom connectors and the Messages API MCP connector speak today
  (log `era` in production to find out).
- Fly health-check Host header vs `allowedHosts`.
- `scopeChallenge` per-tool step-up: available [types] but irrelevant until OAuth on the MCP leg (Tier 3).
- Behaviour of `-32022` corrective negotiation with older hosts beyond the SDK's own client.
