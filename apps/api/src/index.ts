/**
 * @mb/api public surface for evals, scripts and tests. The deployable entry point is src/server.ts.
 */
export { buildApp, createAppParts, playgroundEnabled, publicTools } from './app';
export type { AppParts } from './app';
export { loadConfig, originAllowed } from './config';
export type { AppConfig, Env } from './config';
export { createAppContext } from './context';
export type { AppContext, AppContextOverrides, AuthPieces } from './context';
export { DEMO_ORG_NAME, createAppRuntime } from './runtime';
export { TRACE_META_KEY, createMcpEndpoint } from './mcp';
export type { McpEndpoint, McpEndpointOptions, TraceMeta } from './mcp';
export { connectInProcess } from './inprocess';
export type { FetchHandler, InProcessClientOptions, JsonRpcExchange } from './inprocess';
export { runAgent } from './playground/engine';
export type { AgentToolCall, RunAgentOptions, RunAgentResult } from './playground/engine';
export { SYSTEM_PROMPT } from './playground/prompt';
export { mapAgentError } from './playground/route';
export { generateMcpToolsJson } from './tools-doc';
export { API_VERSION, SERVER_NAME } from './version';
