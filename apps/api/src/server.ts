import { buildApp, createAppParts } from './app';
import { loadConfig } from './config';
import { createAppContext } from './context';

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await createAppContext(config);
  const parts = createAppParts(ctx);
  const app = await buildApp(ctx, parts);

  const host = config.isProd ? '0.0.0.0' : config.env.HOST;
  await app.listen({ host, port: config.env.PORT });
  ctx.log.info(
    {
      host,
      port: config.env.PORT,
      storage: ctx.storageMode,
      kv: ctx.kvMode,
      connect_enabled: config.connectEnabled,
      playground_model: config.env.MB_PLAYGROUND_MODEL,
    },
    'merchantbridge api listening',
  );

  // Usage events are an audit trail, kept for 30 days.
  const retention = async (): Promise<void> => {
    try {
      const cutoff = new Date(ctx.clock.now() - RETENTION_DAYS * DAY_MS).toISOString();
      const deleted = await ctx.stores.usage.deleteOlderThan(cutoff);
      ctx.log.info({ deleted, cutoff }, 'usage retention run');
    } catch (err) {
      ctx.log.error(
        { err_name: err instanceof Error ? err.name : typeof err },
        'usage retention failed',
      );
    }
  };
  const retentionTimer = setInterval(() => void retention(), DAY_MS);
  retentionTimer.unref();
  const firstRun = setTimeout(() => void retention(), 60_000);
  firstRun.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log.info({ signal }, 'shutting down');
    clearInterval(retentionTimer);
    clearTimeout(firstRun);
    const force = setTimeout(() => {
      ctx.log.error({}, 'shutdown timed out; exiting');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await app.close(); // stops accepting, waits for in-flight requests, closes MCP handlers (onClose hook)
      await ctx.close(); // flushes usage events, quits redis, closes the db pool
      process.exit(0);
    } catch (err) {
      ctx.log.error({ err_name: err instanceof Error ? err.name : typeof err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // Config errors list variable names only, never values.
  process.stderr.write(
    `merchantbridge api failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
