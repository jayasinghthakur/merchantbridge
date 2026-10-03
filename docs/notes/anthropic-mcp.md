# Anthropic SDK + MCP: playground, evals and the Messages API connector

Sources: `docs/vendor/mcp/anthropic-mcp.ts` (byte-identical to the installed
`@anthropic-ai/sdk@0.131.0/src/helpers/beta/mcp.ts`, checked with `diff`), the installed `.d.mts` /
`.mjs` under `node_modules/.pnpm/@anthropic-ai+sdk@0.131.0_zod@4.6.5/.../sdk/`, and the `claude-api` skill (loaded
2026-10-03). Every snippet below was compiled with `tsc` 6.0.3 strict against the installed packages in a scratch
project (no API calls were made). Legend as in mcp-v2.md: **[types]**, **[source]**, **[skill]**, **UNVERIFIED**.

## 1. Imports

```ts
import Anthropic from '@anthropic-ai/sdk';
import { mcpTools } from '@anthropic-ai/sdk/helpers/beta/mcp'; // package exports './helpers/*'
import type { MCPClientLike } from '@anthropic-ai/sdk/helpers/beta/mcp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
```

`mcpTool(tool, client, extraProps?)` and `mcpTools(tools, client, extraProps?)` return `BetaRunnableTool[]` for
`client.beta.messages.toolRunner` [source]. Derive the element type instead of importing internals:
`type RunnableTool = ReturnType<typeof mcpTools>[number]`.

## 2. v2 `Client` does not satisfy `MCPClientLike` (needs a 10-line adapter)

`MCPClientLike.callTool` must return `{ content, structuredContent?: object, isError? }`. MCP v2 types
`structuredContent` as `unknown` (SEP-2106), so `mcpTools(tools, client)` fails `tsc` with "Type 'unknown' is not
assignable to type 'object | undefined'" [types, reproduced]. Adapter (compiles; also the natural place to emit the
playground `tool_result` trace event):

```ts
export function toMcpLike(mcp: Client, emit: (e: TraceEventLike) => void): MCPClientLike {
  return {
    async callTool(params) {
      const started = Date.now();
      const r = await mcp.callTool(params);
      const sc = r.structuredContent;
      emit({
        type: 'tool_result',
        tool: params.name,
        is_error: r.isError === true,
        duration_ms: Date.now() - started,
        meta: r._meta,
      });
      return {
        content: r.content,
        isError: r.isError,
        structuredContent: typeof sc === 'object' && sc !== null ? sc : undefined,
      };
    },
  };
}
```

`listTools()`'s `tools` array is assignable to `MCPToolLike[]` without changes [types].

## 3. What the helper sends to Claude [source]

- Tool definition: `{ name, description, input_schema: { ...inputSchema, type: 'object', properties ?? null,
required ?? null } }`. Our MCP `inputSchema` includes `$schema: draft 2020-12`; it is spread into `input_schema`
  as-is. Whether the Messages API ignores `$schema` is UNVERIFIED (check the first playground request; strip it in
  the adapter if it 400s).
- Success: returns `result.content` mapped to Claude blocks (our text copy of the envelope). `structuredContent` is
  used only when `content` is empty. **The model reads the text copy**, so it must be the full JSON envelope.
- `isError: true`: throws `ToolError(content)`; the runner turns it into `tool_result` with `is_error: true` and our
  JSON error body as content (`runToolCall` in `lib/tools/BetaToolRunner.mjs`). Other throws become
  `"Error: <message>"`; an unknown tool name becomes `"Error: Tool '<name>' not found"` with `is_error: true`.
- MCP result `_meta` is never forwarded to the model. Design: the **demo** factory may attach
  `_meta['dev.merchantbridge/trace'] = { decisions, usage }` so the playground can render governor decisions without a
  side channel (UNVERIFIED that the SDK passes custom result `_meta` through untouched; test it).

## 4. Playground loop (`/api/playground`, SSE)

