import { readFileSync } from 'node:fs';

/** @mb/api package version, read once from package.json (reported by /api/status and MCP serverInfo). */
export const API_VERSION: string = (() => {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
})();

export const SERVER_NAME = 'merchantbridge';
