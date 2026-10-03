import pkg from '../package.json' with { type: 'json' };

/**
 * @mb/api package version (reported by /api/status and MCP serverInfo). Imported, not read from disk, so it survives
 * bundling into a single Vercel Function file.
 */
export const API_VERSION: string = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

export const SERVER_NAME = 'merchantbridge';
