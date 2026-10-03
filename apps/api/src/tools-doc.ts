import { createMemoryStores } from '@mb/db';
import { MemoryKv } from '@mb/core';
import { createAppParts } from './app';
import { loadConfig } from './config';
import { createAppContext } from './context';
import { createLogger } from './infra/logger';
import { connectInProcess } from './inprocess';

/**
 * docs/mcp-tools.json: a real tools/list over an in-process MCP client against the demo endpoint, so the file is
 * byte-for-byte what hosts see (outputSchema JSON is produced by the SDK). Stable: tools sorted by name, 2-space
 * JSON, trailing newline.
 */
export async function generateMcpToolsJson(): Promise<string> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  const ctx = await createAppContext(config, {
    kv: new MemoryKv(),
    stores: createMemoryStores(),
    log: createLogger('silent'),
    fetch: () => Promise.reject(new Error('gen-tools makes no outbound requests')),
  });
  const parts = createAppParts(ctx);
  try {
    const client = await connectInProcess({
      handler: parts.demo.handler,
      clientName: 'merchantbridge-gen-tools',
      clientVersion: ctx.version,
      negotiation: 'legacy',
    });
    try {
      const { tools } = await client.listTools();
      const server = client.getServerVersion();
      const doc = {
        server: { name: server?.name ?? null, version: server?.version ?? null },
        tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
      };
      return `${JSON.stringify(doc, null, 2)}\n`;
    } finally {
      await client.close();
    }
  } finally {
    await Promise.allSettled([parts.demo.close(), parts.live.close()]);
    await ctx.close();
  }
}
