'use client';

import { API_ROUTES } from '@mb/core/http';
import { FALLBACK_DEMO_MCP_URL, LIVE_MCP_URL } from '../lib/config';
import { useStatus } from '../lib/use-status';
import { CodeBlock } from './code-block';

export function useDemoMcpUrl(): string {
  const status = useStatus();
  return status.kind === 'ready' ? status.status.demo_mcp_url : FALLBACK_DEMO_MCP_URL;
}

/**
 * The authenticated endpoint lives next to the demo one on the same API host; /api/status reports the public
 * absolute demo URL, which is more reliable than NEXT_PUBLIC_API_URL behind proxies.
 */
export function useLiveMcpUrl(): string {
  const demo = useDemoMcpUrl();
  return demo.endsWith(API_ROUTES.mcpDemo)
    ? `${demo.slice(0, -API_ROUTES.mcpDemo.length)}${API_ROUTES.mcp}`
    : LIVE_MCP_URL;
}

/** The copyable one-liner that adds the public demo server to Claude Code. */
export function McpDemoCommand() {
  const url = useDemoMcpUrl();
  return (
    <CodeBlock
      code={`claude mcp add --transport http mb-demo ${url}`}
      label="Terminal"
      copyLabel="Copy claude mcp add command"
      wrap
      testId="mcp-demo-command"
    />
  );
}
