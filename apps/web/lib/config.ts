import { API_ROUTES } from '@mb/core/http';

/** Base URL of apps/api. Inlined at build time by Next (NEXT_PUBLIC_*); never holds a secret. */
export const API_BASE_URL: string = trimSlash(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787');

/** Optional link to the source repository, shown in the footer and on /docs. */
export const REPO_URL: string | null = process.env.NEXT_PUBLIC_REPO_URL?.trim() || null;

/** Used until /api/status answers (or if it never does). */
export const FALLBACK_DEMO_MCP_URL = `${API_BASE_URL}${API_ROUTES.mcpDemo}`;

export const LIVE_MCP_URL = `${API_BASE_URL}${API_ROUTES.mcp}`;

export const DEFAULT_PLAYGROUND_MODEL = 'claude-haiku-4-5';

export const MAX_MESSAGE_CHARS = 500;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
