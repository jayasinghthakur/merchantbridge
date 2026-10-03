import type { GovernorDecision } from './governor';
import type { ToolDescriptor } from './runtime';
import type { DemoFault } from './telemetry';

/** HTTP contract between apps/web and apps/api. Both sides import these types; change them together. */
export const API_ROUTES = {
  healthLive: '/health/live',
  healthReady: '/health/ready',
  status: '/api/status',
  tools: '/api/tools',
  scenarios: '/api/scenarios',
  explorerCall: '/api/explorer/call',
  /** POST, responds with text/event-stream of `data: <TraceEvent JSON>\n\n` frames. */
  playground: '/api/playground',
  /** Authenticated MCP endpoint (Authorization: Bearer mb_live_…). */
  mcp: '/mcp',
  /** Public MCP endpoint bound to the demo tenant + FakeZoho. */
  mcpDemo: '/mcp/demo',
  /** GET ?dc=in&invite=CODE → 302 to Zoho consent. */
  oauthStart: '/oauth/zoho/start',
  oauthCallback: '/oauth/zoho/callback',
} as const;

/**
 * After the OAuth callback the API redirects the browser to the web app:
 *   success → `${WEB}/connect/success#key=<mb_live_…>&org=<name>&dc=<dc>` (fragment: never sent to servers/logs)
 *   failure → `${WEB}/connect/error?reason=<ConnectErrorReason>`
 */
export type ConnectErrorReason =
  | 'invalid_invite'
  | 'invalid_state'
  | 'access_denied'
  | 'exchange_failed'
  | 'no_organization'
  | 'unsupported_dc'
  /** The merchant's Zoho account lives in a different data center than the one picked. */
  | 'dc_mismatch'
  | 'internal';

export interface StatusResponse {
  version: string;
  playground_enabled: boolean;
  model: string;
  /** Absolute URL of the public demo MCP endpoint. */
  demo_mcp_url: string;
  tool_count: number;
  turnstile_site_key: string | null;
  connect_enabled: boolean;
}

export type PublicToolDescriptor = Pick<
  ToolDescriptor,
  'name' | 'title' | 'description' | 'inputJsonSchema' | 'outputJsonSchema' | 'annotations' | 'scopes'
>;

export interface ToolsResponse {
  server: { name: string; version: string };
  tools: PublicToolDescriptor[];
}

export interface ExplorerCallRequest {
  tool: string;
  args: Record<string, unknown>;
  session_id: string;
  faults: DemoFault[];
}

export interface ExplorerCallResponse {
  /** The raw JSON-RPC request sent to /mcp/demo. */
  request: unknown;
  /** The raw JSON-RPC response received. */
  response: unknown;
  duration_ms: number;
  decisions: GovernorDecision[];
}

export interface ApiErrorResponse {
  error: { code: string; message: string; retry_after_s?: number };
}