```ts
type RunnableTool = ReturnType<typeof mcpTools>[number];

function traced(tool: RunnableTool, emit: Emit): RunnableTool {
  return {
    ...tool, // spread keeps the helper's symbol-keyed marker
    run: async (args, context) => {
      emit({ type: 'tool_call', call_id: context?.toolUse.id ?? 'unknown', tool: tool.name, args });
      return tool.run(args, context); // ToolError propagates -> is_error tool_result
    },
  };
}

const { tools } = await mcp.listTools(); // in-process client over handler.fetch (mcp-v2.md section 7)
const anthropic = new Anthropic({ maxRetries: 1, timeout: 30_000 }); // TS timeout is milliseconds
const runner = anthropic.beta.messages.toolRunner({
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  max_iterations: 6,
  tool_choice: { type: 'auto' },
  system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
  tools: mcpTools(tools, toMcpLike(mcp, emit)).map((t) => traced(t, emit)),
  messages: [{ role: 'user', content: question }],
  stream: true,
});
for await (const stream of runner) {
  stream.on('text', (delta) => emit({ type: 'assistant_text', text: delta }));
  const msg = await stream.finalMessage();
  // msg.stop_reason per turn; msg.usage.cache_read_input_tokens for the cache check
}
const final = await runner.done();
```

Facts behind it:

- `toolRunner(body)` overloads on `stream?: false | true`; with `stream: true` each iteration yields a
  `BetaMessageStream` (events `text`, `contentBlock`, `inputJson`, `thinking`, `message`, `finalMessage`, `error`,
  `end`) [types]. `runner.done()` resolves the final `BetaMessage`; `await runner` is `runUntilDone()` [types].
- `max_iterations` = max API requests in the loop; when reached the loop ends **even if the model still wants
  tools** [types]. If the final `stop_reason === 'tool_use'`, emit `done` with that reason and tell the user the answer
  is partial.
- The runner does not apply stop-reason rules: stop on `refusal` and on `max_tokens` with a pending `tool_use`
  [skill]. `pause_turn` only happens with server tools; we use none.
- `tool_choice: { type: 'auto' }` everywhere. Forced `any`/`tool` returns 400 on `claude-sonnet-5-5` (and Opus 5.5)
  [skill]; Haiku 4.5 accepts it, but one setting for all models keeps evals comparable. Steer with descriptions and the
  system prompt.
- `eager_input_streaming`: the skill's default for streamed client tools is `true`. We leave it **off**: our inputs are
  a few short ids (nothing to stream), and off keeps API-side input buffering/validation. ToolRuntime validates anyway.
- `runToolsEagerly` (start tools mid-stream) exists [types]; leave off (default false) so the trace order is
  call -> result -> text.
- Refusal / replay: catch `Anthropic.RateLimitError` and other `Anthropic.APIError`s (most specific first) and emit
  `{ type: 'error', code: 'RATE_LIMITED' | 'BUDGET_EXHAUSTED' }`, then serve the recorded transcript badged "replay".
  The exact error a workspace spend cap produces is UNVERIFIED; treat any 429 or billing-type 400 as budget exhausted.
- Thinking: do not set `thinking` for Haiku 4.5 (off by default). Sonnet 5.5 runs adaptive thinking when `thinking` is
  omitted; `{ type: 'disabled' }` returns 400 there [skill]. The runner appends full assistant content (thinking blocks
  included), so the history stays append-only.

## 5. Evals

- Same loop and same in-process MCP client (`evals/` imports `@mb/api`), non-streaming: `await
anthropic.beta.messages.toolRunner({ ...params })`. Record the tool_use names per scenario and compare with
  `Scenario.expectedTools` (order-insensitive); refusal scenarios expect zero tool calls.
- Models: `claude-haiku-4-5` and `claude-sonnet-5-5` (PLAN §2). Do not set `temperature` on Sonnet 5.5: non-default
  sampling values return 400 [skill]. Use repeated runs for variance instead of temperature 0.
- Sonnet 5.5 safety classifiers can stop with `stop_reason: 'refusal'` (`stop_details.category`). Server-side
  fallback, typed in 0.131.0 [types]: `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'` on
  `beta.messages.create` (Claude API only). Score a refusal on a non-refusal scenario as a failure either way.

