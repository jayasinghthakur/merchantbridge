import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp, createAppParts } from './app';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { createAppContext } from './context';
import { assertFakeLiveAllowed } from './dev/flag';

/**
 * Vercel Function entry (Build Output API, bundled by scripts/build-vercel.mjs). The Fastify app is built once per
 * function instance and reused across invocations (Fluid compute serves several requests per instance). Each request is
 * handed to Fastify's own HTTP handler; the invocation stays open until the response is finished and the usage-event
 * buffer is flushed, because a background timer is not guaranteed to run after the response on serverless.
 */
interface Instance {
  app: FastifyInstance;
  ctx: AppContext;
}

let instance: Promise<Instance> | null = null;

async function init(): Promise<Instance> {
  assertFakeLiveAllowed(process.env);
  const config = loadConfig(process.env);
  const ctx = await createAppContext(config);
  const app = await buildApp(ctx, createAppParts(ctx));
  await app.ready();
  ctx.log.info(
    {
      runtime: 'vercel',
      storage: ctx.storageMode,
      kv: ctx.kvMode,
      connect_enabled: config.connectEnabled,
      playground_provider: ctx.llmSettings.provider,
      playground_model: ctx.llmSettings.model,
    },
    'merchantbridge api ready',
  );
  return { app, ctx };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!instance) {
    instance = init().catch((err: unknown) => {
      instance = null; // retry the cold start on the next request instead of caching the failure
      throw err;
    });
  }
  let current: Instance;
  try {
    current = await instance;
  } catch (err) {
    // Config errors name variables only, never values.
    process.stderr.write(
      `merchantbridge api failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'UNAVAILABLE', message: 'Service is starting or misconfigured.' },
      }),
    );
    return;
  }

  const finished = new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
  });
  current.app.server.emit('request', req, res);
  await finished;
  await current.ctx.usage.flush().catch(() => undefined);
}
