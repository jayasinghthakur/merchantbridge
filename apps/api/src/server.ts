import { buildApp, createAppParts } from './app';
import { loadConfig } from './config';
import { createAppContext } from './context';
import { FAKE_LIVE_ENV, assertFakeLiveAllowed, fakeLiveRequested } from './dev/flag';

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  // Local "fake live" mode (MB_DEV_FAKE_ZOHO=true): refused in production before anything else runs; the fake
  // upstream module is only loaded when the flag is on.
  assertFakeLiveAllowed(process.env);
  const fakeLiveMod = fakeLiveRequested(process.env) ? await import('./dev/fake-live') : null;
  const fakeLive = fakeLiveMod ? fakeLiveMod.prepareFakeLive(process.env) : null;

  const config = loadConfig(fakeLive ? fakeLive.env : process.env);
  const ctx = await createAppContext(config, fakeLive ? { fetch: fakeLive.upstream.fetch } : {});
  const parts = createAppParts(ctx);
  const app = await buildApp(ctx, parts);

  let fakeLiveBanner: string | null = null;
  if (fakeLiveMod && fakeLive) {
    ctx.log.warn(
      { fake_live: true, ephemeral: fakeLive.filled },
      `${FAKE_LIVE_ENV}=true: local dev only; all Zoho traffic goes to an in-process fake and any other outbound host is refused. The listed variables were missing and got ephemeral dev-only values that change on every restart.`,
    );
    fakeLiveMod.registerFakeConsent(app, { ctx, setup: fakeLive });
    const seeded = await fakeLiveMod.seedFakeLiveTenant(ctx, fakeLive.upstream);
    fakeLiveBanner = fakeLiveMod.fakeLiveBanner({
      apiBase: fakeLive.apiBase,
      webBase: config.env.MB_PUBLIC_WEB_URL,
      seeded,
      defaultInvite: fakeLive.defaultInvite,
    });
  }

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
      ...(fakeLive ? { fake_live: true } : {}),
    },
    'merchantbridge api listening',
  );
  // Plain text, not a JSON log record, so the commands stay copy-pasteable. The key is for a fake tenant in an
  // in-memory store and dies with the process; nothing else secret is printed.
  if (fakeLiveMod && fakeLiveBanner) fakeLiveMod.printAfterLogs(ctx.log, fakeLiveBanner);

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