## 6. Prompt caching

- Render order is `tools` -> `system` -> `messages`; a breakpoint on the last system block caches tools and system
  together [skill]. Max 4 breakpoints per request [skill].
- Do **not** pass `{ cache_control }` as `mcpTools` extraProps: it is applied to every tool (9-11 breakpoints).
  Use one system-block breakpoint (snippet above) or top-level `cache_control: { type: 'ephemeral' }` on the runner
  params (both compile [types]).
- Minimum cacheable prefix: **4096 tokens on Haiku 4.5**, 512 on Sonnet 5.5 [skill]. Our tool list plus system prompt
  may be under 4096 on Haiku, in which case nothing caches and no error is raised. Check
  `usage.cache_read_input_tokens` on the second playground question; if it is 0 on Haiku, accept it (cost is
  already low) rather than padding the prompt.
- Cache killers: non-deterministic `tools/list` order (ours is sorted), timestamps or session ids in the system prompt,
  per-request tool description changes. Keep the system prompt static; put the scenario text in `messages`.

## 7. Messages API MCP connector (the "Proof" toggle, M8)

Anthropic's servers call our public MCP endpoint; nothing runs in our process.

```ts
const proof = await anthropic.beta.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  betas: ['mcp-client-2025-11-20'],
  mcp_servers: [{ type: 'url', url: `${API_URL}/mcp/demo`, name: 'merchantbridge' }],
  tools: [{ type: 'mcp_toolset', mcp_server_name: 'merchantbridge' }],
  messages: [{ role: 'user', content: question }],
});
for (const block of proof.content) {
  if (block.type === 'mcp_tool_use') {
    /* block.server_name, block.name, block.input */
  }
  if (block.type === 'mcp_tool_result') {
    /* block.is_error, block.content */
  }
}
```

- Both halves are required: `mcp_servers` without a matching `mcp_toolset` is a validation error; every server must be
  referenced by exactly one toolset [skill].
- `BetaRequestMCPServerURLDefinition`: `{ type: 'url', url, name, authorization_token?, tool_configuration? }`
  [types]. For a live tenant: `url: ${API_URL}/mcp`, `authorization_token: 'mb_live_…'` (sent as a bearer token;
  this is the Messages API leg of ADR-0004).
- `BetaMCPToolset`: `{ type: 'mcp_toolset', mcp_server_name, default_config?: { enabled?, defer_loading? },
configs?: Record<toolName, { enabled?, defer_loading? }>, cache_control?, tools? }` [types]. `default_config:
{ enabled: false }` + `configs` = allow-list mode.
- Response blocks: `mcp_tool_use { id, name, server_name, input }`, `mcp_tool_result { tool_use_id, is_error,
content }`, and `mcp_tool_listing { mcp_server_name, tools }` [types]. `BetaMCPToolset.tools` can pin a listing
  copied from an earlier `mcp_tool_listing` block so the API does not re-list; which beta enables listing/pinning is
  UNVERIFIED. `AnthropicBeta` also contains `'mcp-client-2026-09-15'` [types]; its semantics are UNVERIFIED, so
  stay on `mcp-client-2025-11-20` (the skill's documented flag).
- Availability: Claude API, Claude Platform on AWS, Microsoft Foundry; **not** Bedrock or Vertex [skill].
- Requirements on our side: public HTTPS URL (not localhost), `allowedHosts` containing the public host, and a
  `/mcp/demo` rate-limit bucket for Anthropic's egress IPs (`MB_TRUSTED_EGRESS_CIDRS` in apps/api config) because
  all connector traffic arrives from a few addresses. The MCP protocol era the connector speaks is UNVERIFIED; it
  works with `legacy: 'stateless'` either way.
- No `tool_choice` beyond `auto` (same Sonnet/Opus 5.5 rule).

## 8. Not verified here

- Any live API behaviour (no calls were made): `$schema` acceptance in `input_schema`, spend-cap error shape,
  connector era, `mcp_tool_listing` beta gating.
- Claude Agent SDK and Claude Code host configs are covered in `docs/integration.md`; they come from those products'
  docs, not from this repo's vendored files.
