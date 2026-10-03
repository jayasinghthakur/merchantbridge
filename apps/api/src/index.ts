/**
 * @mb/api public surface for evals, scripts and tests. The deployable entry point is src/server.ts.
 */
export { buildApp, createAppParts, playgroundEnabled, publicTools } from './app';
export type { AppParts } from './app';
export {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_PLAYGROUND_MODELS,
  LLM_PROVIDERS,
  loadConfig,
  originAllowed,
  resolveLlmSettings,
} from './config';
export type { AppConfig, Env, LlmProviderName, LlmSettings } from './config';
export { createAppContext } from './context';
export type { AppContext, AppContextOverrides, AuthPieces } from './context';
export { DEMO_ORG_NAME, createAppRuntime } from './runtime';
export { TRACE_META_KEY, createMcpEndpoint } from './mcp';
export type { McpEndpoint, McpEndpointOptions, TraceMeta } from './mcp';
export { connectInProcess } from './inprocess';
export type { FetchHandler, InProcessClientOptions, JsonRpcExchange } from './inprocess';
export { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_TOOL_CALLS, runAgent } from './playground/engine';
export type {
  AgentRunOptions,
  AgentToolCall,
  RunAgentOptions,
  RunAgentResult,
} from './playground/engine';
export { chatCompletion, runAgentOpenAI, toOpenAiTools } from './playground/openai-engine';
export type { OpenAiCompatibleLlm, RunAgentOpenAIOptions } from './playground/openai-engine';
export {
  LlmProviderError,
  isAuthRejected,
  isQuotaExhausted,
  llmRetryAfterSeconds,
  retryAfterFromBody,
  retryAfterSeconds,
  scrubSecrets,
} from './playground/llm-error';
export type { LlmErrorKind } from './playground/llm-error';
export { PROVIDER_LABELS, createAgentRunner } from './playground/provider';
export type { AgentRunner, LlmConnection, LlmRuntime } from './playground/provider';
export { SYSTEM_PROMPT } from './playground/prompt';
export { isLlmKeyRejected, llmErrorStatus, mapAgentError } from './playground/route';
export { generateMcpToolsJson } from './tools-doc';
export { API_VERSION, SERVER_NAME } from './version';
